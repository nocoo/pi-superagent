import { createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension,
  DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, type AgentSession,
  type CreateAgentSessionOptions, type InlineExtension, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { prompt } from '../prompts.ts'

export type ResolvedModel = NonNullable<ReturnType<ModelRuntime['getModel']>>
export type ThinkingLevel = NonNullable<CreateAgentSessionOptions['thinkingLevel']>
export type PromptRole = 'orchestrator' | 'assess' | 'work'
export interface PiPromptRevision { revision: number; text: string }
export type ReadPiPrompt = (role: PromptRole) => PiPromptRevision
export interface SessionProfile {
  model?: string
  thinkingLevel?: ThinkingLevel
  tools?: string[]
  customTools?: ToolDefinition[]
  instructions?: string
  promptRole?: PromptRole
  extensions?: InlineExtension[]
  cwd: string
}

export class PiSessions {
  private readonly live = new Map<string, AgentSession>()
  private readonly opening = new Map<string, Promise<AgentSession>>()
  private readonly closing = new Map<string, Promise<void>>()
  private runtime?: Promise<ModelRuntime>
  private readonly agentDir = getAgentDir()
  private promptReader?: ReadPiPrompt
  private stopped = false

  constructor(private readonly sessionDir: string) { mkdirSync(sessionDir, { recursive: true, mode: 0o700 }) }
  setPromptReader(reader: ReadPiPrompt): void { this.promptReader = reader }
  private modelRuntime(): Promise<ModelRuntime> { return this.runtime ??= ModelRuntime.create() }

  async ensure(id: string, profile: SessionProfile): Promise<AgentSession> {
    if (this.stopped) throw new Error('The session manager is stopping')
    const closing = this.closing.get(id)
    if (closing) await closing
    if (this.stopped) throw new Error('The session manager is stopping')
    const opening = this.opening.get(id)
    if (opening) return opening
    const existing = this.live.get(id)
    if (existing) { await this.applyProfile(id, profile); return existing }
    const creating = this.create(id, profile)
    this.opening.set(id, creating)
    try { return await creating }
    finally { if (this.opening.get(id) === creating) this.opening.delete(id) }
  }

  private async create(id: string, profile: SessionProfile): Promise<AgentSession> {
    const modelRuntime = await this.modelRuntime()
    const model = profile.model ? resolveModel(modelRuntime, profile.model) : undefined
    const path = join(this.sessionDir, `${id}.jsonl`)
    const sessionManager = existsSync(path) ? SessionManager.open(path) : SessionManager.create(profile.cwd, this.sessionDir)
    if (!existsSync(path)) sessionManager.setSessionFile(path)
    const readPrompt = (): PiPromptRevision | undefined => profile.promptRole
      ? this.promptReader?.(profile.promptRole) ?? { revision: 0, text: prompt(profile.promptRole) } : undefined
    const coordinating = profile.promptRole === 'orchestrator' || profile.promptRole === 'assess'
    const instructions: InlineExtension = pi => {
      let nativeAppend: string | undefined
      let revision: number | undefined
      pi.on('before_agent_start', event => {
        const current = readPrompt()
        if (current && revision !== current.revision) {
          revision = current.revision
          pi.appendEntry('pi-superagent-prompt', { role: profile.promptRole, revision })
        }
        if (coordinating) return { systemPrompt: [current?.text, profile.instructions].filter(Boolean).join('\n\n') }
        nativeAppend ??= event.systemPromptOptions.appendSystemPrompt ?? ''
        event.systemPromptOptions.appendSystemPrompt = [nativeAppend, current?.text, profile.instructions].filter(Boolean).join('\n\n')
        return undefined
      })
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd: profile.cwd,
      agentDir: this.agentDir,
      extensionFactories: [instructions, ...profile.extensions ?? [],
        ...coordinating ? [] : [createCodemodeExtension(), createToolSearchExtension(), createMcpExtension()]],
      ...coordinating ? { systemPromptOverride: () => readPrompt()?.text } : {},
    })
    await resourceLoader.reload()
    const { session } = await createAgentSession({ cwd: profile.cwd, agentDir: this.agentDir, modelRuntime, resourceLoader, sessionManager,
      ...model ? { model } : {}, ...profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {},
      ...profile.tools ? { tools: profile.tools } : {}, ...profile.customTools ? { customTools: profile.customTools } : {} })
    try { await session.bindExtensions({}) }
    catch (error) { session.dispose(); throw error }
    this.live.set(id, session)
    return session
  }

  get(id: string): AgentSession | undefined { return this.live.get(id) }

  async applyProfile(id: string, profile: SessionProfile): Promise<void> {
    const session = this.live.get(id)
    if (!session?.isIdle) return
    if (profile.model) await session.setModel(resolveModel(await this.modelRuntime(), profile.model), { persist: false })
    if (profile.thinkingLevel) session.setThinkingLevel(profile.thinkingLevel, { persist: false })
  }

  dispose(id: string): Promise<void> {
    const existing = this.closing.get(id)
    if (existing) return existing
    const close = (async () => {
      await this.opening.get(id)?.catch(() => undefined)
      const session = this.live.get(id)
      if (!session) return
      this.live.delete(id)
      try { await session.abort() } finally { session.dispose() }
    })().finally(() => { if (this.closing.get(id) === close) this.closing.delete(id) })
    this.closing.set(id, close)
    return close
  }

  async disposeAll(): Promise<void> {
    this.stopped = true
    const ids = new Set([...this.live.keys(), ...this.opening.keys(), ...this.closing.keys()])
    await Promise.all([...ids].map(id => this.dispose(id)))
  }
}

export function resolveModel(runtime: ModelRuntime, route: string): ResolvedModel {
  const slash = route.indexOf('/')
  if (slash <= 0) throw new Error(`Model route ${route} must be written provider/model`)
  const model = runtime.getModel(route.slice(0, slash), route.slice(slash + 1))
  if (!model) throw new Error(`Unknown model route ${route}`)
  return model
}
