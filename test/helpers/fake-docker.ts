/**
 * In-memory Docker CLI for unit tests.
 *
 * It keeps a container table and maps `exec` calls onto temporary host
 * directories that stand in for bind mounts, so the adapter's command shapes
 * and path rules are exercised without a daemon.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, posix, relative, resolve } from 'node:path'
import type {
  DockerCli,
  DockerCliResult,
  DockerCliRunOptions,
  DockerCliSpawnOptions,
} from '../../packages/dsh-e2b/src/docker-adapter.ts'

interface FakeMount {
  source: string
  target: string
  readOnly: boolean
}

interface FakeContainer {
  name: string
  mounts: FakeMount[]
  labels: Record<string, string>
  status: 'running' | 'paused' | 'exited'
  createdAt: string
}

/**
 * One test double for the docker binary.
 */
export class FakeDockerCli implements DockerCli {
  readonly calls: string[][] = []
  readonly containers = new Map<string, FakeContainer>()
  readonly images = new Set<string>()
  readonly children = new Map<number, ChildProcess>()
  readonly pidFiles = new Map<string, number>()

  pulled = 0
  /** Optional canned failure for the next `run` call. */
  runFailure?: { code: number; stderr: string }
  /** Optional thrown error for the next `run` call (simulates a dead daemon). */
  runError?: unknown
  /** Optional canned failure for the next `exec` call. */
  execFailure?: { code: number; stderr: string }

  private nextPid = 1000
  private nextName = 0

  async run(args: readonly string[], options: DockerCliRunOptions = {}): Promise<DockerCliResult> {
    this.calls.push([...args])
    if (this.runError !== undefined) {
      const error = this.runError
      this.runError = undefined
      throw error
    }
    if (this.runFailure !== undefined) {
      const failure = this.runFailure
      this.runFailure = undefined
      return result(failure.code, '', failure.stderr)
    }
    const [command = '', ...rest] = args
    switch (command) {
      case 'run':
        return this.runContainer(rest)
      case 'image':
        return this.image(rest)
      case 'pull':
        this.pulled += 1
        this.images.add(rest[0] ?? '')
        return result(0, 'pulled\n')
      case 'inspect':
        return this.inspect(rest[0] ?? '')
      case 'ps':
        return result(0, `${[...this.containers.keys()].join('\n')}\n`)
      case 'rm':
        return this.remove(rest.at(-1) ?? '')
      case 'pause':
        return this.setState(rest[0] ?? '', 'paused')
      case 'unpause':
        return this.setState(rest[0] ?? '', 'running')
      case 'exec':
        return await this.exec(rest, options)
      default:
        return result(127, '', `fake docker: unknown command ${command}`)
    }
  }

  spawn(args: readonly string[], options: DockerCliSpawnOptions): ChildProcess {
    this.calls.push([...args])
    const { container, cwd, argv, pidFile } = parseExecSpawn(args[0] === 'exec' ? args.slice(1) : args)
    const pid = this.nextPid++
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: this.hostPath(container, cwd),
      stdio: [options.stdin, 'pipe', 'pipe'],
    })
    this.children.set(pid, child)
    this.pidFiles.set(pidFile, pid)
    child.on('close', () => {
      this.children.delete(pid)
    })
    return child
  }

  /** Guest path → temporary host directory, enforcing the fake mounts. */
  hostPath(containerName: string, guestPath: string): string {
    const container = this.containers.get(containerName)
    if (container === undefined) throw new Error(`fake docker: no container ${containerName}`)
    const guest = posix.normalize(guestPath)
    for (const mount of container.mounts) {
      if (guest === mount.target || guest.startsWith(`${mount.target}/`)) {
        const rest = guest.slice(mount.target.length).replace(/^\//u, '')
        return resolve(mount.source, rest)
      }
    }
    throw new Error(`fake docker: path ${guest} is not mounted`)
  }

  /** Mount source recorded for a guest directory. */
  mountSource(containerName: string, target: string): string {
    const mount = this.containers.get(containerName)?.mounts.find(entry => entry.target === target)
    if (mount === undefined) throw new Error(`fake docker: no mount ${target}`)
    return mount.source
  }

  private async runContainer(args: readonly string[]): Promise<DockerCliResult> {
    const parsed = parseRunArgs(args)
    const name = parsed.flags.get('--name') ?? `fake-${++this.nextName}`
    const mounts: FakeMount[] = []
    for (const spec of parsed.mounts) {
      const fields = new Map(spec.split(',').map(part => {
        const index = part.indexOf('=')
        return index === -1 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)]
      }))
      mounts.push({
        source: fields.get('source') ?? '',
        target: posix.normalize(fields.get('target') ?? '/'),
        readOnly: fields.has('readonly'),
      })
    }
    const labels: Record<string, string> = {}
    for (const label of parsed.labels) {
      const index = label.indexOf('=')
      if (index === -1) labels[label] = ''
      else labels[label.slice(0, index)] = label.slice(index + 1)
    }
    this.containers.set(name, {
      name,
      mounts,
      labels,
      status: 'running',
      createdAt: new Date().toISOString(),
    })
    return result(0, `${name}\n`)
  }

  private image(args: readonly string[]): DockerCliResult {
    const image = args[1] ?? ''
    return this.images.has(image)
      ? result(0, '[]\n')
      : result(1, '', `Error: No such image: ${image}`)
  }

  private inspect(name: string): DockerCliResult {
    const container = this.containers.get(name)
    if (container === undefined) return result(1, '', `Error: No such container: ${name}`)
    const json = [{
      State: { Status: container.status },
      Created: container.createdAt,
      Mounts: container.mounts.map(mount => ({
        Type: 'bind',
        Source: mount.source,
        Destination: mount.target,
        RW: !mount.readOnly,
      })),
      Config: { Labels: container.labels },
    }]
    return result(0, `${JSON.stringify(json)}\n`)
  }

  private remove(name: string): DockerCliResult {
    if (!this.containers.delete(name)) return result(1, '', `Error: No such container: ${name}`)
    return result(0, `${name}\n`)
  }

  private setState(name: string, status: FakeContainer['status']): DockerCliResult {
    const container = this.containers.get(name)
    if (container === undefined) return result(1, '', `Error: No such container: ${name}`)
    container.status = status
    return result(0, `${name}\n`)
  }

  private async exec(args: readonly string[], options: DockerCliRunOptions): Promise<DockerCliResult> {
    if (this.execFailure !== undefined) {
      const failure = this.execFailure
      this.execFailure = undefined
      return result(failure.code, '', failure.stderr)
    }
    let index = 0
    while (args[index]?.startsWith('-') === true) {
      if (args[index] === '-i') index += 1
      else index += 2
    }
    const container = args[index] ?? ''
    const argv = args.slice(index + 1)
    if (!this.containers.has(container)) {
      return result(1, '', `Error: No such container: ${container}`)
    }
    const [command = '', ...rest] = argv
    if (command === 'env') {
      let next = 0
      while (rest[next]?.includes('=') === true) next += 1
      return await this.exec([container, ...rest.slice(next)], options)
    }
    if (command === 'cat') {
      const guest = rest.at(-1) ?? ''
      const pid = this.pidFiles.get(guest)
      if (pid !== undefined) return result(0, `${pid}\n`)
      try {
        return result(0, await readFile(this.hostPath(container, guest)))
      } catch {
        return result(1, '', `cat: ${guest}: No such file or directory`)
      }
    }
    if (command === 'find') {
      return this.find(container, rest)
    }
    if (command === 'stat') {
      return await this.statPath(container, rest.at(-1) ?? '')
    }
    if (command === 'rm') {
      await rm(this.hostPath(container, rest.at(-1) ?? ''), { recursive: true, force: true })
      return result(0)
    }
    if (command === 'mkdir') {
      await mkdir(this.hostPath(container, rest.at(-1) ?? ''), { recursive: true })
      return result(0)
    }
    if (command === 'sh') {
      return await this.shell(container, rest, options)
    }
    return result(127, '', `fake docker: unsupported exec ${command}`)
  }

  /** Interpret the fixed `sh -c` scripts the adapter emits. */
  private async shell(container: string, args: readonly string[], options: DockerCliRunOptions): Promise<DockerCliResult> {
    const script = args[1] ?? ''
    const values = args.slice(3)
    if (script.startsWith('kill -s "$1" "$2"')) {
      const signal = values[0] ?? 'TERM'
      const pid = Number(values[1])
      this.children.get(pid)?.kill(`SIG${signal}` as NodeJS.Signals)
      return result(0)
    }
    if (script.startsWith('mkdir -p -- "$(dirname -- "$1")" && cat > "$1"')) {
      const target = this.hostPath(container, values[0] ?? '')
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, Buffer.from(options.input ?? new Uint8Array()))
      return result(0)
    }
    if (script.startsWith('mkdir -p -- "$(dirname -- "$2")" && mv --')) {
      const from = this.hostPath(container, values[0] ?? '')
      const to = this.hostPath(container, values[1] ?? '')
      await mkdir(dirname(to), { recursive: true })
      await (await import('node:fs/promises')).rename(from, to)
      return result(0)
    }
    return result(127, '', `fake docker: unsupported shell script ${script}`)
  }

  private async find(container: string, args: readonly string[]): Promise<DockerCliResult> {
    const guest = args[0] ?? ''
    try {
      const host = this.hostPath(container, guest)
      const entries = await readdir(host, { withFileTypes: true })
      const parts: string[] = []
      for (const entry of entries) {
        const info = await stat(join(host, entry.name))
        const kind = entry.isFile() ? 'f' : entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'o'
        parts.push(`${kind}\0${entry.name}\0${info.size}\0`)
      }
      return result(0, parts.join(''))
    } catch {
      return result(1, '', `find: '${guest}': No such file or directory`)
    }
  }

  private async statPath(container: string, guest: string): Promise<DockerCliResult> {
    try {
      const info = await stat(this.hostPath(container, guest))
      const kind = info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symbolic link' : 'regular file'
      return result(0, `${kind}\n${info.size}\n${Math.floor(info.mtimeMs / 1000)}\n`)
    } catch {
      return result(1, '', `stat: cannot statx '${guest}': No such file or directory`)
    }
  }
}

function result(code: number, stdout: string | Buffer = '', stderr = ''): DockerCliResult {
  return { code, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr }
}

interface RunArgs {
  flags: Map<string, string>
  labels: string[]
  mounts: string[]
  image?: string
}

/** Minimal parser for the adapter's own `docker run` shape. */
export function parseRunArgs(args: readonly string[]): RunArgs {
  const valueFlags = new Set([
    '--name', '--user', '--cap-drop', '--security-opt', '--pids-limit', '--memory',
    '--cpus', '--network', '--workdir', '--env', '--tmpfs', '--label', '--mount', '--entrypoint',
  ])
  const flags = new Map<string, string>()
  const labels: string[] = []
  const mounts: string[] = []
  let image: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (valueFlags.has(arg)) {
      const value = args[index + 1] ?? ''
      if (arg === '--label') labels.push(value)
      else if (arg === '--mount') mounts.push(value)
      else flags.set(arg, value)
      index += 1
      continue
    }
    if (arg.startsWith('-')) continue
    image = arg
    break
  }
  return { flags, labels, mounts, ...(image === undefined ? {} : { image }) }
}

interface ExecSpawn {
  container: string
  cwd: string
  argv: readonly string[]
  pidFile: string
}

/** Parse the adapter's `docker exec` process wrapper without a real shell. */
export function parseExecSpawn(args: readonly string[]): ExecSpawn {
  let index = 0
  let cwd = '/desk'
  while (args[index]?.startsWith('-') === true) {
    const flag = args[index]
    if (flag === '-i') {
      index += 1
    } else if (flag === '--workdir') {
      cwd = args[index + 1] ?? cwd
      index += 2
    } else if (flag === '--env') {
      index += 2
    } else {
      throw new Error(`fake docker: unsupported exec flag ${flag}`)
    }
  }
  const container = args[index] ?? ''
  const tail = args.slice(index + 1)
  if (tail[0] !== 'sh' || tail[1] !== '-c') throw new Error('fake docker: expected sh -c wrapper')
  const pidFile = tail[4] ?? ''
  return { container, cwd, argv: tail.slice(5), pidFile }
}

/** Whether a file exists under a mount source, for assertions. */
export function existsUnder(root: string, child: string): boolean {
  return existsSync(join(root, relative(root, resolve(root, child))))
}
