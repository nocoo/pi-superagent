/**
 * The composition root: locks the state directory, opens the store, builds every component, and runs the coordination
 * loop. It holds no rules; it only decides what is constructed with what.
 */
import { lockSync } from 'proper-lockfile'
import { Engine, liveTicket, runningAssignment, type WorkerReport, type AssessmentOutcome, type OutboundMessage, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import type { Health, SourceContext, SourceHost, ThreadDescription } from '../sources/host.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Store } from '../store/store.ts'
import { Effects } from './effects.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { PiSessions } from '../agents/sessions.ts'
import { PiExecutor } from '../agents/pi-executor.ts'
import { PiCoordinator } from '../agents/pi-coordinator.ts'
import { claimPull, readPull, pullEndNotices } from '../sources/github-pull.ts'
import { githubKind } from '../sources/github.ts'
import { policyEffects, policyVersion, settingsPolicy, SettingsSchema, type Settings } from '../policy.ts'
import { Prompts } from './prompts.ts'
import { saveSettings } from './settings.ts'
import { manage } from './management.ts'
import { ControlError, type ControlRequest } from './control.ts'
import { KV } from '../kv.ts'
import type { SourceKind } from '../sources/kind.ts'
import { Commands } from '../infra/commands.ts'
import { executionRoot } from '../agents/environment.ts'
import type { Deployment } from '../config.ts'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface HostOptions {
  /** Directory for the database, lock and session files. */
  stateDir: string
  deployment: Deployment
}

/** Turns an accept into the ticket's execution record: its short name, its directory and the assignment text its worker reads. */
export function prepareTicket(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, settings: Settings, stateDir: string): Ticket {
  if (outcome.name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(outcome.name)) throw new Error('Task names must be kebab-case without path separators')
  const name = `${outcome.name ?? 'work'}-${ticket.id.slice(0, 12)}`
  const directory = join(executionRoot(settings.executor.directory, stateDir), name)
  const rules = (ticket.mandate.basis.rules ?? []).flatMap(id => {
    const rule = settings.policy.rules.find(item => item.id === id)
    return rule ? [`- ${rule.name} (${rule.id}): ${rule.instruction}`] : []
  })
  const assignment = [
    outcome.note ? `Routing note (not the source request): ${outcome.note}` : '',
    rules.length ? `Matched rules; their procedure and communication instructions take precedence:\n${rules.join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
  return { ...ticket, execution: { name, directory, assignment } }
}

export class Host implements SourceHost {
  readonly store: Store
  readonly health = new HealthBoard()
  readonly effects: Effects
  readonly outbox: Outbox
  readonly passes: Passes
  readonly sources: SourceRegistry
  readonly sessions: PiSessions
  readonly executor: PiExecutor
  readonly coordinator: PiCoordinator
  readonly engine: Engine
  readonly prompts: Prompts
  private readonly kinds = new Map<string, SourceKind>()
  private readonly sourceStops = new Map<string, () => void>()
  private readonly commands: Commands
  private readonly release: () => void
  private readonly lifetime = new AbortController()
  private started = false
  private stopping?: Promise<void>

  constructor(private readonly options: HostOptions) {
    const { stateDir, deployment } = options
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    this.release = lockSync(stateDir, { stale: 30_000 })
    this.store = new Store(join(stateDir, 'superagent.sqlite'), error => { console.error('afterCommit failed: %s', String(error)) })
    this.commands = new Commands(() => deployment, {}, this.lifetime.signal)
    this.effects = new Effects(this.store, this.health)
    this.sources = new SourceRegistry(() => this.settings(), this.health)
    this.prompts = new Prompts(this.store)
    this.outbox = new Outbox({ store: this.store, effects: this.effects, sources: this.sources, commands: this.commands,
      stateDir, paused: () => this.settings().paused })
    this.sessions = new PiSessions(join(stateDir, 'sessions'))
    this.executor = new PiExecutor({
      engine: engineOf(this), store: this.store, effects: this.effects, sessions: this.sessions,
      health: this.health.claim('workers', { state: 'starting', detail: 'Starting' }), deployment, stateDir,
      lifetime: this.lifetime.signal, paused: () => this.settings().paused,
      notify: (id, text) => this.coordinator.notify(id, text),
      submitReport: (ticketId, assignmentId, report, prNumber, signal) => this.submitReport(ticketId, assignmentId, report, prNumber, signal),
    })
    this.coordinator = new PiCoordinator({ engine: engineOf(this), store: this.store, effects: this.effects, deployment,
      sessions: this.sessions, stateDir, readPrompt: role => this.prompts.read(role),
      lifetime: this.lifetime.signal, prompts: this.prompts, configure: (value: unknown, revision: number) => this.configure(value, revision),
      paused: () => this.settings().paused })
    this.engine = new Engine({
      repo: this.store,
      policy: () => settingsPolicy(this.settings(), this.sources),
      scope: this.sources,
      assessor: this.coordinator,
      executor: this.executor,
      outbox: this.outbox,
      prepareTicket: (ticket, outcome) => prepareTicket(ticket, outcome, this.settings(), stateDir),
      emit: event => {
        if (process.env.PI_SUPERAGENT_LOG) console.error('[%s] %s', event.type, JSON.stringify(event.data))
        if (event.type === 'ticket.ended') {
          const ticket = this.store.tickets.get(event.data.ticketId)
          if (ticket) {
            const request = this.store.triggers.get(ticket.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ticket, request, deployment.repository)) this.outbox.send(message)
            if (event.data.by === 'human' || event.data.outcome === 'merged' || event.data.outcome === 'closed') {
              this.coordinator.notify(`ended:${ticket.id}:${event.at}`, `Ticket ${ticket.id} ended: ${event.data.outcome}. This is a fact, not a new request.`)
            }
          }
        }
      },
    })
    this.passes = new Passes({ engine: this.engine, effects: this.effects, health: this.health.claim('passes', { state: 'starting', detail: 'Starting' }),
      lifetime: this.lifetime.signal, configured: () => true, closing: () => !this.started })
  }

  private async submitReport(ticketId: string, assignmentId: string, report: WorkerReport, prNumber?: number, signal?: AbortSignal): Promise<void> {
    if (prNumber && !this.sources.instance('github')?.enabled) throw new Error('GitHub is not configured for this task result')
    const context = prNumber ? this.context(githubKind) : undefined
    const pull = context && prNumber ? await readPull(context, prNumber, signal) : undefined
    this.store.atomic(() => {
      const ticket = this.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) throw new Error('This assignment has ended')
      if (pull && context) {
        const refused = claimPull(context, ticketId, pull)
        if (refused) throw new Error(refused)
      }
      this.engine.report(ticketId, report)
    })
  }

  /** Current validated settings. */
  settings(): Settings { return this.store.settings() }

  /** Registers a Source kind and starts its enabled instance. */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): void {
    this.sources.register(kind)
    this.kinds.set(kind.kind, kind as SourceKind)
    if (this.started) this.startSource(kind.kind)
  }

  private startSource(id: string): void {
    const kind = this.kinds.get(id)!
    const instance = this.sources.instance(id)
    if (instance?.enabled) this.sourceStops.set(id, kind.start(this, instance))
  }

  manage(request: ControlRequest): Promise<unknown> {
    if (request.action === 'runtime.status') {
      const session = this.sessions.get(PiCoordinator.sessionId)
      return Promise.resolve({ health: this.health.all, coordinator: { running: !!session && !session.isIdle,
        tools: session?.getActiveToolNames() ?? [] } })
    }
    return manage({ store: this.store, engine: this.engine, sources: this.sources, prompts: this.prompts,
      configure: (value, revision) => this.configure(value, revision),
      notify: (id, text) => this.coordinator.notify(id, text), requestPass: () => this.passes.request() }, request)
  }

  configure(value: unknown, baseRevision: number): ReturnType<typeof saveSettings> {
    const next = SettingsSchema.parse(value)
    const old = this.settings()
    const account = (settings: Settings) => {
      const config = settings.sources.github?.config
      return [settings.sources.github?.enabled, config?.repository, config?.cli]
    }
    if (this.started && JSON.stringify(account(old)) !== JSON.stringify(account(next))) {
      throw new ControlError('restart_required', 'Stop the instance before changing the GitHub account or repository, then run it again')
    }
    const saved = saveSettings(this.store, this.sources, next, baseRevision, this.engine)
    if (saved.revision !== baseRevision) this.coordinator.notify(`settings:${saved.revision}`, `Settings revision ${saved.revision} is active; re-read current configuration before making new decisions.`)
    if (this.started) for (const id of this.kinds.keys()) {
      if (JSON.stringify(old.sources[id]) === JSON.stringify(saved.settings.sources[id])) continue
      this.sourceStops.get(id)?.()
      this.sourceStops.delete(id)
      this.startSource(id)
    }
    this.passes.request()
    return saved
  }

  /** Opens the store's loops and starts the coordination passes. */
  start(): void {
    if (this.started) return
    if (this.stopping) throw new Error('A stopped host cannot be restarted; create a new host')
    this.started = true
    const current = this.settings()
    const previous = this.store.get(KV.runtime.appliedSettings)
    this.store.atomic(() => {
      if (previous && policyVersion(previous) !== policyVersion(current)) {
        const scope = (settings: Settings) => ({ scope: (input: { source: string; meta: Record<string, unknown> }) => this.sources.scope(input, settings) })
        this.engine.policyChanged(policyVersion(previous), policyVersion(current), policyEffects(this.store.tickets.open(), previous, current, scope))
      }
      this.store.set(KV.runtime.appliedSettings, current)
    })
    this.recover()
    this.engine.evaluateDue()
    this.effects.start()
    this.passes.start()
    for (const id of this.kinds.keys()) this.startSource(id)
  }

  /**
   * Reports the Assignments that were mid-flight when the host stopped, so the Engine restarts them with a recovery
   * note. Without this a crash leaves its Tickets in `working` with an Assignment nothing will ever run.
   */
  private recover(): void {
    for (const ticket of this.store.tickets.active()) {
      const assignment = ticket.assignments.at(-1)
      if (!assignment || assignment.state === 'ended') continue
      try {
        if (assignment.state === 'pending') this.executor.start(ticket, assignment)
        else this.engine.assignmentInterrupted(ticket.id, assignment.id)
      }
      catch (error) { console.error('could not recover ticket %s: %s', ticket.id, String(error)) }
    }
  }

  /** Stops the passes, drains effects, closes worker sessions, and releases the state lock. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }

  private async shutdown(): Promise<void> {
    for (const stop of this.sourceStops.values()) stop()
    this.sourceStops.clear()
    this.started = false
    const draining = this.effects.drain()
    this.lifetime.abort()
    try {
      await this.passes.stop()
      const results = await Promise.allSettled([this.sessions.disposeAll(), draining])
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    } finally { this.release(); this.store.close() }
  }

  /** Builds the context a Source kind reads and writes through. */
  context(kind: { kind: string; health: readonly string[] }): SourceContext {
    const entries = this.sources.healthEntries(kind.health)
    const report = (entry: string, state: Health): void => {
      const target = entries.get(entry)
      if (!target) throw new Error(`${kind.kind} does not declare the health entry ${entry}`)
      target.set(state)
    }
    return {
      deployment: this.options.deployment,
      stateDir: this.options.stateDir,
      commands: this.commands,
      configured: () => true,
      config: <C extends Record<string, unknown>>(id: string) => {
        const instance = this.sources.instance<C>(id)
        return instance?.enabled ? instance.config : undefined
      },
      receive: (trigger: Trigger): ReceiveResult => this.passes.receive(trigger),
      atomic: work => this.store.atomic(work),
      state: {
        get: key => this.store.get(key),
        set: (key, value) => { if (value === undefined) this.store.delete(key); else this.store.set(key, value) },
        keys: family => this.store.keys(family),
      },
      threads: {
        get: key => this.store.threads.get(key),
        subscribed: source => this.store.read.subscribedThreads(source),
        describe: (key, description: ThreadDescription) => this.store.threads.describe(key, description),
        patch: (key, meta) => this.store.threads.patchMeta(key, meta),
      },
      tickets: {
        get: id => this.store.tickets.get(id),
        open: () => this.store.tickets.open(),
        bindThread: (id, thread, own) => { this.engine.bindThread(id, thread, own) },
        threadClosed: (thread, outcome, at) => { this.engine.threadClosed(thread, outcome, at) },
      },
      triggers: { get: id => this.store.triggers.get(id), latest: thread => this.store.read.threadTriggers(thread, 1)[0] },
      notify: (message: OutboundMessage) => { this.outbox.send(message) },
      report,
    }
  }
}

/** The Engine as the Executor and Assessor see it; a getter keeps construction order acyclic. */
function engineOf(host: Host) {
  return new Proxy({} as Engine, {
    get: (_target, property) => {
      const engine = (host as unknown as { engine: Engine }).engine
      const value = (engine as unknown as Record<string | symbol, unknown>)[property]
      return typeof value === 'function' ? value.bind(engine) : value
    },
  })
}

export type { HealthEntry }
