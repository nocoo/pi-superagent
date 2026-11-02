import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inboxKind, inboxTrigger, readInboxReplies, InboxEventSchema } from '../src/sources/inbox.ts'

const dirs: string[] = []
const stateDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const event = (overrides: Record<string, unknown> = {}) => ({
  system: 'slack', id: 'evt-1', thread: 'thread-1', actor: 'alice', text: 'Fix it',
  ...overrides,
})

describe('inbox events', () => {
  it('maps events to stable inbox ids and namespaced identities', () => {
    const trigger = inboxTrigger(event())
    expect(trigger).toMatchObject({
      source: 'inbox', human: true, addressed: 'mention', text: 'Fix it',
      threads: [{ source: 'inbox', id: 'slack:thread-1' }],
      actor: { source: 'inbox', id: 'slack:alice' },
      channel: { source: 'inbox', thread: 'slack:thread-1', address: { system: 'slack', thread: 'thread-1', event: 'evt-1' } },
    })
    expect(trigger.id).toHaveLength(32)
    expect(inboxTrigger(event()).id).toBe(trigger.id)
  })

  it('defaults human and addressed while allowing explicit machine and unaddressed events', () => {
    expect(inboxTrigger(event({ human: undefined, addressed: undefined }))).toMatchObject({ human: true, addressed: 'mention' })
    expect(inboxTrigger(event({ human: false, addressed: false })).human).toBe(false)
    expect(inboxTrigger(event({ human: false, addressed: false })).addressed).toBeUndefined()
  })

  it('preserves native metadata and prevents user metadata from replacing critical keys', () => {
    const trigger = inboxTrigger(event({ meta: { system: 'evil', nativeThread: 'evil', nativeEvent: 'evil', nativeUrl: 'x' } }))
    expect(trigger.meta).toEqual({ system: 'slack', nativeThread: 'thread-1', nativeEvent: 'evt-1', nativeUrl: 'x' })
  })

  it('rejects bad input and extra event keys', () => {
    expect(InboxEventSchema.safeParse(event({ system: 'Slack' })).success).toBe(false)
    expect(InboxEventSchema.safeParse(event({ id: '  ' })).success).toBe(false)
    expect(InboxEventSchema.safeParse(event({ text: '   ' })).success).toBe(false)
    expect(InboxEventSchema.safeParse(event({ text: 'x'.repeat(20_001) })).success).toBe(false)
    expect(InboxEventSchema.safeParse(event({ extra: true })).success).toBe(false)
    expect(() => inboxTrigger({ system: 'slack', id: 'e', thread: 't', actor: 'a' })).toThrow()
  })
})

describe('inbox source', () => {
  it('observes configured systems or all systems and exposes the system as the scope row', () => {
    expect(inboxKind.scope!({ meta: { system: 'slack' } }, { observed: ['slack'] })).toEqual({ listened: true, observed: true, row: 'slack' })
    expect(inboxKind.scope!({ meta: { system: 'linear' } }, { observed: ['slack'] })).toEqual({ listened: true, observed: false, row: 'linear' })
    expect(inboxKind.scope!({ meta: { system: 'linear' } }, { observed: ['*'] })).toMatchObject({ listened: true, observed: true, row: 'linear' })
  })

  it('accepts namespaced policy actor ids and has no background loop', () => {
    expect(inboxKind.policy!.schema.safeParse({ allowed: [{ id: 'slack:alice' }] }).success).toBe(true)
    expect(inboxKind.policy!.schema.safeParse({ allowed: [{ id: 'linear:alice+work@example.com' }] }).success).toBe(true)
    expect(inboxKind.policy!.schema.safeParse({ allowed: [{ id: 'bad actor' }] }).success).toBe(false)
    const stop = inboxKind.start({ context: () => ({ report: () => {} }) } as never,
      { id: 'inbox', kind: 'inbox', enabled: true, config: { observed: [] } })
    expect(stop()).toBeUndefined()
  })
})

describe('inbox replies', () => {
  it('appends once by message id with private permissions and can be filtered and limited', async () => {
    const root = stateDir()
    const send = inboxKind.channel!.send
    const trigger = inboxTrigger(event())
    const channel = trigger.channel!
    const outbound = { id: 'reply-1', channel, text: 'On it', kind: 'reply' as const, ticketId: 'ticket-1' }

    expect(await send({ stateDir: root, commands: {} as never }, outbound)).toBe('sent')
    expect(await send({ stateDir: root, commands: {} as never }, outbound)).toBe('sent')

    const file = join(root, 'inbox', 'replies.jsonl')
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(statSync(join(root, 'inbox')).mode & 0o777).toBe(0o700)
    expect(statSync(file).mode & 0o777).toBe(0o600)

    const first = readInboxReplies(root)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ id: 'reply-1', system: 'slack', thread: 'thread-1', event: 'evt-1', text: 'On it', ticketId: 'ticket-1' })
    expect(first[0]!.at).toBeTruthy()

    await send({ stateDir: root, commands: {} as never }, { ...outbound, id: 'reply-2', text: 'Second' })
    await send({ stateDir: root, commands: {} as never }, { ...outbound, id: 'reply-3', channel: { ...channel, address: { system: 'linear', thread: 'L-2', event: 'evt-2' } } })
    expect(readInboxReplies(root, { system: 'slack', limit: 1 }).map(row => row.id)).toEqual(['reply-2'])
    expect(readInboxReplies(root).map(row => row.id)).toEqual(['reply-1', 'reply-2', 'reply-3'])
  })

  it('returns no replies before delivery and ignores malformed lines', () => {
    const root = stateDir()
    expect(readInboxReplies(root)).toEqual([])
  })
})
