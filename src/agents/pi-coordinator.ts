import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { Assessor, Candidate, EngineForMainSession, EngineForPeople } from '../core/index.ts'
import { threadKey } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import type { Prompts } from '../runtime/prompts.ts'
import type { Store } from '../store/store.ts'
import type { Deployment } from '../config.ts'
import type { Effects } from '../runtime/effects.ts'
import { Later } from '../runtime/effects.ts'
import { PiSessions, type ReadPiPrompt } from './sessions.ts'
import { COORDINATOR_TOOL_NAMES, coordinatorTools, type CoordinatorToolHost } from './coordinator-tools.ts'

export interface CoordinatorHost {
  readonly engine: EngineForMainSession & EngineForPeople
  readonly store: Store
  readonly effects: Effects
  readonly sessions: PiSessions
  readonly deployment: Deployment
  readonly stateDir: string
  readonly lifetime: AbortSignal
  paused(): boolean
  readPrompt(role: 'orchestrator' | 'assess' | 'work'): { revision: number; text: string }
  configure?(value: unknown, baseRevision: number): unknown | Promise<unknown>
  prompts?: Prompts
}

export class PiCoordinator implements Assessor {
  static readonly sessionId = 'coordinator'
  private chain: Promise<void> = Promise.resolve()
  private readonly sessions: PiSessions
  private active?: { triggerId: string; evalId: string; reminded: boolean }

  constructor(private readonly host: CoordinatorHost) {
    this.sessions = host.sessions
    this.sessions.setPromptReader(host.readPrompt as ReadPiPrompt)

    host.effects.handle('assessment', (payload, evalId) => this.serial(async () => {
      await this.assess(payload.triggerId, evalId)
    }), { limit: () => host.paused() ? 0 : 1, ordered: true, quiet: true })
    host.effects.handle('coordination', (payload, id) => this.serial(async () => {
      await this.notifyFromEffect(id, payload.text)
    }), { limit: () => host.paused() ? 0 : 1, ordered: true, quiet: true })
  }

  private serial(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(task, task)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  request(candidate: Candidate): void {
    this.host.effects.enqueue('assessment', candidate.evalId, { triggerId: candidate.triggers[0]!.id })
  }

  release(evalId: string): void {
    if (this.active?.evalId === evalId) this.active = undefined
    this.host.effects.cancel('assessment', evalId)
  }

  notify(id: string, text: string): void {
    this.host.effects.enqueue('coordination', id, { text })
  }

  private async session(settings: Settings): Promise<AgentSession> {
    const coordinatorToolHost: CoordinatorToolHost = {
      engine: this.host.engine,
      store: this.host.store,
      deployment: this.host.deployment,
      paused: this.host.paused,
      configure: this.host.configure,
      prompts: this.host.prompts,
      sessions: this.host.sessions,
    }
    return this.sessions.ensure(PiCoordinator.sessionId, {
      cwd: process.cwd(),
      model: settings.eval.model ? `${settings.eval.model.provider}/${settings.eval.model.model}` : undefined,
      thinkingLevel: settings.eval.model?.reasoningEffort as never,
      tools: ['read', 'grep', 'find', 'ls', ...COORDINATOR_TOOL_NAMES],
      customTools: coordinatorTools(coordinatorToolHost),
      promptRole: 'orchestrator',
      extensions: [pi => {
        pi.on('agent_before_settle', event => {
          const active = this.active
          if (event.outcome !== 'completed' || !active || active.reminded
            || this.host.engine.candidate(active.triggerId)?.evalId !== active.evalId) return
          active.reminded = true
          return { continue: true, entries: [{ type: 'custom_message', customType: 'decision-required', display: false,
            content: `No decision is recorded for trigger ${active.triggerId.slice(0, 8)}, eval ${active.evalId.slice(0, 8)}. Coordinator prose is not sent to the requester. Record a route for an explicit request, or an assessment for an inferred one. Delegate an explicit task even when its worker must first ask a clarifying question.` }] }
        })
      }],
    })
  }

  private async assess(triggerId: string, evalId: string): Promise<void> {
    if (this.host.lifetime.aborted) throw new Later('The host is stopping')
    if (this.host.paused()) throw new Later('Processing is paused')
    const candidate = this.host.engine.candidate(triggerId)
    if (!candidate || candidate.evalId !== evalId) return

    const settings = this.host.store.settings()
    this.host.engine.candidateDelivered(candidate.evalId)
    this.active = { triggerId, evalId, reminded: false }

    let session: AgentSession
    try {
      session = await this.session(settings)
    } catch (error) {
      if (this.host.lifetime.aborted) throw new Later('The host is stopping')
      if (this.host.engine.candidate(triggerId)?.evalId === evalId) {
        this.host.engine.decide(triggerId, { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error), evalId })
      }
      return
    }

    const timeout = setTimeout(() => { void session.abort() }, settings.eval.timeoutSeconds * 1000)
    try {
      await session.prompt(this.candidatePrompt(candidate, settings))
    } catch (error) {
      if (this.host.lifetime.aborted) throw new Later('The host is stopping')
      if (this.host.engine.candidate(triggerId)?.evalId === evalId) {
        this.host.engine.decide(triggerId, { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error), evalId })
      }
      return
    } finally {
      clearTimeout(timeout)
      if (this.active?.evalId === evalId) this.active = undefined
    }

    if (this.host.lifetime.aborted) throw new Later('The host is stopping')
    const current = this.host.engine.candidate(triggerId)
    if (!current || current.evalId !== evalId) return

    if (this.host.engine.candidate(triggerId)?.evalId === evalId) {
      this.host.engine.decide(triggerId, { kind: 'unavailable', reason: 'The assessment ended without a recorded decision', evalId })
    }
  }

  private async notifyFromEffect(_id: string, text: string): Promise<void> {
    if (this.host.lifetime.aborted) return
    if (this.host.paused()) throw new Later('Processing is paused')
    const settings = this.host.store.settings()
    const session = await this.session(settings)
    if (session.isStreaming || !session.isIdle) {
      await session.steer(text)
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Coordinator notification timed out')), settings.eval.timeoutSeconds * 1000)
    })
    try {
      await Promise.race([session.prompt(text), timeout])
    } catch (error) {
      if (this.host.lifetime.aborted) return
      await session.abort().catch(() => {})
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private candidatePrompt(candidate: Candidate, settings: Settings): string {
    const key = threadKey(candidate.thread.ref)
    const window = this.host.store.read.threadTriggers(key, 12)
    const rules = settings.policy.rules.filter(rule => rule.enabled)
      .map(rule => `### ${rule.name} (${rule.id})\n${rule.instruction}`).join('\n\n')
    const lines = window.map(trigger => `- [trigger ${trigger.id.slice(0, 8)}] ${trigger.human ? 'person' : 'machine'} ${trigger.actor.id}:\n${trigger.text.slice(0, 2000)}`).join('\n')
    const tickets = candidate.tickets.map(ticket => `- ${ticket.id.slice(0, 8)} "${ticket.title}"${ticket.ended ? ' (ended)' : ''}`).join('\n')
    return [
      '# Candidate',
      `Eval: ${candidate.evalId.slice(0, 8)}`,
      `Strength: ${candidate.strength}`,
      `Policy: ${candidate.policyVersion}`,
      `Judge triggers: ${candidate.triggers.map(trigger => trigger.id.slice(0, 8)).join(', ')}`,
      '',
      `## Thread ${key}`,
      lines,
      '',
      tickets ? `## Existing work\n${tickets}` : '',
      '',
      `## Enabled rules\n${rules || '(none)'}`,
      '',
      'Use orchestrator_eval and orchestrator_eval_read only to investigate context; do not execute the task yourself.',
      candidate.strength === 'explicit'
        ? 'This is explicit: record accept, attach, stop or ignore using orchestrator_route. No proactive rule is required.'
        : 'This is inferred: use orchestrator_eval_decide with the exact eval_id and trigger_id. Apply the assessment policy and every enabled rule.',
    ].filter(Boolean).join('\n')
  }
}
