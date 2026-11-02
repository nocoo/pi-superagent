/** Persistence: aggregates round-trip, settings are versioned, and an outbox receipt is idempotent by message id. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store/store.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'

const dirs: string[] = []
function store(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'pi-superagent-'))
  dirs.push(dir)
  return new Store(join(dir, 'state.sqlite'))
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const trigger = (id: string): Trigger => ({ id, source: 'github', threads: [{ source: 'github', id: '1' }], actor: { source: 'github', id: 'alice' },
  human: true, at: '2026-01-01T00:00:00.000Z', text: `message ${id}`, meta: { kind: 'issue' } })

describe('the store', () => {
  it('stamps the schema version on a new database and reopens it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-superagent-'))
    dirs.push(dir)
    const path = join(dir, 'state.sqlite')
    new Store(path).close()
    const reopened = new Store(path)
    expect(reopened.get('schema' as never)).toBe(1)
    reopened.close()
  })

  it('opens a real read-only connection while the owner holds a write transaction', () => {
    const directory = mkdtempSync(join(tmpdir(), 'store-reader-'))
    dirs.push(directory)
    const path = join(directory, 'state.sqlite')
    const writer = new Store(path)
    let reader: Store | undefined
    try {
      writer.db.exec('BEGIN IMMEDIATE')
      reader = new Store(path, undefined, { readOnly: true })
      expect(reader.settings().eval.mode).toBe('observe')
      expect(() => reader!.set('should-not-write', true)).toThrow(/readonly/i)
    } finally { reader?.close(); writer.db.exec('ROLLBACK'); writer.close() }
  })

  it('returns default settings before anything is saved', () => {
    const open = store()
    const settings = open.settings()
    expect(settings.eval.mode).toBe('observe')
    expect(settings.executor.maxWorkers).toBe(3)
    expect(settings.policy.rules.map(rule => rule.id)).toEqual(['copy', 'visual'])
    open.close()
  })

  it('keeps saved settings as the current revision and preserves the earlier one', () => {
    const open = store()
    open.saveSettings({ eval: { mode: 'auto' } }, { source: 'internal', block: 'policy', policyVersion: 'v1', policyChanged: false, notified: [] })
    expect(open.settings().eval.mode).toBe('auto')
    expect(open.settingsHistory().map(version => version.revision)).toEqual([1])
    expect(open.blockRevision('policy')).toBe(1)
    open.close()
  })

  it('stores triggers, dispositions, and the thread index used by polling', () => {
    const open = store()
    open.triggers.save(trigger('a'))
    open.triggers.saveDisposition('a', { fanout: [], at: '2026-01-01T00:00:01.000Z' })
    expect(open.triggers.get('a')?.text).toBe('message a')
    expect(open.triggers.disposition('a')?.fanout).toEqual([])
    expect(open.read.threadTriggers('github:1').map(item => item.id)).toEqual(['a'])
    open.close()
  })

  it('lists only open tickets, newest first, so the coordination loop scans a small working set', () => {
    const open = store()
    const ticket = (id: string, ended = false): Ticket => ({ id, title: id, decisionId: 'd', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', channels: [], assignments: [], inputs: [], undelivered: [],
      origin: { triggerId: 'a', triggerIds: ['a'] }, mandate: { strength: 'explicit', policyVersion: 'v', scope: 's',
        actor: { source: 'github', id: 'alice' }, basis: { via: 'addressed', addressed: 'mention' } },
      ...ended ? { ended: { at: '2026-01-01T00:00:02.000Z', by: 'executor', outcome: 'completed' } } : {} } as Ticket)
    open.atomic(() => { open.tickets.save(ticket('first')); open.tickets.save(ticket('second')); open.tickets.save(ticket('done', true)) })
    expect(open.tickets.list().map(item => item.id)).toEqual(['done', 'second', 'first'])
    expect(open.tickets.open().map(item => item.id)).toEqual(['second', 'first'])
    open.close()
  })

  it('records a message receipt once, so a retried send cannot post twice', () => {
    const open = store()
    const message = { id: 'm1', channel: { source: 'github', thread: '1', address: { number: '1' } }, text: 'hello', kind: 'acknowledgement' as const }
    expect(open.receipts.add(message)).toBe(true)
    expect(open.receipts.add(message)).toBe(false)
    expect(open.replyStatus('m1')).toBe('pending')
    open.receipts.settle(message, 'sent')
    expect(open.replyStatus('m1')).toBe('sent')
    expect(open.receipts.add(message)).toBe(false)
    open.close()
  })

  it('runs afterCommit callbacks only once the outermost transaction commits', () => {
    const open = store()
    const seen: string[] = []
    open.atomic(() => { open.afterCommit(() => seen.push('outer')) })
    expect(seen).toEqual(['outer'])
    expect(() => open.atomic(() => {
      open.afterCommit(() => seen.push('rolled back'))
      throw new Error('nope')
    })).toThrow('nope')
    expect(seen).toEqual(['outer'])
    open.close()
  })
})
