import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, waitsForPerson, type Ticket, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/store/store.ts'
import { policyVersion, settingsPolicy, SettingsSchema } from '../src/policy.ts'
import { sourceRegistry } from '../src/sources/builtins.ts'
import { Prompts } from '../src/runtime/prompts.ts'
import { saveSettings } from '../src/runtime/settings.ts'
import { manage } from '../src/runtime/management.ts'
import { KV } from '../src/kv.ts'

const opened: { store: Store; directory: string }[] = []
afterEach(() => { for (const { store, directory } of opened.splice(0)) { store.close(); rmSync(directory, { recursive: true, force: true }) } })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'management-'))
  const store = new Store(join(directory, 'state.sqlite'))
  opened.push({ store, directory })
  const settings = SettingsSchema.parse({ sources: { im: { enabled: true, config: {} } }, policy: { sources: { im: { allowed: [{ id: 'alice' }] } } } })
  store.saveSettings(settings)
  const sources = sourceRegistry(() => store.settings())
  const executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const engine = new Engine({ repo: store, policy: () => settingsPolicy(store.settings(), sources), scope: sources,
    executor, assessor: { request: vi.fn() }, outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const trigger: Trigger = { id: 'origin', source: 'im', threads: [{ source: 'im', id: 'general' }], actor: { source: 'im', id: 'alice' },
    human: true, addressed: 'mention', text: 'Analyze this report', at: '2026-01-01T00:00:00.000Z', meta: { channel: 'general' },
    channel: { source: 'im', thread: 'general', address: { channel: 'general' } } }
  const ticket: Ticket = { id: 'task-one', title: 'Analyze a report', decisionId: 'accepted', createdAt: trigger.at, updatedAt: trigger.at,
    mandate: { strength: 'explicit', policyVersion: policyVersion(settings), actor: trigger.actor, scope: 'Analyze the report', basis: { via: 'addressed', addressed: 'mention' } },
    channels: [trigger.channel!], origin: { triggerId: trigger.id, triggerIds: [trigger.id] }, inputs: [], undelivered: [],
    assignments: [{ id: 'assignment-one', state: 'running', createdAt: trigger.at, report: { state: 'blocked', summary: 'Which period?', at: trigger.at } }],
    attention: { id: 'question', question: 'Which period?' } }
  store.triggers.save(trigger)
  store.triggers.saveDisposition(trigger.id, { fanout: [], at: trigger.at })
  store.threads.save({ key: 'im:general', ref: trigger.threads[0]!, createdAt: trigger.at, subscriptions: [ticket.id], correlated: [], pending: [], meta: {} })
  store.tickets.save(ticket)
  const prompts = new Prompts(store, () => ({ orchestrator: 'Route', assess: 'Judge', work: 'Work', shared: '' }))
  const host = { store, sources, engine, prompts, notify: vi.fn(), requestPass: vi.fn(),
    configure: (value: unknown, revision: number) => saveSettings(store, sources, value, revision, engine) }
  return { host, store, engine, executor, ticket, trigger }
}

describe('operator management', () => {
  it('stops work through the Engine and withdraws its mandate', async () => {
    const { host, store, executor, ticket } = fixture()
    await manage(host, { action: 'ticket.stop', payload: { id: ticket.id, reason: 'No longer needed' } })
    expect(store.tickets.get(ticket.id)?.ended).toMatchObject({ by: 'human', outcome: 'stopped', reason: 'No longer needed' })
    expect(executor.stop).toHaveBeenCalledOnce()
  })
  it('answers only the selected ticket with an auditable human input', async () => {
    const { host, store, ticket } = fixture()
    store.tickets.save({ ...ticket, id: 'other-task' })
    const thread = store.threads.get('im:general')!
    thread.subscriptions.push('other-task')
    store.threads.save(thread)
    const result = await manage(host, { action: 'ticket.answer', payload: { id: ticket.id, text: 'Use March' } }) as { trigger: Trigger }
    expect(result.trigger.actor.id).toBe('operator')
    expect(store.tickets.get(ticket.id)?.inputs).toContainEqual(expect.objectContaining({ kind: 'trigger', triggerId: result.trigger.id, human: true }))
    expect(store.tickets.get('other-task')?.inputs).toEqual([])
    expect(waitsForPerson(store.tickets.get(ticket.id)!)).toBe(false)
  })
  it('retries a stalled assignment and refuses an answer after a stop', async () => {
    const { host, store, ticket, executor } = fixture()
    await manage(host, { action: 'ticket.retry', payload: { id: ticket.id } })
    expect(store.tickets.get(ticket.id)?.assignments).toHaveLength(2)
    expect(executor.start).toHaveBeenCalledOnce()
    await manage(host, { action: 'ticket.stop', payload: { id: ticket.id } })
    await expect(manage(host, { action: 'ticket.answer', payload: { id: ticket.id, text: 'Continue' } })).rejects.toThrow('ended ticket')
  })
  it('validates actions before changing work', async () => {
    const { host, ticket } = fixture()
    await expect(manage(host, { action: 'ticket.note', payload: { id: ticket.id, text: ' ' } })).rejects.toThrow()
    await expect(manage(host, { action: 'unknown' })).rejects.toMatchObject({ code: 'usage' })
  })
})

describe('live configuration and prompts', () => {
  it('notifies affected tickets atomically when a policy changes', async () => {
    const { host, store, ticket } = fixture()
    const current = store.tickets.get(ticket.id)!
    current.mandate.basis = { via: 'addressed', addressed: 'mention', rules: ['copy'] }
    store.tickets.save(current)
    const next = store.settings()
    next.policy.rules[0]!.instruction = 'Use the revised terminology'
    const revision = store.get(KV.settings.revision)!
    const result = await manage(host, { action: 'settings.save', payload: { value: next, baseRevision: revision } }) as { notified: string[] }
    expect(result.notified).toEqual([ticket.id])
    expect(store.tickets.get(ticket.id)?.inputs).toContainEqual(expect.objectContaining({ kind: 'policy-changed' }))
    await expect(manage(host, { action: 'settings.save', payload: { value: next, baseRevision: revision } })).rejects.toMatchObject({ code: 'conflict' })
  })
  it('invalidates pending evaluations when a source is disabled and refuses replay', async () => {
    const { host, store, engine, trigger } = fixture()
    const incoming = { ...trigger, id: 'later-event', threads: [{ source: 'im', id: 'another' }] }
    engine.receive(incoming)
    engine.evaluateDue()
    const old = engine.candidate(incoming.id)!
    expect(old).toBeDefined()
    const next = store.settings()
    next.sources.im!.enabled = false
    await manage(host, { action: 'settings.save', payload: { value: next, baseRevision: store.get(KV.settings.revision)! } })
    expect(() => engine.decide(incoming.id, { kind: 'accept', title: 'Late result', scope: 'old request', reason: 'asked', evalId: old.evalId })).toThrow()
    engine.evaluateDue()
    expect(engine.candidate(incoming.id)).toBeUndefined()
    expect(store.tickets.list()).toHaveLength(1)
    engine.reevaluate(incoming.id)
    engine.evaluateDue()
    expect(store.tickets.list()).toHaveLength(1)
    expect(store.decisions.byThread('im:another').at(-1)?.kind).toBe('ignore')
  })

  it('includes narrowed receiving scope in the policy version', async () => {
    const { host, store } = fixture()
    const before = policyVersion(store.settings())
    const next = store.settings()
    next.sources.im!.config.channels = ['other-channel']
    await manage(host, { action: 'settings.save', payload: { value: next, baseRevision: store.get(KV.settings.revision)! } })
    expect(policyVersion(store.settings())).not.toBe(before)
    expect(settingsPolicy(store.settings(), host.sources).gate(store.triggers.get('origin')!, store.threads.get('im:general')!, []))
      .toMatchObject({ admissible: false })
  })

  it('records prompt changes and queues a coordinator notice', async () => {
    const { host } = fixture()
    const value = { ...host.prompts.current().config, shared: 'Prefer concise replies' }
    await manage(host, { action: 'prompts.save', payload: { value, baseRevision: 0 } })
    expect(host.prompts.read('work')).toEqual({ revision: 1, text: 'Work\n\nPrefer concise replies' })
    expect(host.notify).toHaveBeenCalledWith('prompts:1', expect.any(String))
  })
})
