import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import type { SourceKind } from './kind.ts'

const SOURCE = 'inbox'
const SYSTEM_MAX = 64
const ID_MAX = 200
const URL_MAX = 2048
const TEXT_MAX = 20_000

export const InboxEventSchema = z.object({
  system: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, `system must be a slug of at most ${SYSTEM_MAX} characters`).max(SYSTEM_MAX),
  id: z.string().trim().min(1).max(ID_MAX),
  thread: z.string().trim().min(1).max(ID_MAX),
  actor: z.string().trim().min(1).max(ID_MAX).regex(/^[^\s]+$/, 'actor must not contain whitespace'),
  text: z.string().trim().min(1).max(TEXT_MAX),
  human: z.boolean().optional(),
  addressed: z.boolean().optional(),
  url: z.string().max(URL_MAX).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
}).strict()

export type InboxEvent = z.infer<typeof InboxEventSchema>

export function inboxTrigger(value: unknown): Trigger {
  const event = InboxEventSchema.parse(value)
  const human = event.human ?? true
  const trigger: Trigger = {
    id: key(SOURCE, event.system, event.id),
    source: SOURCE,
    threads: [{ source: SOURCE, id: `${event.system}:${event.thread}` }],
    actor: { source: SOURCE, id: `${event.system}:${event.actor}` },
    human,
    ...(event.addressed ?? true ? { addressed: 'mention' as const } : {}),
    at: new Date().toISOString(),
    text: event.text,
    channel: {
      source: SOURCE,
      thread: `${event.system}:${event.thread}`,
      address: { system: event.system, thread: event.thread, event: event.id },
    },
    ...(event.url !== undefined ? { url: event.url } : {}),
    meta: {
      ...(event.meta ?? {}),
      system: event.system,
      nativeThread: event.thread,
      nativeEvent: event.id,
    },
  }
  return trigger
}

const InboxConfigSchema = z.object({
  observed: z.array(z.string().min(1).max(SYSTEM_MAX)).default([]),
}).strict()

type InboxConfig = z.infer<typeof InboxConfigSchema>

export const inboxKind: SourceKind<InboxConfig> = {
  kind: SOURCE,
  title: { zh: '通用收件箱', en: 'Inbox' },
  description: {
    zh: '从外部 IM、工单或脚本接收标准事件；不建立后台网络连接。',
    en: 'Receives standard events from external messaging, ticketing systems, or scripts; has no background network loop.',
  },
  schema: InboxConfigSchema,
  health: [SOURCE],
  scope: ({ meta }, config) => {
    const system = typeof meta.system === 'string' ? meta.system : ''
    return {
      listened: true,
      observed: config.observed.includes('*') || config.observed.includes(system),
      row: system,
    }
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({
        id: z.string().trim().min(1).max(ID_MAX).refine(id => !/\s/.test(id), 'allowed id must not contain whitespace'),
        name: z.string().trim().min(1).max(100).optional(),
      }).strict()).default([]),
    }).strict(),
  },
  channel: {
    send: async (host, message) => {
      const system = message.channel.address.system
      const thread = message.channel.address.thread
      const event = message.channel.address.event
      if (!system || !thread || !event) throw new Error('the inbox reply has no system, thread, or event address')

      const root = join(host.stateDir, SOURCE)
      mkdirSync(root, { recursive: true, mode: 0o700 })
      chmodSync(root, 0o700)
      const file = join(root, 'replies.jsonl')

      let already = false
      if (existsSync(file)) {
        for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
          if (!line.trim()) continue
          try {
            const stored = JSON.parse(line) as { id?: unknown }
            if (stored.id === message.id) already = true
          } catch { /* Skip malformed history; new writes must still proceed. */ }
        }
        chmodSync(file, 0o600)
      }
      if (!already) {
        const row = {
          id: message.id,
          system,
          thread,
          event,
          text: message.text,
          ...(message.ticketId ? { ticketId: message.ticketId } : {}),
          at: new Date().toISOString(),
        }
        appendFileSync(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 })
        chmodSync(file, 0o600)
      }
      return 'sent'
    },
  },
  start: (host) => {
    const ctx = host.context(inboxKind)
    ctx.report(SOURCE, { state: 'ready', detail: 'External events arrive through the runtime IPC; no background loop', at: new Date().toISOString() })
    return () => {}
  },
}

export interface InboxReply {
  id: string
  system: string
  thread: string
  event: string
  text: string
  ticketId?: string
  at: string
}

export function readInboxReplies(stateDir: string, options: { system?: string; limit?: number } = {}): InboxReply[] {
  const root = join(stateDir, SOURCE)
  const file = join(root, 'replies.jsonl')
  if (!existsSync(file)) return []

  const rows: InboxReply[] = []
  const seen = new Set<string>()
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as Record<string, unknown>
      if (typeof value.id !== 'string' || typeof value.system !== 'string' || typeof value.thread !== 'string'
        || typeof value.event !== 'string' || typeof value.text !== 'string' || typeof value.at !== 'string') continue
      if (options.system && value.system !== options.system) continue
      if (seen.has(value.id)) continue
      seen.add(value.id)
      rows.push({
        id: value.id,
        system: value.system,
        thread: value.thread,
        event: value.event,
        text: value.text,
        ...(typeof value.ticketId === 'string' ? { ticketId: value.ticketId } : {}),
        at: value.at,
      })
    } catch { /* Ignore malformed external lines. */ }
  }

  if (typeof options.limit === 'number' && Number.isFinite(options.limit)) {
    const limit = Math.max(0, Math.floor(options.limit))
    return limit === 0 ? [] : rows.slice(-limit)
  }
  return rows
}
