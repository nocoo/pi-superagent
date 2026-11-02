import { z } from 'zod'
import type { Ticket, Trigger } from '../core/index.ts'
import { LookupError, resolveId } from '../infra/identifiers.ts'
import { threadKey } from '../core/index.ts'
import type { Deployment } from '../config.ts'
import { Commands } from '../infra/commands.ts'
import type { Store } from '../store/store.ts'

export function resolveTrigger(store: Pick<Store, 'triggers' | 'read'>, prefix: string): Trigger {
  const exact = store.triggers.get(prefix)
  if (exact) return exact
  try { return resolveId(prefix, store.read.triggersByPrefix(prefix, 2), item => item.id, 'trigger') }
  catch (error) {
    if (error instanceof LookupError && error.code === 'not_found') {
      const available = store.read.recentTriggers(0, 8).map(item => item.id.slice(0, 8)).join(', ')
      throw new LookupError('not_found', `${error.message}. Recent trigger IDs: ${available}`)
    }
    throw error
  }
}

export function resolveTicket(store: Pick<Store, 'tickets'>, prefix: string): Ticket {
  return store.tickets.get(prefix) ?? resolveId(prefix, store.tickets.list(), item => item.id, 'ticket')
}

export const CONTEXT_PAGE_CHARS = 4000

export function textPage(resource: string, body: string, offset: number, limit = CONTEXT_PAGE_CHARS): unknown {
  const safeOffset = Math.max(0, offset)
  const safeLimit = Math.max(1, Math.min(limit, 8000))
  const text = body.slice(safeOffset, safeOffset + safeLimit)
  return {
    resource,
    text,
    offset: safeOffset,
    chars: text.length,
    next_offset: safeOffset + text.length < body.length ? safeOffset + text.length : undefined,
  }
}

export function triggerContext(store: Pick<Store, 'read' | 'threads' | 'triggers'>, triggerId: string) {
  const trigger = store.triggers.get(triggerId)
  if (!trigger) throw new Error(`Unknown trigger: ${triggerId}`)
  const key = trigger.threads[0] ? threadKey(trigger.threads[0]) : ''
  const window = key ? store.read.threadTriggers(key, 12) : [trigger]
  const root = key ? store.read.firstTrigger(key) : trigger
  const neighbours = key ? store.read.neighbours(key, trigger.at, trigger.id) : {}
  return { trigger, key, window, root, parent: neighbours.before, next: neighbours.after }
}

export function threadPage(store: Pick<Store, 'read'>, thread: string, offset = 0, limit = 12) {
  const size = Math.max(1, Math.min(limit, 100))
  const items = store.read.threadPage(thread, offset, size + 1)
  return { items: items.slice(0, size), offset, next_offset: items.length > size ? offset + size : undefined }
}

export async function readGithubThread(deployment: Deployment, number: number, offset = 0, limit = 12, signal?: AbortSignal): Promise<unknown> {
  const commands = new Commands(() => deployment, {}, signal ?? new AbortController().signal)
  const message = z.looseObject({ id: z.number(), body: z.string().nullish(), created_at: z.string().nullish(), submitted_at: z.string().nullish() })
  const root = await commands.api(message.extend({ title: z.string(), pull_request: z.unknown().optional() }), `issues/${number}`)
  const conversation = await commands.pages(message, `issues/${number}/comments?per_page=100`)
  const reviews = root.pull_request ? await commands.pages(message, `pulls/${number}/reviews?per_page=100`) : []
  const inline = root.pull_request ? await commands.pages(message, `pulls/${number}/comments?per_page=100`) : []
  const items = [
    ...conversation.map(item => ({ ...item, kind: 'conversation' })),
    ...reviews.map(item => ({ ...item, kind: 'review' })),
    ...inline.map(item => ({ ...item, kind: 'inline' })),
  ].sort((a, b) => (a.created_at ?? a.submitted_at ?? '').localeCompare(b.created_at ?? b.submitted_at ?? ''))
  const size = Math.max(1, Math.min(limit, 100))
  const page = items.slice(offset, offset + size)
  return { ...offset === 0 ? { root } : {}, items: page, offset, next_offset: offset + size < items.length ? offset + size : undefined }
}

export async function readRepositoryPath(deployment: Deployment, path: string, kind: 'file' | 'directory', signal?: AbortSignal) {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.includes('..')) throw new Error('Repository paths cannot traverse parent directories')
  const clean = parts.map(encodeURIComponent).join('/')
  if (!deployment.repository) throw new Error('This deployment has no GitHub repository')
  const commands = new Commands(() => deployment, {}, signal ?? new AbortController().signal)
  const result = await commands.api(`contents/${clean}`)
  if (kind === 'directory') {
    const parsed = z.array(z.looseObject({ name: z.string(), type: z.string(), path: z.string() })).safeParse(JSON.parse(result))
    if (!parsed.success) throw new Error('GitHub returned an invalid directory listing')
    return parsed.data.map(item => ({ name: item.name, type: item.type, path: item.path }))
  }
  const file = z.looseObject({ type: z.string(), encoding: z.string().optional(), content: z.string().optional(), download_url: z.string().nullish() }).parse(JSON.parse(result))
  if (file.encoding === 'base64' && file.content) {
    return Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8')
  }
  throw new Error('GitHub returned an unsupported repository file')
}
