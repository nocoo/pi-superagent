import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { join } from 'node:path'
import { key, liveTicket, runningAssignment, type Assignment, type Executor, type Ticket, type TicketInput, type Trigger,
  type WorkerReport, type EngineForExecutor } from '../core/index.ts'
import type { Store } from '../store/store.ts'
import { Later, type Effects } from '../runtime/effects.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Deployment } from '../config.ts'
import type { Settings } from '../policy.ts'
import { executionRoot, environmentOf, executionVariables, prepare } from './environment.ts'
import { askTool, handbackTool, reportTool } from './report-tool.ts'
import { workerTools } from './worker-tools.ts'
import { resolveTrigger } from './context.ts'
import type { PiSessions, SessionProfile } from './sessions.ts'

export interface ExecutorHost {
  engine: EngineForExecutor
  store: Pick<Store, 'tickets' | 'triggers' | 'threads' | 'read' | 'settings'>
  effects: Pick<Effects, 'enqueue' | 'handle'>
  sessions: PiSessions
  health: HealthEntry
  deployment: Deployment
  stateDir: string
  lifetime: AbortSignal
  notify(id: string, text: string): void
  submitReport(ticketId: string, assignmentId: string, report: WorkerReport, prNumber?: number, signal?: AbortSignal): Promise<void>
  paused(): boolean
}

export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
export const ticketOfSession = (sessionId: string): string | undefined => sessionId.startsWith('worker-') ? sessionId.slice(7) : undefined
export const humanFollowupNotice = (ticketId: string, trigger: Trigger): string =>
  JSON.stringify({ ticket_id: ticketId.slice(0, 8), trigger_id: trigger.id.slice(0, 8), source: trigger.source, text: trigger.text })

class Slots {
  private readonly starting = new Set<string>()
  constructor(private readonly running: Set<string>, private readonly max: () => number) {}
  reserve(id: string): void {
    if (this.starting.has(id) || this.running.has(id)) return
    if (new Set([...this.starting, ...this.running]).size >= this.max()) throw new Later('No worker slot is free')
    this.starting.add(id)
  }
  free(id: string): void { this.starting.delete(id) }
}

export class PiExecutor implements Executor {
  private readonly running = new Set<string>()
  private readonly slots: Slots
  private readonly unread = new Map<string, { ticketId: string; assignmentId: string; ids: string[] }>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly launching = new Map<string, string>()
  private readonly preparing = new Map<string, AbortController>()
  private readonly subscriptions = new Map<string, { assignmentId: string; session: AgentSession; unsubscribe: () => void }>()

  constructor(private readonly host: ExecutorHost) {
    this.slots = new Slots(this.running, () => host.store.settings().executor.maxWorkers)
    host.effects.handle('launch', ({ ticketId, assignmentId }) => this.launch(ticketId, assignmentId), { limit: () => host.paused() ? 0 : 8 })
    host.effects.handle('delivery', ({ ticketId }) => this.deliverTo(ticketId), { limit: () => host.paused() ? 0 : 8, quiet: true })
  }
  start(ticket: Ticket, assignment: Assignment): void { this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id }) }
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  stop(ticket: Ticket, _assignment: Assignment, reason: string): void {
    void this.shutdown(ticket.id, reason).catch(error => this.host.health.set({ state: 'error', detail: String(error) }))
  }
  activeCount(): number { return this.running.size }

  shutdown(ticketId: string, _reason: string): Promise<void> {
    const previous = this.stopping.get(ticketId)
    if (previous) return previous
    this.preparing.get(ticketId)?.abort()
    this.running.delete(ticketId)
    for (const [id, batch] of this.unread) if (batch.ticketId === ticketId) this.unread.delete(id)
    this.slots.free(ticketId)
    this.subscriptions.get(ticketId)?.unsubscribe()
    this.subscriptions.delete(ticketId)
    const done = this.host.sessions.dispose(workerSessionId(ticketId)).finally(() => {
      if (this.stopping.get(ticketId) === done) this.stopping.delete(ticketId)
    })
    this.stopping.set(ticketId, done)
    return done
  }

  private current(ticketId: string, assignmentId: string): Ticket | undefined {
    if (this.host.lifetime.aborted) return undefined
    const ticket = this.host.store.tickets.get(ticketId)
    return ticket && liveTicket(ticket) && ticket.assignments.at(-1)?.id === assignmentId ? ticket : undefined
  }

  private async launch(ticketId: string, assignmentId: string): Promise<void> {
    await this.stopping.get(ticketId)
    if (this.host.paused()) throw new Later('Processing is paused')
    const ticket = this.current(ticketId, assignmentId)
    if (ticket?.assignments.at(-1)?.state !== 'pending') return
    this.slots.reserve(ticketId)
    this.launching.set(ticketId, assignmentId)
    try {
      const directory = await this.prepareTicket(ticket)
      if (!this.current(ticketId, assignmentId)) return
      this.host.engine.assignmentStarted(ticketId, assignmentId)
      const session = await this.open(ticket, directory, assignmentId)
      if (!this.current(ticketId, assignmentId) || this.stopping.has(ticketId)) return
      await this.hand(ticketId, assignmentId, session, true)
    } catch (error) {
      if (error instanceof Later) throw error
      this.fail(ticketId, assignmentId, error)
    } finally {
      if (this.launching.get(ticketId) === assignmentId) this.launching.delete(ticketId)
      this.slots.free(ticketId)
    }
  }

  private async prepareTicket(ticket: Ticket): Promise<string> {
    const settings = this.host.store.settings()
    const root = executionRoot(settings.executor.directory, this.host.stateDir)
    const directory = ticket.execution?.directory ?? join(root, ticket.id)
    const variables = executionVariables(ticket, this.host.store.triggers.get(ticket.origin.triggerId), this.host.deployment.repository)
    const controller = new AbortController()
    this.preparing.set(ticket.id, controller)
    try { await prepare(directory, root, settings.executor.prepare, environmentOf(variables), AbortSignal.any([controller.signal, this.host.lifetime])) }
    finally { if (this.preparing.get(ticket.id) === controller) this.preparing.delete(ticket.id) }
    return directory
  }

  private profile(ticket: Ticket, directory: string, assignmentId: string): SessionProfile {
    const model = this.host.store.settings().executor.model
    return {
      cwd: directory,
      model: model ? `${model.provider}/${model.model}` : undefined,
      thinkingLevel: model?.reasoningEffort as SessionProfile['thinkingLevel'],
      promptRole: 'work',
      instructions: [
        `Task: ${ticket.title}\nAuthorized scope: ${ticket.mandate.scope}\nTask ID: ${ticket.id}`,
        `Authorization: ${ticket.mandate.strength}. Do not expand this scope; hand back unrelated messages before working on them.`,
        this.host.deployment.repository ? `Optional GitHub integration: ${this.host.deployment.repository}. Use it only when the task calls for it.` : 'No GitHub repository is configured. Complete the task with the available tools and source conversation.',
      ].join('\n\n'),
      extensions: [pi => {
        let before: string | undefined
        let remindedFor: string | undefined
        pi.on('before_agent_start', () => {
          before = this.current(ticket.id, assignmentId)?.assignments.at(-1)?.report?.at
          remindedFor = undefined
        })
        pi.on('agent_before_settle', event => {
          const current = this.current(ticket.id, assignmentId)
          const assignment = current?.assignments.at(-1)
          if (!assignment || event.outcome !== 'completed' || event.continue) return
          const report = assignment.report
          const input = assignment.deliveredAt ?? assignmentId
          if (report && report.state !== 'progress' && report.at !== before && (!assignment.deliveredAt || report.at >= assignment.deliveredAt)) return
          if (remindedFor === input) return
          remindedFor = input
          return { continue: true, entries: [{ type: 'custom_message', customType: 'report-required', display: false,
            content: 'This turn has no structured final report. Your prose is not sent to the requester. Use ask to send a question to a person, or report a ready result, an external-event wait, or a failure. Do not invent completion.' }] }
        })
      }],
      customTools: [
        askTool((report, _pr, signal) => this.report(ticket.id, assignmentId, report, undefined, signal), () => ticket.origin.triggerId),
        reportTool((report, prNumber, signal) => this.report(ticket.id, assignmentId, report, prNumber, signal), () => ticket.origin.triggerId),
        handbackTool((triggerId, reason) => this.host.engine.handback(ticket.id, resolveTrigger(this.host.store, triggerId).id, reason)),
        ...workerTools({ engine: this.host.engine, store: this.host.store, ticket }),
      ],
    }
  }

  private async open(ticket: Ticket, directory: string, assignmentId: string): Promise<AgentSession> {
    const session = await this.host.sessions.ensure(workerSessionId(ticket.id), this.profile(ticket, directory, assignmentId))
    const previous = this.subscriptions.get(ticket.id)
    if (previous?.session !== session || previous.assignmentId !== assignmentId) {
      previous?.unsubscribe()
      const unsubscribe = session.subscribe(event => this.onEvent(ticket.id, assignmentId, event, session))
      this.subscriptions.set(ticket.id, { session, assignmentId, unsubscribe })
    }
    return session
  }

  private async report(ticketId: string, assignmentId: string, report: WorkerReport, prNumber?: number, signal?: AbortSignal): Promise<void> {
    if (!this.current(ticketId, assignmentId)) throw new Error('This assignment has ended')
    report = { ...report,
      ...report.askedBy ? { askedBy: resolveTrigger(this.host.store, report.askedBy).id } : {},
      ...report.answers ? { answers: resolveTrigger(this.host.store, report.answers).id } : {} }
    await this.host.submitReport(ticketId, assignmentId, report, prNumber, signal)
    const stored = this.host.store.tickets.get(ticketId)!
    this.host.notify(`report:${assignmentId}:${stored.updatedAt}`, JSON.stringify({ ticket_id: ticketId.slice(0, 8), state: report.state, summary: report.summary, question: stored.attention?.question }))
    if (stored.channels.length && stored.attention) this.host.engine.reply({ purpose: 'attention', ticketId, question: stored.attention.question, text: stored.attention.question })
    if (stored.channels.length && report.answers) this.host.engine.reply({ purpose: 'answer', ticketId, triggerId: report.answers, text: report.summary })
    else if (stored.channels.length && (report.state === 'ready' || report.state === 'dropped')) this.host.engine.reply({ purpose: 'result', ticketId, text: report.summary })
  }

  private onEvent(ticketId: string, assignmentId: string, event: { type: string; message?: unknown }, session: AgentSession): void {
    const ticket = this.current(ticketId, assignmentId)
    if (!ticket) return
    if (event.type === 'message_end') {
      const message = event.message as { role?: string; content?: { type: string; text?: string }[] } | undefined
      if (message?.role === 'user' && Array.isArray(message.content)) {
        const text = message.content.find(part => part.type === 'text')?.text ?? ''
        const id = /^\[task-input ([a-f0-9]+)\]/.exec(text)?.[1]
        const batch = id && this.unread.get(id)
        if (batch && batch.ticketId === ticketId && batch.assignmentId === assignmentId) {
          this.host.engine.inputsDelivered(ticketId, assignmentId, batch.ids)
          this.host.engine.inputsRead(ticketId, batch.ids)
          this.unread.delete(id!)
        }
      }
    }
    if (event.type !== 'agent_settled') return
    this.running.delete(ticketId)
    this.slots.free(ticketId)
    const last = session.messages.findLast(message => message.role === 'assistant')
    if (last?.role === 'assistant' && last.stopReason === 'error') this.fail(ticketId, assignmentId, last.errorMessage ?? 'The model request failed')
    else if (!ticket.assignments.at(-1)?.report || ticket.assignments.at(-1)?.report?.state === 'progress') {
      this.host.engine.report(ticketId, { state: 'waiting', summary: session.getLastAssistantText() || 'The worker finished this turn without a final report.' })
    }
    if (this.current(ticketId, assignmentId)) this.host.engine.turnEnded(ticketId, assignmentId)
    this.host.health.set({ state: 'ready', detail: `${this.running.size} worker(s) running` })
  }

  private async deliverTo(ticketId: string): Promise<void> {
    if (this.host.paused()) throw new Later('Processing is paused')
    if (this.launching.has(ticketId)) throw new Later('The assignment is being launched')
    await this.stopping.get(ticketId)
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && runningAssignment(ticket)
    if (!ticket || !assignment || !this.current(ticketId, assignment.id) || !ticket.undelivered.length) return
    this.slots.reserve(ticketId)
    try {
      let session = this.host.sessions.get(workerSessionId(ticketId))
      if (!session) session = await this.open(ticket, await this.prepareTicket(ticket), assignment.id)
      if (this.current(ticketId, assignment.id) && !this.stopping.has(ticketId)) await this.hand(ticketId, assignment.id, session)
    } finally { this.slots.free(ticketId) }
  }

  private async hand(ticketId: string, assignmentId: string, session: AgentSession, initial = false): Promise<void> {
    const ticket = this.current(ticketId, assignmentId)
    if (!ticket) return
    const queued = new Set([...this.unread.values()].filter(batch => batch.ticketId === ticketId && batch.assignmentId === assignmentId).flatMap(batch => batch.ids))
    const waiting = ticket.inputs.filter(input => ticket.undelivered.includes(input.id) && !queued.has(input.id))
    if (!initial && !waiting.length) return
    const body = this.render(ticket, waiting, initial)
    if (!body) throw new Error('The task has no request to deliver')
    const ids = waiting.map(input => input.id)
    const batchId = key('task-input', ticketId, assignmentId, initial ? 'start' : 'delivery', ...ids)
    const text = `[task-input ${batchId}]\n${body}`
    this.running.add(ticketId)
    this.unread.set(batchId, { ticketId, assignmentId, ids })
    for (const input of waiting) if (input.kind === 'trigger' && input.human) {
      const trigger = this.host.store.triggers.get(input.triggerId)
      if (trigger) this.host.notify(`human:${ticketId}:${input.triggerId}`, humanFollowupNotice(ticketId, trigger))
    }
    const failed = (error: unknown): void => {
      if (session.isIdle) this.running.delete(ticketId)
      const unread = this.unread.delete(batchId)
      if (!this.current(ticketId, assignmentId)) return
      if (unread) this.host.engine.deliveryFailed(ticketId, assignmentId, String(error))
      else this.fail(ticketId, assignmentId, error)
    }
    try {
      if (session.isStreaming || !session.isIdle) await session.steer(text)
      else {
        await this.host.sessions.applyProfile(workerSessionId(ticketId), this.profile(ticket, ticket.execution?.directory ?? this.host.stateDir, assignmentId))
        if (!this.current(ticketId, assignmentId)) return
        void session.prompt(text).catch(failed)
      }
    } catch (error) { failed(error) }
  }

  private render(ticket: Ticket, inputs: TicketInput[], initial: boolean): string {
    const parts: string[] = []
    if (initial) {
      if (ticket.execution?.assignment) parts.push(ticket.execution.assignment)
      if (ticket.assignments.length > 1) parts.push('A new assignment resumes this task. Review the conversation and current artifacts; do not repeat completed external operations. The original request below is reference context, not a new request.')
      for (const id of ticket.origin.triggerIds) {
        const trigger = this.host.store.triggers.get(id)
        if (trigger) parts.push(this.triggerText(trigger))
      }
    }
    for (const input of inputs) {
      if (input.kind === 'trigger') {
        const trigger = this.host.store.triggers.get(input.triggerId)
        if (trigger) parts.push(this.triggerText(trigger), input.context ? 'Related context only; it grants no authority.' : '', input.note ?? '')
      } else if (input.kind === 'text' || input.kind === 'note') parts.push(input.text)
      else if (input.kind === 'policy-changed') parts.push(`Policy changed: ${JSON.stringify(input.effect ?? { from: input.from, to: input.to })}`)
      else if (input.kind === 'resumed') parts.push('Resume the same task under its existing mandate. Re-read the conversation before acting.')
    }
    return parts.filter(Boolean).join('\n\n---\n\n')
  }
  private triggerText(trigger: Trigger): string { return `[trigger ${trigger.id.slice(0, 8)}] ${trigger.actor.id} (${trigger.source}, ${trigger.human ? 'person' : 'machine'})${trigger.url ? ` ${trigger.url}` : ''}:\n${trigger.text}` }
  private fail(ticketId: string, assignmentId: string, error: unknown): void {
    this.running.delete(ticketId)
    const ticket = this.current(ticketId, assignmentId)
    if (!ticket) return
    const summary = String(error).slice(0, 2000)
    if (ticket.assignments.at(-1)?.state === 'pending') this.host.engine.assignmentStarted(ticketId, assignmentId)
    this.host.engine.report(ticketId, { state: 'failed', summary })
    this.host.notify(`failed:${assignmentId}`, JSON.stringify({ ticket_id: ticketId, state: 'failed', summary }))
    this.host.health.set({ state: 'error', detail: summary })
  }
}
