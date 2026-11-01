/**
 * The local IM: how a message becomes a Trigger, what is dropped, and how the read position advances. These are the four
 * responsibilities [docs/008](../docs/008-cookbook.md) says every Source carries, so they are tested rather than assumed.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImStore, messageId, readLines, type ImMessage } from '../src/im/store.ts'
import { imKind, readChannel, triggerOf } from '../src/sources/im.ts'
import { KV } from '../src/kv.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Trigger } from '../src/core/index.ts'

const dirs: string[] = []
const stateDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'im-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const config = { agent: 'agent', channels: [], observed: [] }
const message = (overrides: Partial<ImMessage> = {}): ImMessage =>
  ({ id: messageId(), channel: 'general', from: 'nocoo', at: '2026-11-01T00:00:00.000Z', text: 'hello', ...overrides })

describe('reading a channel file', () => {
  it('returns only complete lines and keeps a trailing partial one for the next read', () => {
    const buffer = Buffer.from('{"a":1}\n{"b":2}\n{"c":')
    const first = readLines(buffer, 0)
    expect(first.lines).toEqual(['{"a":1}', '{"b":2}'])
    expect(first.offset).toBe(Buffer.byteLength('{"a":1}\n{"b":2}\n'))
    const second = readLines(Buffer.from('{"a":1}\n{"b":2}\n{"c":3}\n'), first.offset)
    expect(second.lines).toEqual(['{"c":3}'])
  })

  it('measures the offset in bytes, so a multibyte message does not split', () => {
    const buffer = Buffer.from('{"t":"中文"}\nrest')
    const { offset } = readLines(buffer, 0)
    expect(buffer.subarray(offset).toString('utf8')).toBe('rest')
  })
})

describe('a message as a Trigger', () => {
  it('treats the channel as the Thread, so an agent stays on the conversation', () => {
    const trigger = triggerOf(message({ channel: 'dev' }), config)
    expect(trigger.threads).toEqual([{ source: 'im', id: 'dev' }])
    // A Trigger id is a hash of its source and message id, so it is stable without being guessable or ordered.
    expect(trigger.id).toHaveLength(32)
  })

  it('is the same Trigger however often the file is read', () => {
    const one = message()
    expect(triggerOf(one, config).id).toBe(triggerOf(one, config).id)
  })

  it('records a mention, a direct message, and neither', () => {
    expect(triggerOf(message({ text: '@agent fix this' }), config).addressed).toBe('mention')
    expect(triggerOf(message({ channel: 'dm-nocoo' }), config).addressed).toBe('direct')
    expect(triggerOf(message({ text: 'hello @agentic' }), config).addressed).toBeUndefined()
    expect(triggerOf(message({ text: 'hello' }), config).addressed).toBeUndefined()
  })

  it('marks a bot as not human, which stops it authorizing anything on its own', () => {
    expect(triggerOf(message({ kind: 'bot' }), config).human).toBe(false)
    expect(triggerOf(message(), config).human).toBe(true)
  })
})

describe('a channel scope', () => {
  it('observes only what the configuration names, plus direct messages', () => {
    expect(imKind.scope!({ meta: { channel: 'general' } }, config)).toMatchObject({ listened: true, observed: false, row: 'general' })
    expect(imKind.scope!({ meta: { channel: 'general' } }, { ...config, observed: ['general'] })).toMatchObject({ observed: true })
    expect(imKind.scope!({ meta: { channel: 'dm-nocoo' } }, config)).toMatchObject({ observed: true })
  })
})

describe('ingesting a channel', () => {
  /** A SourceContext that records what reaches the Engine and keeps the read position in a Map. */
  function harness(stateDir: string) {
    const received: Trigger[] = []
    const state = new Map<string, unknown>()
    const context = {
      stateDir,
      receive: (trigger: Trigger) => { received.push(trigger); return 'stored' as const },
      state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { state.set(key, value) }, keys: () => [] },
      report: () => {},
    } as unknown as SourceContext
    return { context, received, state }
  }

  it("drops the agent's own words, so it never answers itself", async () => {
    const root = stateDir()
    const store = new ImStore(root)
    store.append(message({ from: 'nocoo', text: '@agent do it' }))
    store.append(message({ from: 'agent', text: 'On it.', kind: 'bot' }))
    const { context, received } = harness(root)
    await readChannel(context, store, 'general', config)
    expect(received).toHaveLength(1)
    expect(received[0]!.actor.id).toBe('nocoo')
  })

  it('advances the read position, so a second pass ingests nothing', async () => {
    const root = stateDir()
    const store = new ImStore(root)
    store.append(message())
    const { context, received, state } = harness(root)
    await readChannel(context, store, 'general', config)
    await readChannel(context, store, 'general', config)
    expect(received).toHaveLength(1)
    expect(state.get(KV.im.offset('general'))).toBe(store.size('general'))
  })

  it('ingests what was appended after the last pass', async () => {
    const root = stateDir()
    const store = new ImStore(root)
    store.append(message({ text: 'first' }))
    const { context, received } = harness(root)
    await readChannel(context, store, 'general', config)
    store.append(message({ text: 'second' }))
    await readChannel(context, store, 'general', config)
    expect(received.map(trigger => trigger.text)).toEqual(['first', 'second'])
  })

  it('starts over when the file was replaced, rather than skipping what is there now', async () => {
    const root = stateDir()
    const store = new ImStore(root)
    store.append(message({ text: 'a much longer first message' }))
    const { context, received, state } = harness(root)
    await readChannel(context, store, 'general', config)
    writeFileSync(store.path('general'), `${JSON.stringify(message({ text: 'short' }))}\n`)
    await readChannel(context, store, 'general', config)
    expect(received.map(trigger => trigger.text)).toEqual(['a much longer first message', 'short'])
    expect(state.get(KV.im.offset('general'))).toBe(store.size('general'))
  })
})

describe('replying', () => {
  it('appends one message and is idempotent by message id', async () => {
    const root = stateDir()
    const store = new ImStore(join(root, 'im'))
    const outbound = { id: 'r1', text: 'Done.', kind: 'reply' as const,
      channel: { source: 'im', thread: 'general', address: { channel: 'general', agent: 'agent' } } }
    const send = imKind.channel!.send
    expect(await send({ stateDir: root, commands: {} as never }, outbound)).toBe('sent')
    expect(await send({ stateDir: root, commands: {} as never }, outbound)).toBe('sent')
    const messages = store.messages('general')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.kind).toBe('bot')
    expect(messages[0]!.text).toContain('Done.')
  })
})
