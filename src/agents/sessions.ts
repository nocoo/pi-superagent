/**
 * Pi session management: one persistent `AgentSession` per role, keyed by a stable id, stored as a Pi session file
 * under the state directory so a ticket keeps its conversation across restarts.
 */
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, type AgentSession,
  type CreateAgentSessionOptions, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** A resolvable Pi model, without naming Pi's internal model package. */
export type ResolvedModel = NonNullable<ReturnType<ModelRuntime['getModel']>>

/** Pi's reasoning level, taken from the session factory rather than a package Pi does not re-export. */
export type ThinkingLevel = NonNullable<CreateAgentSessionOptions['thinkingLevel']>

/** What a session runs as: its model, reasoning level, tool selection and system instructions. */
export interface SessionProfile {
  /** Model route as `provider/model`; Pi's configured default applies when omitted. */
  model?: string | undefined
  thinkingLevel?: ThinkingLevel | undefined
  /** Built-in tool allowlist; omitted keeps Pi's default built-in tools. */
  tools?: string[] | undefined
  customTools?: ToolDefinition[] | undefined
  /** Instructions appended to Pi's assembled system prompt. */
  instructions?: string | undefined
  cwd: string
}

/**
 * Creates and tracks Pi sessions. A session id maps to one session file, so `ensure` on a known id resumes that
 * conversation instead of starting a new one; `dispose` closes it and leaves the file in place.
 */
export class PiSessions {
  private readonly live = new Map<string, AgentSession>()
  private runtime?: Promise<ModelRuntime>
  private readonly agentDir: string
  constructor(private readonly sessionDir: string) {
    this.agentDir = getAgentDir()
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  }

  /** Shared model runtime, so a model route resolves once and every session uses the same credentials. */
  private modelRuntime(): Promise<ModelRuntime> {
    return this.runtime ??= ModelRuntime.create()
  }

  private path(id: string): string { return join(this.sessionDir, `${id}.jsonl`) }

  /** Returns the live session with `id`, opening (or resuming) it with `profile`. */
  async ensure(id: string, profile: SessionProfile): Promise<AgentSession> {
    const existing = this.live.get(id)
    if (existing) return existing
    const modelRuntime = await this.modelRuntime()
    const model = profile.model ? resolveModel(modelRuntime, profile.model) : undefined
    const path = this.path(id)
    // Pi names a new session file after its timestamp and id; pin it so `path` is both what we write and what we resume.
    const sessionManager = existsSync(path) ? SessionManager.open(path) : SessionManager.create(profile.cwd, this.sessionDir)
    if (!existsSync(path)) sessionManager.setSessionFile(path)
    const resourceLoader = new DefaultResourceLoader({
      cwd: profile.cwd,
      agentDir: this.agentDir,
      ...profile.instructions ? { appendSystemPromptOverride: (base: string[]) => [...base, profile.instructions!] } : {},
    })
    await resourceLoader.reload()
    const { session } = await createAgentSession({
      cwd: profile.cwd,
      agentDir: this.agentDir,
      modelRuntime,
      resourceLoader,
      sessionManager,
      ...model ? { model } : {},
      ...profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {},
      ...profile.tools ? { tools: profile.tools } : {},
      ...profile.customTools ? { customTools: profile.customTools } : {},
    })
    this.live.set(id, session)
    return session
  }

  get(id: string): AgentSession | undefined { return this.live.get(id) }

  /** Stops `id`'s work and closes the session, keeping its file. */
  async dispose(id: string): Promise<void> {
    const session = this.live.get(id)
    if (!session) return
    this.live.delete(id)
    try { await session.abort() } catch { /* An already idle session needs no abort. */ }
    session.dispose()
  }

  /** Closes every session, as on shutdown. */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map(id => this.dispose(id)))
  }
}

/** Resolves `provider/model` through the runtime, naming the route when it does not exist. */
export function resolveModel(runtime: ModelRuntime, route: string): ResolvedModel {
  const slash = route.indexOf('/')
  if (slash <= 0) throw new Error(`Model route ${route} must be written provider/model`)
  const model = runtime.getModel(route.slice(0, slash), route.slice(slash + 1))
  if (!model) throw new Error(`Unknown model route ${route}`)
  return model
}
