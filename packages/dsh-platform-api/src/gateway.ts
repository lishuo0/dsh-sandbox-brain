/**
 * Bridges HTTP routes onto DSH's in-process services.
 *
 * Nearly everything here is a plain service call — no Typert, no descriptors.
 * That is the point: the REST contract is ours, and DSH is only asked to do the
 * work. The one exception is {@link BrainGateway.remote}: the forwarded
 * `schedule` namespace only exists as a Typert Remote, so it is invoked through
 * the gateway's in-process dispatcher with an owner Peer the platform creates.
 *
 * @module @brain/dsh-platform-api/gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import {
  type Agent,
  type AgentHandle,
  type ModelSelection,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session/types'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { JobId, JobOutputRead, JobRegistry, JobView } from '@deepseek-ai/dsh-jobs'
import type {
  BrainGateway,
  JobFollowFrame,
  JobRowsFrame,
  StreamFrame,
} from './routes.ts'
import { HttpError } from './http.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable model selection applied to the next prompt assembly. */
    'model/selection': ModelSelection
  }
}

/**
 * In-memory prompt dedupe, keyed by session.
 *
 * Best effort only: the platform owns durable idempotency. This exists so a
 * retried HTTP request does not queue the same message twice while the replica
 * stays up. Session entries are dropped when the session is disposed, and the
 * whole map is capped so a long-lived process cannot grow it without limit.
 */
const SEEN_REQUESTS = new Map<string, Set<string>>()
const MAX_SEEN_PER_SESSION = 512
const MAX_TRACKED_SESSIONS = 10_000

/**
 * Reserve one request id.
 * @param sessionId - session the request targets.
 * @param requestId - caller-supplied correlation id.
 * @returns true when this id was unused and has now been reserved.
 */
export function reserveRequest(sessionId: string, requestId: string): boolean {
  let seen = SEEN_REQUESTS.get(sessionId)
  if (seen === undefined) {
    seen = new Set()
    SEEN_REQUESTS.set(sessionId, seen)
    if (SEEN_REQUESTS.size > MAX_TRACKED_SESSIONS) {
      const oldest = SEEN_REQUESTS.keys().next().value
      if (oldest !== undefined) SEEN_REQUESTS.delete(oldest)
    }
  }
  if (seen.has(requestId)) return false
  seen.add(requestId)
  if (seen.size > MAX_SEEN_PER_SESSION) {
    const oldest = seen.values().next().value
    if (oldest !== undefined) seen.delete(oldest)
  }
  return true
}

/** Roll back a reservation whose delivery failed, so a retry can try again. */
export function releaseRequest(sessionId: string, requestId: string): void {
  SEEN_REQUESTS.get(sessionId)?.delete(requestId)
}

/** Drop one session's dedupe state when its Agent goes away. */
export function forgetSession(sessionId: string): void {
  SEEN_REQUESTS.delete(sessionId)
}

/**
 * A committed event as the API exposes it.
 *
 * `surfaceOp`/`sourceEventSeqs` are the log's surface metadata: the browser's
 * session store requires them on surface-eligible event types and rejects the
 * whole history when they go missing. `ignorable` marks plugin records older
 * readers may skip. All three stay optional because log-only events never
 * carry them (upstream forbids it).
 */
export interface ApiEvent {
  readonly seq: number
  readonly type: string
  readonly data: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: unknown
  readonly ignorable?: boolean
}

/**
 * Read one committed event as the API shape.
 *
 * Surface metadata only exists on surface-eligible variants; copy it through
 * untouched so the browser rebuilds the same ordered surface.
 */
export function apiEventOf(event: SessionEvent): ApiEvent {
  const surface = event as unknown as { surfaceOp?: unknown; sourceEventSeqs?: unknown; ignorable?: unknown }
  return {
    seq: event.seq,
    type: event.type,
    data: (event as unknown as { data?: unknown }).data ?? null,
    ...(surface.surfaceOp === undefined ? {} : { surfaceOp: surface.surfaceOp }),
    ...(surface.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: surface.sourceEventSeqs }),
    ...(surface.ignorable === true ? { ignorable: true } : {}),
  }
}

/** Default inactivity budget before an open turn is force-closed. */
const DEFAULT_TURN_STALL_MS = 600_000

/** Options the plugin hands the gateway. */
export interface GatewayOptions {
  /**
   * How long a running turn may go without any progress before it is
   * force-closed. `0` disables the watchdog.
   */
  readonly turnStallMs?: number
}

/**
 * Build the gateway over the plugin's context.
 * @param ctx - context carrying `agents` and the session event stream.
 * @param options - runtime policy; the plugin passes the deployment config.
 * @returns the gateway the routes call.
 */
export function createGateway(ctx: Context, options: GatewayOptions = {}): BrainGateway {
  /** In-flight create/resume per session, so duplicate HTTP calls share one load. */
  const opening = new Map<string, Promise<void>>()
  /** Owned handles let a stuck turn be force-disposed after cancel. */
  const handles = new Map<string, AgentHandle>()
  const CANCEL_GRACE_MS = 8_000
  const DISPOSE_GRACE_MS = 5_000

  /** The composed job registry, when the deployment includes background jobs. */
  const jobs = (): JobRegistry => {
    const registry = ctx.get('jobs') as JobRegistry | undefined
    if (registry === undefined) {
      throw new HttpError(501, 'not-supported', 'background jobs are not composed on this replica')
    }
    return registry
  }

  /**
   * Dispose one Agent without waiting for its driver to go idle.
   *
   * `handle.dispose()` awaits `whenIdle()` before it unregisters the Agent and
   * closes the persistence handle. A tool that ignored its abort never lets the
   * loop go idle, so disposal would hang exactly where it must not. Shadowing
   * `whenIdle` for the disposal window lets teardown reach the detach and close
   * steps; the abandoned driver keeps running in memory but can no longer write
   * (its lease generation is stale).
   */
  const forceDispose = async (sessionId: string): Promise<void> => {
    const handle = handles.get(sessionId)
    if (handle === undefined) return
    handles.delete(sessionId)
    const agent = handle.agent as Agent & { whenIdle?: () => Promise<void> }
    const originalWhenIdle = agent.whenIdle
    if (typeof originalWhenIdle === 'function') agent.whenIdle = async () => undefined
    try {
      await Promise.race([
        handle.dispose().catch(error => {
          ctx.logger?.warn?.(`platform-api: force dispose of "${sessionId}" failed: ${String(error)}`)
        }),
        new Promise<void>(resolve => setTimeout(resolve, DISPOSE_GRACE_MS)),
      ])
    } finally {
      // The Agent is gone either way; restoring keeps a still-live object sane.
      if (typeof originalWhenIdle === 'function') agent.whenIdle = originalWhenIdle
    }
  }

  /** Stop one Agent's loop if cancellation did not reach quiescence in time. */
  const forceCancel = async (sessionId: string, agent: Agent): Promise<void> => {
    const whenIdle = (agent as { whenIdle?: () => Promise<void> }).whenIdle
    if (whenIdle === undefined) return
    const idle = await Promise.race([
      whenIdle.call(agent).then(() => true, () => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), CANCEL_GRACE_MS)),
    ])
    if (idle) return
    ctx.logger?.warn?.(`platform-api: cancel for "${sessionId}" timed out; forcing the turn closed`)
    await forceCloseTurn(sessionId)
  }

  /**
   * Close the open turn in the session log itself and unregister the writer.
   *
   * This is the last resort behind cancel: the log gets its `tool/result`,
   * `step/end` and `turn/end`, a new lease generation fences the old Agent out,
   * and the Agent is disposed so the next message can resume normally.
   */
  const forceCloseTurn = async (sessionId: string): Promise<{ closed: boolean; events: number }> => {
    const agent = ctx.agents.get(sessionId as never)
    if (agent !== undefined) {
      try {
        agent.cancel({ kind: 'user' }, { keepInbox: true })
      } catch (error) {
        ctx.logger?.warn?.(`platform-api: force close cancel for "${sessionId}" failed: ${String(error)}`)
      }
    }
    const persistence = ctx.get('sessionPersistence') as {
      flush?(): Promise<void>
      forceCloseTurn?(id: never): Promise<{ closed: boolean; events: number }>
    } | undefined
    if (typeof persistence?.forceCloseTurn !== 'function') {
      throw new HttpError(501, 'not-supported', 'force close needs @brain/dsh-session-pg')
    }
    // Live events are written behind a short batch window. Force close decides
    // whether a turn is open by reading the durable log, so make it current
    // first — otherwise a turn that just started looks already closed.
    await Promise.race([
      Promise.resolve(persistence.flush?.()).catch(() => undefined),
      new Promise<void>(resolve => { setTimeout(resolve, FORCE_CLOSE_FLUSH_MS) }),
    ])
    let result: { closed: boolean; events: number }
    try {
      result = await persistence.forceCloseTurn(sessionId as never)
    } catch (error) {
      ctx.logger?.error?.(`platform-api: force close for "${sessionId}" failed: ${String(error)}`)
      throw new HttpError(500, 'force-close-failed', error instanceof Error ? error.message : String(error))
    }
    ctx.logger?.warn?.(
      `platform-api: force close for "${sessionId}": ${result.closed ? `${result.events} event(s) written` : 'no open turn'}`,
    )
    // Only tear the Agent down when we actually took its turn away. A no-op
    // force close (the common idempotent retry) must leave a healthy agent alone.
    if (result.closed) await forceDispose(sessionId)
    return result
  }

  /** Inactivity budget for a running turn; `0` turns the watchdog off. */
  const TURN_STALL_MS = options.turnStallMs ?? DEFAULT_TURN_STALL_MS
  /** Running turns whose watchdog is armed, plus the timer itself. */
  const stallTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Sessions whose stalled turn is already being closed, so it happens once. */
  const closingStalled = new Set<string>()

  /** Forget one turn's watchdog. */
  const clearStall = (sessionId: string): void => {
    const timer = stallTimers.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    stallTimers.delete(sessionId)
  }

  /**
   * (Re)arm the inactivity budget for one running turn.
   *
   * Every signal that shows the turn is still making progress calls this with
   * a fresh timer. When the budget expires nothing else has moved the turn,
   * so the same last-resort path a user cancel takes closes it in the log and
   * fences the live Agent out.
   */
  const armStall = (sessionId: string): void => {
    if (TURN_STALL_MS <= 0) return
    clearStall(sessionId)
    const timer = setTimeout(() => {
      stallTimers.delete(sessionId)
      if (closingStalled.has(sessionId)) return
      closingStalled.add(sessionId)
      ctx.logger?.warn?.(
        `platform-api: turn stalled for "${sessionId}" after ${TURN_STALL_MS}ms with no progress; closing it`,
      )
      void forceCloseTurn(sessionId)
        .catch(error => {
          ctx.logger?.warn?.(`platform-api: closing a stalled turn for "${sessionId}" failed: ${String(error)}`)
        })
        .finally(() => closingStalled.delete(sessionId))
    }, TURN_STALL_MS)
    // A stalled session must not keep the process alive on its own.
    timer.unref?.()
    stallTimers.set(sessionId, timer)
  }

  /** Restart the budget only for turns the watchdog already tracks. */
  const touchStall = (sessionId: string): void => {
    if (!stallTimers.has(sessionId) || closingStalled.has(sessionId)) return
    armStall(sessionId)
  }

  ctx.effect(() => {
    const disposers: Array<() => unknown> = [
      ctx.on('agent/status', payload => {
        const id = String(payload.agent.session.id)
        if (payload.status === 'running') armStall(id)
        else clearStall(id)
      }),
      // Durable activity, live model streaming and background-job progress all
      // prove the turn is alive; an idle session with a running job has no
      // armed timer, so job output never starts closing anything by itself.
      ctx.on('session/event', session => touchStall(String(session.id))),
      ctx.on('agent/assistant-stream', payload => touchStall(String(payload.agent.session.id))),
    ]
    const registry = ctx.get('jobs') as JobRegistry | undefined
    if (registry !== undefined) {
      disposers.push(registry.events.subscribe({ owners: 'all' }, event => {
        const owner = event.type === 'output' ? event.owner : event.job.owner
        if (owner !== undefined) touchStall(String(owner))
      }))
    }
    return () => {
      for (const dispose of disposers) dispose()
      for (const timer of stallTimers.values()) clearTimeout(timer)
      stallTimers.clear()
      closingStalled.clear()
    }
  }, 'platform-api: turn stall watchdog')

  /** The session log already folds model/selection; resume does not replay it. */
  const restoreSelection = (_agent: Agent): void => {}

  ctx.on('session/disposed', session => {
    const id = String(session.id)
    forgetSession(id)
    opening.delete(id)
    handles.delete(id)
    clearStall(id)
  })

  /** Read one session's live Agent. */
  const agentFor = (sessionId: string): Agent => {
    const agent = ctx.agents.get(sessionId as never)
    if (agent === undefined) {
      // Deliberately 404 rather than auto-resume: resuming a session the caller
      // does not own would let one tenant wake another's work. Creation and
      // resume happen only through `create`.
      throw new HttpError(404, 'session-not-found', `session "${sessionId}" is not active on this replica`)
    }
    return agent
  }

  /** Read one committed event as the API shape. */
  const toApiEvent = apiEventOf

  return {
    async models() {
      const llm = ctx.get('llm') as {
        listModels(provider: string): Promise<readonly unknown[]>
      } | undefined
      const defaultModel = (ctx.get('agentDefaultModel') as {
        currentSelection(): { provider: string; model: string; reasoningEffort?: unknown }
      } | undefined)?.currentSelection()
      if (llm === undefined || defaultModel === undefined) {
        throw new HttpError(501, 'not-supported', 'model catalog is not composed')
      }
      const models = await llm.listModels(defaultModel.provider)
      return {
        default: {
          provider: defaultModel.provider,
          model: defaultModel.model,
          ...(defaultModel.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: defaultModel.reasoningEffort }),
        },
        routableProviders: [defaultModel.provider],
        groups: [{
          id: defaultModel.provider,
          name: defaultModel.provider,
          models,
        }],
        failures: [],
      }
    },

    async registerModels(provider, models) {
      for (const model of models) await ensureProviderModel(ctx, provider, model)
    },

    async selectModel(sessionId, selection) {
      const agent = agentFor(sessionId)
      await ensureProviderModel(ctx, selection.provider, selection.model)
      const llm = ctx.get('llm') as {
        resolveCallConfig(config: {
          provider: string
          model: string
          reasoningEffort?: string
        }): Promise<{ provider: string; model: string; reasoningEffort?: unknown }>
      } | undefined
      if (llm === undefined) {
        throw new HttpError(501, 'not-supported', 'model selection is not composed')
      }
      let resolved: { provider: string; model: string; reasoningEffort?: unknown }
      try {
        resolved = await llm.resolveCallConfig({
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: selection.reasoningEffort }),
        })
      } catch (error) {
        throw new HttpError(
          400,
          'model-unavailable',
          error instanceof Error ? error.message : String(error),
        )
      }
      const selected = {
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: String(resolved.reasoningEffort) }),
      }
      agent.model.select({
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selected.reasoningEffort as never }),
      })
      return { selected }
    },

    async commands(sessionId) {
      const commands = ctx.get('commands') as {
        list(agent: Agent): readonly unknown[]
      } | undefined
      if (commands === undefined) throw new HttpError(501, 'not-supported', 'commands are not composed')
      return commands.list(agentFor(sessionId))
    },

    async executeCommand(sessionId, line, attachments) {
      const commands = ctx.get('commands') as {
        execute(agent: Agent, line: string, attachments: readonly never[], signal: AbortSignal): Promise<unknown>
      } | undefined
      if (commands === undefined) throw new HttpError(501, 'not-supported', 'commands are not composed')
      const agent = agentFor(sessionId)
      // A command runs outside any model turn. Handlers that end up calling the
      // model (compaction, goal rounds) resolve the session key and the model
      // catalog through `agents.currentInitiator()`, so the command must run
      // inside this Agent's initiator boundary.
      return ctx.agents.withInitiator(agent, () =>
        commands.execute(agent, line, (attachments ?? []) as readonly never[], new AbortController().signal))
    },

    async goal(sessionId) {
      const goals = ctx.get('goals') as {
        get(agent: Agent): unknown
      } | undefined
      if (goals === undefined) throw new HttpError(501, 'not-supported', 'goals are not composed')
      return goals.get(agentFor(sessionId)) ?? null
    },

    async editGoal(sessionId, request) {
      const goals = ctx.get('goals') as {
        get(agent: Agent): { id: string; revision: number } | undefined
        edit(agent: Agent, ref: { id: string; revision: number }, request: unknown): unknown
      } | undefined
      if (goals === undefined) throw new HttpError(501, 'not-supported', 'goals are not composed')
      const agent = agentFor(sessionId)
      const current = goals.get(agent)
      if (current === undefined) throw new HttpError(404, 'goal-not-found', 'this Session has no goal')
      return goals.edit(agent, current, request)
    },

    async goalAction(sessionId, action, request) {
      const goals = ctx.get('goals') as {
        get(agent: Agent): { id: string; revision: number } | undefined
        pause(agent: Agent, ref: { id: string; revision: number }): unknown
        resume(agent: Agent, ref: { id: string; revision: number }): unknown
        complete(agent: Agent, ref: { id: string; revision: number }): unknown
        clear(agent: Agent, ref: { id: string; revision: number }): unknown
      } | undefined
      if (goals === undefined) throw new HttpError(501, 'not-supported', 'goals are not composed')
      const agent = agentFor(sessionId)
      const current = goals.get(agent)
      if (current === undefined) throw new HttpError(404, 'goal-not-found', 'this Session has no goal')
      const ref = typeof request === 'object' && request !== null
        ? (request as { ref?: unknown }).ref
        : undefined
      const target = typeof ref === 'object' && ref !== null ? ref as { id: string; revision: number } : current
      return goals[action](agent, target)
    },

    async presets() {
      const registry = ctx.get('agentPresets') as {
        list(): unknown
      } | undefined
      if (registry === undefined) throw new HttpError(501, 'not-supported', 'agent presets are not composed')
      return registry.list()
    },

    async readPreset(agentPreset) {
      const registry = ctx.get('agentPresets') as {
        read(agentPreset: string): unknown
      } | undefined
      if (registry === undefined) throw new HttpError(501, 'not-supported', 'agent presets are not composed')
      return registry.read(agentPreset)
    },

    async selectPreset(sessionId, agentPreset) {
      const registry = ctx.get('agentPresets') as {
        select(agent: Agent, agentPreset: string): unknown
      } | undefined
      if (registry === undefined) throw new HttpError(501, 'not-supported', 'agent presets are not composed')
      return registry.select(agentFor(sessionId), agentPreset)
    },

    async messageFeedbackList(sessionId) {
      const service = ctx.get('messageFeedback') as {
        list(request: { sessionId: string }): Promise<unknown>
      } | undefined
      if (service === undefined) throw new HttpError(501, 'not-supported', 'message feedback is not composed')
      return service.list({ sessionId })
    },

    async messageFeedbackPut(sessionId, request) {
      const service = ctx.get('messageFeedback') as {
        put(request: { sessionId: string }): Promise<unknown>
      } | undefined
      if (service === undefined) throw new HttpError(501, 'not-supported', 'message feedback is not composed')
      return service.put({ ...(request as object), sessionId } as { sessionId: string })
    },

    async messageFeedbackDelete(sessionId, request) {
      const service = ctx.get('messageFeedback') as {
        delete(request: { sessionId: string }): Promise<unknown>
      } | undefined
      if (service === undefined) throw new HttpError(501, 'not-supported', 'message feedback is not composed')
      return service.delete({ ...(request as object), sessionId } as { sessionId: string })
    },

    async sessionFeedbackRecord(sessionId, request) {
      const service = ctx.get('sessionFeedback') as {
        record(request: { sessionId: string }): Promise<unknown>
      } | undefined
      if (service === undefined) throw new HttpError(501, 'not-supported', 'session feedback is not composed')
      return service.record({ ...(request as object), sessionId } as { sessionId: string })
    },

    async projections(sessionId) {
      const controller = ctx.get('sessionController') as {
        projections(request: { sessionId: string }, signal: AbortSignal): Promise<unknown>
      } | undefined
      if (controller === undefined) throw new HttpError(501, 'not-supported', 'projections are not composed')
      return controller.projections({ sessionId }, new AbortController().signal)
    },

    async permissionCatalog() {
      const presets = ctx.get('permissionPresets') as {
        catalog(): unknown
      } | undefined
      if (presets === undefined) throw new HttpError(501, 'not-supported', 'permission presets are not composed')
      return presets.catalog()
    },

    async remote(namespace, method, args) {
      const gateway = ctx.get('typertGateway') as {
        invoke?(request: {
          namespace: string
          method: string
          args: Record<string, unknown>
          peer: unknown
        }): Promise<unknown>
      } | undefined
      if (gateway?.invoke === undefined) {
        throw new HttpError(501, 'not-supported', 'the remote gateway is not composed')
      }
      // 调用方只有平台应用凭据；参数（例如成员会话范围）已经由平台补好。
      // owner Peer 只活这一次调用，避免在脑里留下连接级注册。
      const peer = new Peer(ctx, { principal: { kind: 'owner' } })
      try {
        return await gateway.invoke({ namespace, method, args, peer })
      } finally {
        await peer.dispose()
      }
    },

    async create(input) {
      const sessionId = input.sessionId ?? `session-${crypto.randomUUID()}`
      const existing = ctx.agents.get(sessionId as never)
      if (existing !== undefined) {
        restoreSelection(existing)
        return { sessionId }
      }

      const inFlight = opening.get(sessionId)
      if (inFlight !== undefined) {
        await inFlight
        return { sessionId }
      }

      // The browser API controller normally supplies the default model; a REST
      // caller reaches the registry directly, so read the same service here.
      const defaultModel = (ctx.get('agentDefaultModel') as {
        currentSelection(): { provider: string; model: string; reasoningEffort?: unknown }
      } | undefined)?.currentSelection()
      if (defaultModel === undefined) {
        throw new HttpError(500, 'model-not-configured', 'no default model is configured for this deployment')
      }
      const agentOptions = {
        provider: defaultModel.provider,
        model: defaultModel.model,
        ...(defaultModel.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: defaultModel.reasoningEffort as never }),
      }

      const opening$ = (async () => {
        // A persisted header means this session already exists: create would
        // throw SessionAlreadyExists. Resume it instead, which loads the log,
        // closes an interrupted turn, and claims the write lease.
        const persistence = ctx.get('sessionPersistence')
        const stored = persistence === undefined
          ? undefined
          : await persistence.stat(sessionId as never)
        if (stored !== undefined) {
          try {
            const handle = await ctx.agents.resume({
              resumeSessionId: sessionId as never,
              agentOptions,
            })
            handles.set(sessionId, handle)
          } catch (error) {
            const detail = `platform-api: resume failed for session "${sessionId}": ${errorDetail(error)}`
            ctx.logger?.error?.(detail)
            console.error(detail)
            if (error instanceof SessionAlreadyOwnedError) {
              // Another replica holds the write lease. The caller's affinity
              // target is wrong; retrying after the lease expires is safe.
              throw new HttpError(409, 'session-busy', `session "${sessionId}" is owned by another replica`)
            }
            throw error
          }
          return
        }
        // The registry owns the factory call; `createAgent` is the factory
        // method, not a registry method.
        try {
          const handle = await ctx.agents.create({
            sessionId: sessionId as never,
            meta: {
              cwd: input.cwd,
              ...(input.preset === undefined ? {} : { agentPreset: input.preset }),
            },
            agentOptions,
          })
          handles.set(sessionId, handle)
        } catch (error) {
          const detail = `platform-api: create failed for session "${sessionId}": ${errorDetail(error)}`
          ctx.logger?.error?.(detail)
          console.error(detail)
          throw error
        }
      })()
      opening.set(sessionId, opening$)
      try {
        await opening$
      } finally {
        if (opening.get(sessionId) === opening$) opening.delete(sessionId)
      }
      const agent = ctx.agents.get(sessionId as never)
      if (agent !== undefined) restoreSelection(agent)
      return { sessionId }
    },

    async prompt(sessionId, text, requestId, mode) {
      const agent = agentFor(sessionId)
      if (!reserveRequest(sessionId, requestId)) return
      // The durable message factory supplies the stable id and `role`; a
      // hand-built literal would be missing both.
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        // Echo the caller's request id so the browser can retire its optimistic
        // submission when this durable user message arrives.
        source: { kind: 'user', rpcId: requestId },
      })
      try {
        // `queue` starts or queues a turn; `steer` folds the text into the
        // turn that is already running at its next step boundary. They are
        // different Agent operations, not two spellings of one.
        if (mode === 'steer') agent.steer(message as never)
        else agent.followup(message as never)
      } catch (error) {
        releaseRequest(sessionId, requestId)
        throw new HttpError(409, 'prompt-rejected', error instanceof Error ? error.message : String(error))
      }
    },

    async fork(sessionId, request) {
      // Fork copies the committed log, which only exists in the brain; the
      // session controller owns that machinery (`buildForkSeed` + create).
      const controller = ctx.get('sessionController') as {
        fork(request: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }>
      } | undefined
      if (controller === undefined) throw new HttpError(501, 'not-supported', 'fork is not composed')
      try {
        const forked = await controller.fork({
          sessionId,
          ...(request.atSeq === undefined ? {} : { atSeq: request.atSeq }),
        })
        ctx.logger?.info?.(`platform-api: forked "${sessionId}" → "${forked.sessionId}"`)
        return { sessionId: forked.sessionId }
      } catch (error) {
        const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
        if (code === 'session/not-found') {
          throw new HttpError(404, 'session-not-found', error instanceof Error ? error.message : String(error))
        }
        const conflict: Record<string, string> = {
          'session/fork-unavailable': 'fork-unavailable',
          'session/migration-required': 'fork-migration-required',
          'gateway/bad-request': 'fork-unavailable',
        }
        if (typeof code === 'string' && conflict[code] !== undefined) {
          throw new HttpError(409, conflict[code], error instanceof Error ? error.message : String(error))
        }
        throw new HttpError(500, 'fork-failed', error instanceof Error ? error.message : String(error))
      }
    },

    async cancel(sessionId) {
      const agent = ctx.agents.get(sessionId as never)
      ctx.logger?.info?.(`platform-api: cancel.requested for "${sessionId}"`)
      // No live Agent still has work to cancel: a replica restart can leave the
      // durable log with an open turn. Reconcile it rather than answering 404,
      // so the same endpoint repairs an abnormal session.
      if (agent === undefined) {
        await forceCloseTurn(sessionId)
        return
      }
      // Keep the inbox: cancel stops the current turn, not queued input.
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      // Background jobs outlive their turn by design. A user cancel must stop
      // them too, or the session keeps working with nobody watching.
      const parallel = (ctx as { parallel?: (name: string, payload: unknown) => Promise<unknown> }).parallel
      if (typeof parallel === 'function') {
        void Promise.resolve()
          .then(() => parallel.call(ctx, 'workspace/session-stop', { sessionId }))
          .catch(error => {
            ctx.logger?.warn?.(`platform-api: stopping session activity for "${sessionId}" failed: ${String(error)}`)
          })
      }
      // A tool can ignore the abort signal. Do not leave the renderer locked
      // forever: if the Agent is still not idle, dispose the owned handle so
      // the loop's finally block closes the turn.
      void forceCancel(sessionId, agent).catch(error => {
        ctx.logger?.warn?.(`platform-api: forced cancel failed for "${sessionId}": ${String(error)}`)
      })
    },

    async head(sessionId) {
      const agent = agentFor(sessionId)
      return { cursor: Number(agent.session.seq) - 1, running: agent.status === 'running' }
    },

    async events(sessionId, after, limit) {
      const agent = agentFor(sessionId)
      const session = agent.session
      const last = Number(session.seq) - 1
      const out: ApiEvent[] = []
      for (let seq = after + 1; seq <= last && out.length < limit; seq += 1) {
        const event = session.eventAt(seq as never)
        if (event === undefined) break
        out.push(toApiEvent(event))
      }
      return out
    },

    async forceCancel(sessionId) {
      return await forceCloseTurn(sessionId)
    },

    async *listJobs(sessionId, signal): AsyncIterable<JobRowsFrame> {
      const registry = jobs()
      signal.throwIfAborted()
      const waiter = new OutputWaiter()
      const unsubscribe = registry.events.subscribe({ owners: 'all' }, event => {
        // Output appends never refresh the roster: a settled projection already
        // carries the final byte count, so the stream stays quiet while a job
        // merely writes.
        if (event.type === 'output') return
        const owner = event.job.owner
        if (owner === undefined || String(owner) === sessionId) waiter.wake()
      })
      try {
        yield { type: 'rows', jobs: registry.list(sessionId as never) }
        while (!signal.aborted) {
          await waiter.wait(signal)
          await sleep(JOB_FLUSH_MS, signal)
          if (signal.aborted) return
          yield { type: 'rows', jobs: registry.list(sessionId as never) }
        }
      } finally {
        unsubscribe()
      }
    },

    async *followJob(sessionId, jobId, from, signal): AsyncIterable<JobFollowFrame> {
      const registry = jobs()
      if (from !== undefined && (!Number.isSafeInteger(from) || from < 0)) {
        throw new HttpError(400, 'invalid-from', 'from must be a non-negative integer byte offset')
      }
      signal.throwIfAborted()
      const id = jobId as JobId
      const waiter = new OutputWaiter()
      let removed: JobView | undefined
      const unsubscribe = registry.events.subscribe({ owners: 'all' }, event => {
        if ((event.type === 'output' ? event.id : event.job.id) !== id) return
        if (event.type === 'removed') removed = event.job
        waiter.wake()
      })
      try {
        let job: JobView
        let cursor: number
        try {
          job = registry.get(id, sessionId as never)
          cursor = from ?? job.output.earliest
        } catch (error) {
          throw jobError(error, sessionId, jobId)
        }
        yield { type: 'opened', job, from: cursor }
        while (!signal.aborted) {
          if (removed !== undefined) {
            // The owner tore the job down; its terminal projection is the last
            // truthful thing this stream can say.
            yield { type: 'status', job: removed }
            return
          }
          let read: JobOutputRead
          try {
            read = registry.readAt(id, cursor, sessionId as never)
          } catch (error) {
            throw jobError(error, sessionId, jobId)
          }
          for (const frame of outputFrames(read)) yield frame
          cursor = read.next
          job = registry.get(id, sessionId as never)
          if (isTerminalStatus(job.status) && cursor >= job.output.total) {
            yield { type: 'status', job }
            return
          }
          await waiter.wait(signal)
          await sleep(JOB_FLUSH_MS, signal)
        }
      } finally {
        unsubscribe()
      }
    },

    async killJob(sessionId, jobId) {
      const registry = jobs()
      try {
        const outcome = registry.kill(jobId as JobId, sessionId as never, 'cancelled by the user')
        ctx.logger?.info?.(`platform-api: job kill ${jobId} requested for "${sessionId}": ${outcome}`)
        return { outcome }
      } catch (error) {
        throw jobError(error, sessionId, jobId)
      }
    },

    subscribe(sessionId, listener) {
      // Three sources, because a renderer needs three kinds of truth:
      //   session/event          what is durable (replayable after a reconnect)
      //   agent/assistant-stream what is being typed right now (never stored)
      //   agent/status + inbox   whether a turn is live and what is queued
      const disposers = [
        ctx.on('session/event', (session, event) => {
          if (session.id !== sessionId) return
          const api = toApiEvent(event)
          listener({
            kind: 'event',
            seq: api.seq,
            type: api.type,
            data: api.data,
            ...(api.surfaceOp === undefined ? {} : { surfaceOp: api.surfaceOp }),
            ...(api.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: api.sourceEventSeqs }),
            ...(api.ignorable === true ? { ignorable: true } : {}),
          })
        }),
        ctx.on('agent/assistant-stream', payload => {
          if (payload.agent.session.id !== sessionId) return
          listener({ kind: 'assistant', frame: payload.frame })
        }),
        ctx.on('agent/status', payload => {
          if (payload.agent.session.id !== sessionId) return
          listener({ kind: 'status', status: String(payload.status) })
        }),
        ctx.on('agent/inbox/inserted', payload => {
          if (payload.agent.session.id !== sessionId) return
          listener({ kind: 'inbox', phase: 'inserted' })
        }),
        ctx.on('agent/inbox/claimed', payload => {
          if (payload.agent.session.id !== sessionId) return
          listener({ kind: 'inbox', phase: 'claimed' })
        }),
        ctx.on('agent/inbox/discarded', payload => {
          if (payload.agent.session.id !== sessionId) return
          listener({ kind: 'inbox', phase: 'discarded' })
        }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
  }
}

/** Coalescing window for job frames, matching the upstream controller. */
const JOB_FLUSH_MS = 120

/** Upper bound for making the durable log current before a force close. */
const FORCE_CLOSE_FLUSH_MS = 2_000

/** Soft per-frame byte budget for output frames. */
const JOB_FRAME_BYTES = 64 * 1024

/** Wake-flag waiter: a wake that lands between waits is never lost. */
class OutputWaiter {
  private dirty = false
  private resolve: (() => void) | undefined

  /** Record one wake; releases a pending wait or arms the next one. */
  wake(): void {
    this.dirty = true
    this.resolve?.()
  }

  /**
   * Resolve on the next wake, immediately when one already arrived, or on abort.
   * @param signal - stream cancellation.
   */
  wait(signal: AbortSignal): Promise<void> {
    if (this.dirty || signal.aborted) {
      this.dirty = false
      return Promise.resolve()
    }
    return new Promise<void>(resolve => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        if (this.resolve === finish) this.resolve = undefined
        this.dirty = false
        resolve()
      }
      this.resolve = finish
      signal.addEventListener('abort', finish, { once: true })
    })
  }
}

/** Sleep for the coalescing window, or return at once when aborted. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>(resolve => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Whether a job has reached a terminal status. */
function isTerminalStatus(status: JobView['status']): boolean {
  return status !== 'running' && status !== 'stopping'
}

/** Split one read into frames along the soft per-frame byte budget. */
function* outputFrames(read: JobOutputRead): Iterable<JobFollowFrame> {
  let batch: JobOutputRead['chunks'][number][] = []
  let bytes = 0
  let lossy = read.lossy
  for (const chunk of read.chunks) {
    batch.push(chunk)
    bytes += Buffer.byteLength(chunk.text, 'utf8')
    if (bytes < JOB_FRAME_BYTES) continue
    const last = batch[batch.length - 1]
    yield {
      type: 'output',
      chunks: batch,
      next: last === undefined ? read.next : last.at + Buffer.byteLength(last.text, 'utf8'),
      ...(lossy ? { lossy: true as const } : {}),
    }
    lossy = false
    batch = []
    bytes = 0
  }
  if (batch.length > 0 || lossy) {
    yield { type: 'output', chunks: batch, next: read.next, ...(lossy ? { lossy: true as const } : {}) }
  }
}

/**
 * Map a registry failure onto an HTTP error.
 *
 * The registry throws for an unknown job and for a job the caller's session
 * cannot see; both must look identical, or job ids become an enumeration
 * oracle.
 */
export function jobError(error: unknown, sessionId: string, jobId: string): HttpError {
  const message = error instanceof Error ? error.message : String(error)
  // Route on the registry's stable contract first. The text pattern below only
  // covers registries that predate `JobError.code`.
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (code === 'JOB_NOT_FOUND' || code === 'JOB_FOREIGN_SESSION') {
    return new HttpError(404, 'job-not-found', `job "${jobId}" is not visible to session "${sessionId}"`)
  }
  if (code === 'JOB_OWNER_NOT_LIVE') {
    return new HttpError(409, 'job-owner-not-live', `job "${jobId}" lost its owning session`)
  }
  if (code === 'JOB_CONTROLLER_UNAVAILABLE') {
    return new HttpError(501, 'not-supported', 'no job controller serves this session')
  }
  if (/unknown|foreign|not found|not visible|cannot see/i.test(message)) {
    return new HttpError(404, 'job-not-found', `job "${jobId}" is not visible to session "${sessionId}"`)
  }
  return new HttpError(500, 'job-error', message)
}

/** Error text with a stack when available, for server-side logs only. */
function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  return String(error)
}

interface ModelEntry {
  readonly id: string
  readonly name?: string
}

interface ProviderRoute {
  readonly models?: readonly ModelEntry[]
  readonly [key: string]: unknown
}

interface PluginEntry {
  readonly options: { id?: string; config?: unknown }
  update(patch: { config: unknown }): Promise<void>
}

/**
 * The catalog only serves models named on the provider. Each user picks their
 * own model id, so a selection that is not listed yet is appended before the
 * call is resolved.
 */
export async function ensureProviderModel(ctx: Context, provider: string, model: string): Promise<void> {
  const root = ctx.root as Context & {
    loader?: { entries(): Iterable<PluginEntry> }
  }
  const loader = root.loader
  if (loader === undefined || model.trim() === '') return
  for (const entry of loader.entries()) {
    if (entry.options.id !== 'llm-pi-ai') continue
    const config = entry.options.config
    if (config === null || typeof config !== 'object') return
    const providers = (config as { providers?: Record<string, ProviderRoute> }).providers
    const route = providers?.[provider]
    if (route === undefined) return
    const models = route.models ?? []
    if (models.some(item => item.id === model)) return
    await entry.update({
      config: {
        ...(config as Record<string, unknown>),
        providers: {
          ...providers,
          [provider]: {
            ...route,
            models: [...models, {
              id: model,
              name: model,
              contextWindow: 128000,
              maxTokens: 8192,
              input: ['text', 'image'],
            }],
          },
        },
      },
    })
    return
  }
}
