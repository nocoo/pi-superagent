import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, runningAssignment, ticketStage, type Trigger, type WorkerReport } from '../src/core/index.ts'
import { Store } from '../src/store/store.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceRegistry } from '../src/sources/builtins.ts'
import { Effects } from '../src/runtime/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { PiExecutor, workerSessionId } from '../src/agents/pi-executor.ts'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { PiSessions, SessionProfile } from '../src/agents/sessions.ts'

function fakeSession() {
  const listeners = new Set<(event: { type: string; message?: unknown }) => void>()
  const pending: string[] = []
  let idle = true
  let resolveRun: (() => void) | undefined
  const emit = (type: string, message?: unknown) => { for (const listener of listeners) listener({ type, message }) }
  const consume = (text: string) => { emit('message_end', { role: 'user', content: [{ type: 'text', text }] }); emit('turn_start') }
  const consumeSteer = () => { const text = pending.shift(); if (text) consume(text) }
  const finish = () => { while (pending.length) consumeSteer(); idle = true; emit('agent_settled'); resolveRun?.(); resolveRun = undefined }
  const session = {
    messages: [], getLastAssistantText: () => 'Waiting for more context',
    get isIdle() { return idle }, get isStreaming() { return !idle },
    subscribe: (listener: (event: { type: string; message?: unknown }) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    prompt: vi.fn(async (text: string) => { idle = false; consume(text); await new Promise<void>(resolve => { resolveRun = resolve }) }),
    steer: vi.fn(async (text: string) => { pending.push(text); return 'queued' }),
    abort: async () => { pending.length = 0; finish() }, dispose: vi.fn(),
  }
  return { session, finish, emit, consumeSteer }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function fixture(maxWorkers = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'executor-'))
  const store = new Store(join(directory, 'state.sqlite'))
  store.saveSettings(SettingsSchema.parse({ sources: { im: { enabled: true, config: {} } },
    policy: { sources: { im: { allowed: [{ id: 'alice' }] } } }, executor: { maxWorkers } }))
  const sources = sourceRegistry(() => store.settings())
  const health = new HealthBoard()
  let clock = Date.now()
  const effects = new Effects(store, health, () => clock)
  const lifetime = new AbortController()
  const live = new Map<string, ReturnType<typeof fakeSession>>()
  const profiles: { id: string; profile: SessionProfile }[] = []
  let disposeGate: Promise<void> | undefined
  const sessions = {
    get: (id: string) => live.get(id)?.session,
    ensure: vi.fn(async (id: string, profile: SessionProfile) => {
      profiles.push({ id, profile })
      if (!live.has(id)) live.set(id, fakeSession())
      return live.get(id)!.session
    }),
    applyProfile: vi.fn(async () => {}),
    dispose: async (id: string) => { await disposeGate; const item = live.get(id); live.delete(id); await item?.session.abort() },
  }
  let engine!: Engine
  const executor = new PiExecutor({ get engine() { return engine }, store, effects, sessions: sessions as unknown as PiSessions,
    health: health.claim('workers'), deployment: { repository: '', github: { cli: 'gh', login: '', noreply: '' } }, stateDir: directory,
    lifetime: lifetime.signal, paused: () => store.settings().paused, notify: vi.fn(),
    submitReport: async (id, assignmentId, report) => {
      if (runningAssignment(store.tickets.get(id)!)?.id !== assignmentId) throw new Error('Assignment ended')
      engine.report(id, report)
    },
  })
  engine = new Engine({ repo: store, policy: () => settingsPolicy(store.settings(), sources), scope: sources,
    assessor: { request: () => {} }, executor, outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
    now: () => new Date(clock++).toISOString(),
    prepareTicket: ticket => ({ ...ticket, execution: { name: ticket.id, directory: join(directory, ticket.id), assignment: '' } }),
  })
  let counter = 0
  const accept = (text: string) => {
    const id = `event-${++counter}`
    const trigger: Trigger = { id, source: 'im', threads: [{ source: 'im', id }], actor: { source: 'im', id: 'alice' }, human: true,
      addressed: 'mention', text, at: new Date(clock++).toISOString(), meta: { channel: id } }
    engine.receive(trigger)
    return engine.decide(id, { kind: 'accept', title: 'General task', scope: text, reason: 'Explicit request' }).ticketId!
  }
  const pump = async () => { effects.start(); await effects.idle() }
  cleanups.push(async () => {
    lifetime.abort()
    disposeGate = undefined
    for (const id of live.keys()) await sessions.dispose(id)
    await effects.drain()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { engine, executor, effects, store, accept, pump, sessions, profiles, live,
    advance: () => { clock += 3000 }, gateDispose: (gate: Promise<void>) => { disposeGate = gate } }
}

describe('executor lifecycle through the real Engine and queue', () => {
  it('delivers an explicit origin even when the ticket has no queued inputs or routing note', async () => {
    const f = fixture()
    const id = f.accept('Summarize the March operations report')
    expect(f.store.tickets.get(id)!.inputs).toEqual([])
    await f.pump()
    expect(f.live.get(workerSessionId(id))!.session.prompt).toHaveBeenCalledWith(expect.stringContaining('Summarize the March operations report'))
  })
  it('uses a bounded Pi extension reminder when a worker ends without a report', async () => {
    const f = fixture()
    const id = f.accept('Ask for a destination')
    await f.pump()
    const handlers = new Map<string, (event: unknown) => unknown>()
    const extension = f.profiles[0]!.profile.extensions![0]
    if (typeof extension !== 'function') throw new Error('Expected an inline extension')
    await extension({ on: (name: string, handler: (event: unknown) => unknown) => { handlers.set(name, handler); return () => {} } } as never)
    handlers.get('before_agent_start')!({})
    const event = { outcome: 'completed', continue: false, context: { canContinue: true } }
    expect(handlers.get('agent_before_settle')!(event)).toMatchObject({ continue: true, entries: [expect.objectContaining({ customType: 'report-required' })] })
    expect(handlers.get('agent_before_settle')!(event)).toBeUndefined()
    f.engine.report(id, { state: 'blocked', summary: 'Which destination?', question: 'Which destination?' })
    expect(handlers.get('agent_before_settle')!(event)).toBeUndefined()
  })

  it('does not deliver a launch input twice through a concurrent delivery effect', async () => {
    const f = fixture()
    const id = f.accept('Write a summary')
    f.engine.note(id, 'Use concise language')
    await f.pump()
    f.advance(); await f.pump()
    const session = f.live.get(workerSessionId(id))!.session
    expect(session.prompt).toHaveBeenCalledTimes(1)
    expect(session.prompt.mock.calls[0]![0]).toContain('Use concise language')
    expect(session.steer).not.toHaveBeenCalled()
  })
  it('frees a settled worker slot and records an idle status when no report was made', async () => {
    const f = fixture()
    const first = f.accept('First task')
    await f.pump()
    f.live.get(workerSessionId(first))!.finish()
    expect(ticketStage(f.store.tickets.get(first)!).stage).toBe('idle')
    const second = f.accept('Second task')
    await f.pump()
    expect(f.live.get(workerSessionId(second))!.session.prompt).toHaveBeenCalledOnce()
  })
  it('retains a full-slot delivery and steers a busy worker without another slot', async () => {
    const f = fixture()
    const first = f.accept('First task')
    await f.pump()
    f.engine.note(first, 'Correction while working')
    await f.pump()
    expect(f.live.get(workerSessionId(first))!.session.steer).toHaveBeenCalledWith(expect.stringContaining('Correction while working'))
    f.live.get(workerSessionId(first))!.finish()
    const second = f.accept('Second task')
    await f.pump()
    f.engine.note(first, 'Continue the first task')
    await f.pump()
    expect(f.effects.pending('delivery', first)).toBe(true)
    f.live.get(workerSessionId(second))!.finish()
    f.advance(); await f.pump()
    expect(f.live.get(workerSessionId(first))!.session.prompt).toHaveBeenCalledTimes(2)
  })
  it('reopens a missing idle session and delivers the follow-up', async () => {
    const f = fixture()
    const id = f.accept('First task')
    await f.pump()
    f.live.get(workerSessionId(id))!.finish()
    f.live.delete(workerSessionId(id))
    f.engine.note(id, 'Continue after restart')
    await f.pump()
    expect(f.sessions.ensure).toHaveBeenCalledTimes(2)
    expect(f.live.get(workerSessionId(id))!.session.prompt).toHaveBeenCalledWith(expect.stringContaining('Continue after restart'))
    expect(f.profiles[0]!.profile.cwd).toBe(f.profiles[1]!.profile.cwd)
  })
  it('waits for shutdown and sends a resume instruction on a retry with no new inputs', async () => {
    const f = fixture()
    const id = f.accept('A blocked task')
    await f.pump()
    f.engine.report(id, { state: 'blocked', summary: 'Need a retry' })
    let release!: () => void
    f.gateDispose(new Promise(resolve => { release = resolve }))
    f.engine.retryTicket(id)
    const pumping = f.pump()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.sessions.ensure).toHaveBeenCalledTimes(1)
    release()
    await pumping
    expect(f.sessions.ensure).toHaveBeenCalledTimes(2)
    expect(f.live.get(workerSessionId(id))!.session.prompt).toHaveBeenCalledWith(expect.stringContaining('resumes this task'))
  })
  it('keeps a note pending when prompt preflight rejects and retries it', async () => {
    const f = fixture()
    const id = f.accept('Task')
    await f.pump()
    const session = f.live.get(workerSessionId(id))!
    session.finish()
    session.session.prompt.mockRejectedValueOnce(new Error('Preflight failed'))
    f.engine.note(id, 'Important operator context')
    await f.pump()
    const failed = f.store.tickets.get(id)!
    expect(failed.delivery?.error).toContain('Preflight failed')
    expect(failed.undelivered).toHaveLength(1)
    f.engine.retryTicket(id)
    await f.pump()
    expect(f.live.get(workerSessionId(id))!.session.prompt).toHaveBeenCalledWith(expect.stringContaining('Important operator context'))
  })
  it('marks only consumed steering batches read and releases the unconsumed correction', async () => {
    const f = fixture()
    const id = f.accept('Task')
    await f.pump()
    const original = f.store.triggers.get(f.store.tickets.get(id)!.origin.triggerId)!
    f.engine.receive({ ...original, id: 'follow-1', text: 'First correction' })
    await f.pump()
    f.engine.receive({ ...original, id: 'follow-2', text: 'Second correction' })
    await f.pump()
    const session = f.live.get(workerSessionId(id))!
    session.consumeSteer()
    const current = f.store.tickets.get(id)!
    expect(current.inputs.find(input => input.kind === 'trigger' && input.triggerId === 'follow-1')).toMatchObject({ readAt: expect.any(String) })
    const unread = current.inputs.find(input => input.kind === 'trigger' && input.triggerId === 'follow-2')!
    expect(current.undelivered).toContain(unread.id)
    f.engine.report(id, { state: 'ready', summary: 'Finished before reading another correction' })
    expect(f.store.threads.get(`im:${original.threads[0]!.id}`)!.pending).toContain('follow-2')
  })
  it('ignores a stale settled event after the assignment was replaced', async () => {
    const f = fixture()
    const id = f.accept('Task')
    await f.pump()
    const previous = f.store.tickets.get(id)!.assignments.at(-1)!.id
    const oldSession = f.live.get(workerSessionId(id))!.session
    f.engine.report(id, { state: 'failed', summary: 'Try again' })
    f.engine.retryTicket(id)
    await f.pump()
    ;(f.executor as unknown as { onEvent(id: string, assignment: string, event: { type: string }, session: AgentSession): void })
      .onEvent(id, previous, { type: 'agent_settled' }, oldSession as unknown as AgentSession)
    expect(f.executor.activeCount()).toBe(1)
  })
})
