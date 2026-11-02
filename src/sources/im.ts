/**
 * A local IM Source: channels on this machine, held as append-only JSONL files.
 *
 * It is the Source for watching a conversation rather than an issue tracker. One channel is one Thread, which is what
 * makes an agent able to stay on a channel: once a Ticket subscribes, every later message in the channel reaches it, and
 * a person's correction steers the turn that is already running.
 *
 * The agent's own messages are dropped before they reach the domain, and every Trigger id is derived from the message
 * id, so re-reading a file can never open a second Ticket.
 */
import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { ImStore, readLines, checkChannel, type ImMessage } from '../im/store.ts'
import type { Health, SourceContext, SourceHost } from './host.ts'
import type { SourceKind } from './kind.ts'

const SOURCE = 'im'
/** The name a person addresses to reach the agent in a channel. */
const AGENT = 'agent'
/** How often a channel is re-read even when the watcher stays quiet; the watcher alone is not reliable across editors. */
const POLL_MS = 2_000

const ConfigSchema = z.object({
  /** The account the agent speaks as here, so its own messages are dropped. */
  agent: z.string().min(1).default(AGENT),
  /** Channels to watch. Empty watches every channel that exists, which is what `chat` creates. */
  channels: z.array(z.string()).default([]),
  /** Channels that receive every message, so the admission table sees unaddressed ones too. */
  observed: z.array(z.string()).default([]),
}).strict()
type Config = z.infer<typeof ConfigSchema>

/** True when `text` addresses the agent, as `@agent` on a word boundary. */
const addressed = (text: string, agent: string): boolean =>
  new RegExp(`(^|\\s)@${agent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(text)

/** Loose channels: a message in one is `observed`, so an unaddressed message can become an inferred candidate. */
const dm = (channel: string): boolean => channel.startsWith('dm-')

/** Builds the Trigger for one message: the whole of the Source's translation step. */
export function triggerOf(message: ImMessage, config: Config): Trigger {
  const mention = addressed(message.text, config.agent)
  const direct = dm(message.channel)
  return {
    id: key(SOURCE, message.id),
    source: SOURCE,
    // One channel is one Thread: the agent stays on the conversation rather than on a single message.
    threads: [{ source: SOURCE, id: message.channel }],
    actor: { source: SOURCE, id: message.from },
    human: message.kind !== 'bot',
    ...mention ? { addressed: 'mention' as const } : direct ? { addressed: 'direct' as const } : {},
    at: message.at,
    text: message.text,
    channel: { source: SOURCE, thread: message.channel,
      address: { channel: message.channel, message: message.id, agent: config.agent } },
    meta: { channel: message.channel, messageId: message.id, ...message.replyTo ? { replyTo: message.replyTo } : {} },
  }
}

/** Reads a channel's new messages and hands each to the Engine before advancing the read position. */
export async function readChannel(ctx: SourceContext, store: ImStore, channel: string, config: Config): Promise<number> {
  const path = store.path(channel)
  let buffer: Buffer
  try { buffer = readFileSync(path) } catch { return 0 }
  const stored = ctx.state.get(KV.im.offset(channel)) ?? 0
  // A file that shrank was replaced or truncated; start over rather than skip what is there now.
  const offset = stored > buffer.length ? 0 : stored
  const { lines, offset: next } = readLines(buffer, offset)
  const agent = config.agent.toLowerCase()
  for (const line of lines) {
    let message: ImMessage
    try { message = JSON.parse(line) as ImMessage } catch { continue }
    if (!message.id || !message.from) continue
    // The agent's own words are not a request; reading them back is how an agent ends up answering itself.
    if (message.from.toLowerCase() === agent) continue
    await ctx.receive(triggerOf(message, config))
  }
  if (next !== stored) ctx.state.set(KV.im.offset(channel), next)
  return lines.length
}

export const imKind: SourceKind<Config> = {
  kind: SOURCE,
  title: { zh: '本地 IM', en: 'Local IM' },
  description: {
    zh: '本机上的频道，每条消息一行 JSON。一个频道就是一条线程，所以智能体能一直盯着一个频道，看见问题就去做。',
    en: 'Channels on this machine, one JSON message per line. A channel is a Thread, so an agent can stay on a conversation and act on what it finds.',
  },
  schema: ConfigSchema,
  health: [SOURCE],
  // A channel listens to everything written in it; whether an unaddressed message becomes a candidate is the admission
  // table's decision, so `observed` is reported for the channels the configuration names.
  scope: ({ meta }, config) => config.channels.length && !config.channels.includes(String(meta.channel))
    ? { listened: false, reason: 'channel_not_listened' }
    : { listened: true, observed: config.observed.includes(String(meta.channel)) || config.observed.includes('*') || dm(String(meta.channel)),
      row: String(meta.channel ?? 'channel') },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9._-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9._-]+$/) }).strict()).optional(),
    }).strict(),
  },
  channel: {
    // A reply is one appended message. The id makes a retried send a no-op instead of a duplicate line.
    send: async (host, message) => {
      const store = new ImStore(join(host.stateDir, 'im'))
      const channel = message.channel.address.channel
      if (!channel) throw new Error('the IM reply has no channel')
      const already = store.messages(channel).some(item => item.text.includes(`<!-- ${message.id} -->`))
      if (already) return 'sent'
      store.append({
        id: `a-${message.id}`,
        channel,
        from: String(message.channel.address.agent ?? AGENT),
        at: new Date().toISOString(),
        text: `${message.text}\n<!-- ${message.id} -->`,
        kind: 'bot',
      })
      return 'sent'
    },
  },
  start(host: SourceHost, instance) {
    const ctx = host.context(imKind)
    const config = instance.config
    const store = new ImStore(join(ctx.stateDir, 'im'))
    store.ensure()

    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let watcher: FSWatcher | undefined

    const watched = (): string[] => {
      const all = store.channels()
      return config.channels.length ? config.channels.filter(channel => all.includes(channel)) : all
    }

    /** One pass over every channel; a failure in one channel is reported without stopping the others. */
    const pass = async (): Promise<void> => {
      if (stopped) return
      let read = 0
      const problems: string[] = []
      for (const channel of watched()) {
        if (stopped) return
        try { read += await readChannel(ctx, store, channel, config) }
        catch (error) { problems.push(`${channel}: ${error instanceof Error ? error.message : String(error)}`) }
      }
      const state: Health = problems.length
        ? { state: 'error', detail: problems.join(' · '), at: new Date().toISOString() }
        : { state: 'ready', detail: `${watched().length} channel(s) · ${read} new this pass`, at: new Date().toISOString() }
      ctx.report(SOURCE, state)
      if (!stopped) timer = setTimeout(() => void pass(), POLL_MS)
    }

    // The watcher is a latency optimisation; the timer is what guarantees delivery, because a rename-based save can
    // report an event for a path that has already been replaced.
    try {
      watcher = watch(store.root, () => { void pass() })
      watcher.on('error', () => { watcher?.close(); watcher = undefined })
    } catch { /* A directory that cannot be watched is still polled. */ }
    void pass()

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      watcher?.close()
    }
  },
}

export { AGENT, checkChannel }
