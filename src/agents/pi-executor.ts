/**
 * The Executor port on Pi: one persistent Pi session and one directory per ticket.
 *
 * The domain hands this class a Ticket and an Assignment and expects facts back through the Engine's callbacks. It is
 * the only place that knows a ticket is executed by a Pi `AgentSession`, which is why a ticket surviving a session is
 * a property of this adapter and not of the domain.
 */
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { join } from 'node:path'
import { liveTicket, runningAssignment, type Assignment, type Executor, type Ticket, type TicketInput, type Trigger,
  type WorkerReport } from '../core/index.ts'
import type { EngineForExecutor } from '../core/index.ts'
import type { Store } from '../store/store.ts'
import type { Effects } from '../runtime/effects.ts'
import { Later } from '../runtime/effects.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Deployment } from '../config.ts'
import type { Settings } from '../policy.ts'
import { executionRoot, environmentOf, executionVariables, prepare } from './environment.ts'
import { handbackTool, reportTool } from './report-tool.ts'
import type { PiSessions } from './sessions.ts'
import { prompt } from '../prompts.ts'

/** Host dependencies used by `PiExecutor`. */
export interface ExecutorHost {
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed'
    | 'report' | 'assignmentInterrupted' | 'reply' | 'handback'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'settings'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  readonly sessions: PiSessions
  readonly health: HealthEntry
  readonly deployment: Deployment
  readonly stateDir: string
  readonly lifetime: AbortSignal
  /** Whether processing is paused, which holds launches and input deliveries. */
  paused(): boolean
}

/** Session id of a ticket's worker; the ticket id is recoverable from it, so one ticket never runs two conversations. */
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
/** Returns the ticket id of a worker session id. */
export const ticketOfSession = (sessionId: string): string | undefined =>
  sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined

/**
 * Tracks slots against the configured concurrency limit: a ticket holds one from the start of its launch and throughout
 * a running turn. A person's message needs no slot of its own — it steers the session that already holds one — so a
 * correction never waits behind new work.
 */
class Slots {
  private readonly starting = new Set<string>()
  constructor(private readonly running: () => string[], private readonly max: () => number) {}
  used(): number { return new Set([...this.running(), ...this.starting]).size }
  reserve(ticketId: string): void {
    if (this.starting.has(ticketId)) return
    if (this.used() >= this.max()) throw new Later('No worker slot is free')
    this.starting.add(ticketId)
  }
  free(ticketId: string): void { this.starting.delete(ticketId) }
}

export class PiExecutor implements Executor {
  private readonly slots: Slots
  /** Inputs queued to a session that its model has not read yet, by ticket. */
  private readonly unread = new Map<string, string[]>()
  /** Assignments whose session this host believes is running work. */
  private readonly running = new Set<string>()

  constructor(private readonly host: ExecutorHost) {
    this.slots = new Slots(() => [...this.running], () => host.store.settings().executor.maxWorkers)
    host.effects.handle('launch', ({ ticketId, assignmentId }) => this.launch(ticketId, assignmentId), { limit: () => host.paused() ? 0 : 8 })
    host.effects.handle('delivery', ({ ticketId }) => this.deliverTo(ticketId), { limit: () => host.paused() ? 0 : 8, ordered: true, quiet: true })
  }

  /** Queues a pending Assignment for launch; the launch reports back through the Engine. */
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }

  /** Queues delivery of the ticket's waiting Inputs to the Assignment that runs it. */
  deliver(ticket: Ticket, _assignment: Assignment): void {
    this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id })
  }

  /** Ends an Assignment's work after the domain already ended it. */
  stop(ticket: Ticket, _assignment: Assignment, reason: string): void {
    void this.shutdown(ticket.id, reason)
  }

  /** Live assignment count, for health reporting. */
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => runningAssignment(ticket) !== undefined).length }

  /** Stops every worker's turn and closes its session, as on shutdown. */
  async shutdown(ticketId: string, _reason: string): Promise<void> {
    this.running.delete(ticketId)
    this.unread.delete(ticketId)
    this.slots.free(ticketId)
    await this.host.sessions.dispose(workerSessionId(ticketId))
  }

  private async launch(ticketId: string, assignmentId: string): Promise<void> {
    if (this.host.paused()) throw new Later('Processing is paused')
    this.slots.reserve(ticketId)
    let started = false
    try {
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket)) return
      const assignment = ticket.assignments.find(item => item.id === assignmentId)
      if (assignment?.state !== 'pending') return
      const settings = this.host.store.settings()
      const directory = await this.prepareTicket(ticket, settings)
      this.host.engine.assignmentStarted(ticketId, assignmentId)
      started = true
      const session = await this.open(ticket, directory, settings, assignmentId)
      this.running.add(ticketId)
      this.host.health.set({ state: 'ready', detail: `${this.running.size} worker(s) running`, at: new Date().toISOString() })
      await this.hand(ticketId, assignmentId, session, ticket)
    } catch (error) {
      this.running.delete(ticketId)
      if (error instanceof Later) throw error
      this.fail(ticketId, assignmentId, error, started)
    } finally {
      this.slots.free(ticketId)
    }
  }

  /** Creates the ticket directory from the prepare command, so a worker starts from a checkout of its own. */
  private async prepareTicket(ticket: Ticket, settings: Settings): Promise<string> {
    const root = executionRoot(settings.executor.directory, this.host.stateDir)
    const directory = ticket.execution?.directory ?? join(root, ticket.id)
    const trigger = this.host.store.triggers.get(ticket.origin.triggerId)
    const variables = executionVariables(ticket, trigger ?? undefined, this.host.deployment.repository)
    await prepare(directory, root, settings.executor.prepare, environmentOf(variables))
    return directory
  }

  /** Opens (or resumes) the ticket's worker session and subscribes to the events the ticket records. */
  private async open(ticket: Ticket, cwd: string, settings: Settings, assignmentId: string): Promise<AgentSession> {
    const sessionId = workerSessionId(ticket.id)
    const session = await this.host.sessions.ensure(sessionId, {
      cwd,
      model: settings.executor.model ? `${settings.executor.model.provider}/${settings.executor.model.model}` : undefined,
      thinkingLevel: settings.executor.model?.reasoningEffort as never,
      customTools: [
        reportTool(report => { this.report(ticket, report) }, () => ticket.origin.triggerId),
        handbackTool(triggerId => {
          const queued = this.host.engine.handback(ticket.id, triggerId, 'beyond this ticket')
          return queued
        }),
      ],
      instructions: this.instructions(ticket),
    })
    session.subscribe(event => { this.onEvent(ticket.id, assignmentId, event) })
    return session
  }

  /**
   * Records a worker's report and, when it says something a person must see, sends it to the conversation the ticket came
   * from. This build has no separate routing session, so the Executor owns that message: a `ready` or `dropped` report is
   * the ticket's result, and a question is the ticket's attention.
   */
  private report(ticket: Ticket, report: WorkerReport): void {
    try {
      this.host.engine.report(ticket.id, report)
      const stored = this.host.store.tickets.get(ticket.id)
      if (!stored) return
      if (stored.attention && report.state !== 'progress' && report.state !== 'waiting') {
        this.host.engine.reply({ purpose: 'attention', ticketId: ticket.id, question: stored.attention.question, text: stored.attention.question })
      }
      if (report.state === 'ready' || report.state === 'dropped') {
        this.host.engine.reply({ purpose: 'result', ticketId: ticket.id, text: report.summary })
      }
    } catch (error) {
      // A refused report or reply leaves the ticket as it was; the worker still sees the tool result below.
      process.stderr.write(`report for ${ticket.id} was refused: ${error instanceof Error ? error.message : String(error)}\n`)
      throw error
    }
  }

  /** The per-ticket instructions: the shared work prompt plus what this ticket's mandate allows. */
  private instructions(ticket: Ticket): string {
    const mandate = ticket.mandate
    const limited = mandate.strength === 'inferred'
      ? 'This ticket was accepted proactively under a rule, not requested directly. Independently verify that the change is small '
        + 'and internal to one module within the accepted scope. If it needs a public interface change, a product or design decision, '
        + 'or anything outside that scope, stop and report `dropped`; do not expand the scope.'
      : 'This ticket answers an explicit request, which dispatch routed.'
    return [
      prompt('work'),
      `## This ticket`,
      `Title: ${ticket.title}`,
      `Scope: ${mandate.scope}`,
      limited,
      `The repository is ${this.host.deployment.repository}.`,
    ].join('\n\n')
  }

  private onEvent(ticketId: string, assignmentId: string, event: { type: string }): void {
    if (event.type === 'turn_start') {
      const unread = this.unread.get(ticketId)
      if (unread?.length) { this.host.engine.inputsRead(ticketId, unread); this.unread.delete(ticketId) }
    }
    if (event.type === 'agent_settled') {
      // A settled run has no automatic work left, so its turn is over for the ticket's purposes.
      const ticket = this.host.store.tickets.get(ticketId)
      if (ticket && liveTicket(ticket) && runningAssignment(ticket)?.id === assignmentId) {
        this.host.engine.turnEnded(ticketId, assignmentId)
      }
    }
  }

  private async deliverTo(ticketId: string): Promise<void> {
    if (this.host.paused()) throw new Later('Processing is paused')
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) return
    const assignment = runningAssignment(ticket)
    if (!assignment) return
    const session = this.host.sessions.get(workerSessionId(ticketId))
    if (!session) throw new Later('The worker session is not open yet')
    await this.hand(ticketId, assignment.id, session, ticket)
  }

  /** Hands the ticket's waiting Inputs to its session: a prompt when idle, a steer when it is working. */
  private async hand(ticketId: string, assignmentId: string, session: AgentSession, ticket: Ticket): Promise<void> {
    const waiting = ticket.inputs.filter(input => ticket.undelivered.includes(input.id))
    const text = this.render(ticket, waiting)
    if (!text) return
    try {
      const ids = waiting.map(input => input.id)
      // A busy session takes the message at its next step, which is what makes a correction cost a person nothing;
      // an idle one starts a turn with it.
      if (session.isStreaming || !session.isIdle) await session.steer(text)
      else await session.prompt(text)
      if (ids.length) {
        this.host.engine.inputsDelivered(ticketId, assignmentId, ids)
        this.unread.set(ticketId, [...this.unread.get(ticketId) ?? [], ...ids])
      }
    } catch (error) {
      this.host.engine.deliveryFailed(ticketId, assignmentId, error instanceof Error ? error.message : String(error))
    }
  }

  /** Renders waiting Inputs as one message: the assignment first when the ticket has not been handed over yet. */
  private render(ticket: Ticket, inputs: TicketInput[]): string {
    const parts: string[] = []
    const assignment = ticket.execution?.assignment
    if (assignment && ticket.assignments.filter(item => item.state !== 'pending').length <= 1) parts.push(assignment)
    for (const input of inputs) {
      if (input.kind === 'trigger') {
        const trigger = this.host.store.triggers.get(input.triggerId)
        parts.push(this.triggerText(trigger, input))
      } else if (input.kind === 'text' || input.kind === 'note') {
        parts.push(input.text)
      } else if (input.kind === 'policy-changed') {
        parts.push(`The policy changed from ${input.from} to ${input.to}. Re-read the rules that accepted this ticket.`)
      } else if (input.kind === 'resumed') {
        parts.push('The work resumed under the same mandate; read the thread again before continuing.')
      }
    }
    return parts.filter(part => part && part.trim()).join('\n\n---\n\n')
  }

  private triggerText(trigger: Trigger | undefined, input: { human?: true; context?: true; note?: string }): string {
    if (!trigger) return ''
    const lines = [
      `${trigger.human ? 'A person' : 'A machine'} wrote this on ${trigger.threads[0]?.id ?? 'the thread'}${trigger.url ? ` (${trigger.url})` : ''}`
        + ` [trigger ${trigger.id}]:`,
      trigger.text,
    ]
    if (input.context) lines.push('(It reached this ticket only as context on a related thread; it grants nothing.)')
    if (input.note) lines.push(`Routing note: ${input.note}`)
    return lines.join('\n')
  }

  /** Records a launch failure: a failed report ends the ticket, an unreachable session only fails the assignment. */
  private fail(ticketId: string, assignmentId: string, error: unknown, started: boolean): void {
    const message = error instanceof Error ? error.message : String(error)
    try {
      if (!started) {
        this.host.engine.assignmentStarted(ticketId, assignmentId)
      }
      this.host.engine.report(ticketId, { state: 'failed', summary: message.slice(0, 2000) })
    } catch { /* The ticket may have ended meanwhile; its state is then authoritative. */ }
    this.host.health.set({ state: 'error', detail: message.slice(0, 500), at: new Date().toISOString() })
  }
}
