/**
 * The composition root: locks the state directory, opens the store, builds every component, and runs the coordination
 * loop. It holds no rules; it only decides what is constructed with what.
 */
import { lockSync } from 'proper-lockfile'
import { Engine, type AssessmentOutcome, type OutboundMessage, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import type { Health, SourceContext, SourceHost, ThreadDescription } from '../sources/host.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Store } from '../store/store.ts'
import { Effects } from './effects.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { PiSessions } from '../agents/sessions.ts'
import { PiExecutor } from '../agents/pi-executor.ts'
import { PiAssessor } from '../agents/pi-assessor.ts'
import { policyEffects, settingsPolicy, type Settings } from '../policy.ts'
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
  readonly assessor: PiAssessor
  readonly engine: Engine
  private readonly commands: Commands
  private readonly release: () => void
  private readonly lifetime = new AbortController()
  private readonly stops: (() => void)[] = []
  private started = false

  constructor(private readonly options: HostOptions) {
    const { stateDir, deployment } = options
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    this.release = lockSync(stateDir, { stale: 30_000 })
    this.store = new Store(join(stateDir, 'superagent.sqlite'), error => { console.error('afterCommit failed: %s', String(error)) })
    this.commands = new Commands(() => deployment, {}, this.lifetime.signal)
    this.effects = new Effects(this.store, this.health)
    this.sources = new SourceRegistry(() => this.settings())
    this.outbox = new Outbox({ store: this.store, effects: this.effects, sources: this.sources, commands: this.commands,
      paused: () => this.settings().paused })
    this.sessions = new PiSessions(join(stateDir, 'sessions'))
    this.executor = new PiExecutor({
      engine: engineOf(this), store: this.store, effects: this.effects, sessions: this.sessions,
      health: this.health.claim('workers', { state: 'starting', detail: 'Starting' }), deployment, stateDir,
      lifetime: this.lifetime.signal, paused: () => this.settings().paused,
    })
    this.assessor = new PiAssessor({ engine: engineOf(this), store: this.store, effects: this.effects, deployment,
      paused: () => this.settings().paused })
    this.engine = new Engine({
      repo: this.store,
      policy: () => settingsPolicy(this.settings(), this.sources),
      scope: this.sources,
      assessor: this.assessor,
      executor: this.executor,
      outbox: this.outbox,
      prepareTicket: (ticket, outcome) => prepareTicket(ticket, outcome, this.settings(), stateDir),
      emit: event => { if (process.env.PI_SUPERAGENT_LOG) console.error('[%s] %s', event.type, JSON.stringify(event.data)) },
    })
    this.passes = new Passes({ engine: this.engine, effects: this.effects, health: this.health.claim('passes', { state: 'starting', detail: 'Starting' }),
      lifetime: this.lifetime.signal, configured: () => true, closing: () => !this.started })
  }

  /** Current validated settings. */
  settings(): Settings { return this.store.settings() }

  /** Registers a Source kind and starts its enabled instance. */
  register<S extends { kind: string; health: readonly string[]; start(host: SourceHost, instance: { id: string; kind: string; enabled: boolean; config: never }): () => void }>(kind: S): void {
    this.sources.register(kind as never)
    const instance = this.sources.instance(kind.kind)
    if (instance?.enabled) this.stops.push(kind.start(this, instance as never))
  }

  /** Opens the store's loops and starts the coordination passes. */
  start(): void {
    this.started = true
    this.recover()
    this.effects.start()
    this.passes.start()
  }

  /**
   * Reports the Assignments that were mid-flight when the host stopped, so the Engine restarts them with a recovery
   * note. Without this a crash leaves its Tickets in `working` with an Assignment nothing will ever run.
   */
  private recover(): void {
    for (const ticket of this.store.tickets.active()) {
      const assignment = ticket.assignments.at(-1)
      if (!assignment || assignment.state === 'ended') continue
      try { this.engine.assignmentInterrupted(ticket.id, assignment.id) }
      catch (error) { console.error('could not recover ticket %s: %s', ticket.id, String(error)) }
    }
  }

  /** Stops the passes, drains effects, closes worker sessions, and releases the state lock. */
  async stop(): Promise<void> {
    for (const stop of this.stops.splice(0)) stop()
    this.started = false
    this.lifetime.abort()
    await this.passes.stop()
    await this.sessions.disposeAll()
    await this.effects.drain()
    this.release()
    this.store.close()
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
