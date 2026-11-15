# @brain/dsh-e2b

E2B microVM execution world for DSH. One brain process serves every user and
session; each user / project / session gets its own sandbox.

## What it provides

| Export | Registers as | Replaces |
|---|---|---|
| `SandboxRegistry` | `ctx.sandboxes` | — (new service) |
| `E2bFileSystem` | `ctx.fs` | `dsh-fs-sandbox` |
| `E2bSubprocess` | `ctx.subprocess` | `dsh-subprocess-local` |
| `E2bSandboxProvider` | `ctx.sandbox` | `dsh-sandbox-local` |

The bash tool, background jobs, terminal tool, language services and the PTC
runtime all reach the sandbox through `ctx.subprocess`, so none of them needs a
remote implementation.

## Layers

```
platform contract (contract.ts)     ← the only surface the rest depends on
        ↑ implements
E2B adapter (e2b-adapter.ts)        ← the only file that knows E2B exists
        ↑ used by
SandboxRegistry (registry.ts)       ← routing, binding table, creation, reclamation
        ↑ used by
fs / subprocess / sandbox providers
```

Swapping to another cloud vendor means writing a second `SandboxPlatform` +
`SandboxClient` implementation. Nothing above `contract.ts` changes.

## Routing

The registry reads the initiating Agent from DSH's asynchronous context
(`ctx.agents.currentInitiator()`), so providers never receive an identity. Three
scopes are supported by configuration:

```yaml
scope: user       # one VM per user
scope: workspace  # one VM per project
scope: session    # one VM per session
```

Switching scope changes only the key composition. Bindings created under the old
scope become unreachable. The sweeper can reclaim them, but automatic sweeping
is currently disabled, so old-scope sandboxes live until the platform TTL; call
`sweep()` manually after a scope change if they must go sooner.

## Injecting another sandbox platform

`SandboxRegistry` accepts an injected `platform?: SandboxPlatform`. The E2B and
mock adapters are unchanged; a separate package can provide its own
implementation without touching this one:

```ts
new SandboxRegistry(ctx, {
  adapter: 'box',
  scope: 'workspace',
  directory: ctx.get('sessionDirectory'),
  platform: new BoxPlatform(boxConfig),
  volumeMountPath: '/desk/{workspaceId}',
  volumeNameTemplate: 'desk-{workspaceId}',
})
```

`adapter: "box"` without an injected platform fails loudly; the registry never
falls back to E2B. Bindings, claims, lineage and the volume resolver are shared,
so the injected platform only implements the control/data plane.

## Configuration

```yaml
- id: sandboxes
  name: '@brain/dsh-e2b/sandboxes'
  config:
    scope: workspace
    adapter: e2b
    # One volume per workspace: workspaces.volume_name wins; otherwise the
    # template is rendered from the key. The sandbox mounts only that volume.
    # The mount path comes from the owner's workspaces.guest_root when the
    # platform records one (it is also the session cwd the platform sends), so
    # this value is the fallback. {workspaceId}/{userId}/{sessionId} are
    # rendered per sandbox; the result is both the mount path and the
    # workspace root reported to tools.
    volumeMountPath: /desk/{workspaceId}
    volumeNameTemplate: 'desk-{workspaceId}'
    # Temporary: one existing volume for every workspace. This disables
    # per-workspace file isolation; remove it once provisioning exists.
    # volumeName: lile-test
    e2b:
      apiKey: !!js process.env.E2B_API_KEY
      # Aliyun Agent Sandbox is E2B-compatible; omit both for the hosted service.
      apiUrl: https://api.cn-beijing.sandbox.aliyuncs.com
      domain: cn-beijing.sandbox.aliyuncs.com
      template: sj01uzxinlfazluyzqvn
      # Required for volumes; sent as metadata[fc.sandbox.auth.role].
      roleArn: acs:ram::<account-id>:role/<execution-role>
      # Background processes count against the command timeout; default is 60 s.
      commandTimeoutMs: 3600000
    directory: !!js ctx.get('sessionDirectory')   # SessionDirectory
    # The platform TTL is the only automatic reclaim right now.
    sandboxTimeoutMs: 3600000
    # Automatic sweeping is disabled; these three are inert until it returns.
    idleMs: 600000
    sweepIntervalMs: 60000
    reclaimOrphans: true
```

`SessionDirectory` is deployment-owned:

```ts
interface SessionDirectory {
  owner(sessionId: string): Promise<{
    userId: string
    workspaceId: string
    volumeName?: string   // workspaces.volume_name; falls back to the template
  } | undefined>
}
```

It is the only place that knows the user → project → session hierarchy.

## Storage

`BindingStore` ships as `MemoryBindingStore`, which is single-process only. For
multi-replica deployments implement it against PostgreSQL:

```sql
sandboxes (
  user_id, workspace_id, session_id,
  scope, sandbox_id, external_id, endpoint, workspace_root,
  generation, state, expires_at, last_used_at,
  PRIMARY KEY (user_id, workspace_id, session_id)
)
```

Unused key levels are stored as empty strings. `scope` records which granularity
created the row and is what makes switching granularity safe.

## Model-facing tools and where they run

The current profile (after the host-tool disables) exposes exactly 18 tools:

| Tool | Sandbox status | Path |
|---|---|---|
| `bash` | ✅ sandbox | `ctx.shell` → `ctx.subprocess` → E2B |
| `read` / `write` / `edit` | ✅ sandbox | `ctx.fs` → E2B |
| `job_list` / `job_output` / `job_kill` | ⚠️ partial | processes run in the sandbox; the job registry is brain-local and lost on brain restart |
| `subagent` / `subagent_fork` / `list_agents` / `send_message` / `interrupt_agent` | ✅ shared parent sandbox | the child session resolves through `header.parentSession` to the platform-owned root and reuses its key |
| `web_fetch` | ❌ brain | anonymous public HTTP with byte/char/time caps; concurrency limited by `@brain/dsh-web-limiter` |
| `create_goal` / `get_goal` / `update_goal` / `todo_write` / `exit_plan_mode` | ✅ session state | per-session `goal/change`, `todo/write`, `plan/mode` events in the session log |

The other 3 tools the base bundle exposes by default (`working_directory`,
`web_search`, `read_image`) are disabled in the profile. `read_image` never
registers because `attachment-local` is also disabled, which removes the
brain-side attachment store this phase does not isolate per user. The full
21-tool matrix — purpose, sandbox status, current state, and whether
implementation is required — is in `docs/dsh多副本多租户技术方案.md` §8.4.

`fs-search`, `skill`, and `terminal-*` are not exposed at all: the first two are
disabled (they would run on the brain), and PTY is not wired.

Only the ✅ rows are executed through this package. The preset alone does not
remove host-scope tools; the profile must disable those rows.

## Status

Verified against `dsh-v0.2.1-alpha.2`. What is complete and what is not:

| Area | State |
|---|---|
| Platform contract, error kinds, capabilities | complete |
| Registry: routing, in-flight dedupe, cross-replica creation claim (`PgBindingStore.claim`), sweeper, orphan reclaim | implemented; automatic timer disabled, `sweep()` is manual |
| Registry persistence | in-memory (`MemoryBindingStore`) and PostgreSQL (`PgBindingStore`) |
| SDK client | `e2b@^2.31.0`: create / connect / list / getInfo / kill / pause |
| Aliyun creation options | `apiUrl` / `domain` / `template` / `roleArn`; volumes resolved per workspace |
| File provider: resolve / stat / lstat / read / stream / byte-range / list / write / edit / contains | complete; `stat` uses `files.getInfo` |
| File version tokens | size + mtime fallback; no content hash |
| Process provider: spawn / collected output / pipes / stdin / kill / list / wait | complete; background commands carry the command timeout |
| Process provider: terminal (PTY) | **not implemented** — keep terminal tool disabled |
| `resolveExecutable` | complete through `stat` or `command -v` in the sandbox |
| Sandbox provider (`confine`) | pass-through by design |

Everything marked *not implemented* degrades: the corresponding tool is left out
of the preset, so the code path is never reached.

## Before production

1. Pin the `e2b` SDK version and re-check the wrapper against its types when
   upgrading; the adapter is the only module that imports it.
2. Implement the PTY path or keep the terminal tool disabled.
3. Run the acceptance script: create a session → run a command → restart the
   brain → confirm the session resumes and the sandbox is reused.
4. Provision one Volume per workspace: create it through the Aliyun OpenAPI
   (`bucket_path` selects the workspace's subdirectory of one OSS bucket) and
   record the name in `workspaces.volume_name`, or pre-create volumes matching
   `volumeNameTemplate`. Never fall back to a shared volume in production.
