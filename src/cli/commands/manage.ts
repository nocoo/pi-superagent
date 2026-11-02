import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Store } from '../../store/store.ts'
import { sourceRegistry } from '../../sources/builtins.ts'
import { requestControl, ControlError, type ControlRequest } from '../../runtime/control.ts'
import { saveSettings } from '../../runtime/settings.ts'
import { Prompts, PromptConfigSchema, composePrompts } from '../../runtime/prompts.ts'
import { KV } from '../../kv.ts'
import { readInboxReplies, InboxEventSchema } from '../../sources/inbox.ts'
import { openForRead, resolveId } from '../context.ts'
import { CliError } from '../errors.ts'
import { emit, line, type Cli } from '../output.ts'
import { findTicket } from './ticket.ts'

export async function sourceReceive(cli: Cli, options: { file: string }): Promise<void> {
  const payload = InboxEventSchema.parse(readJson(options.file))
  const result = await requestControl(cli.stateDir, { action: 'source.receive', payload })
  emit(cli, 'source receive', result, () => line(JSON.stringify(result, null, 2)))
}

export function sourceReplies(cli: Cli, options: { system?: string; limit: number }): void {
  const store = openForRead(cli)
  store.close()
  const replies = readInboxReplies(cli.stateDir, options)
  emit(cli, 'source replies', { replies }, () => line(JSON.stringify(replies, null, 2)))
}

export async function writeInstance(cli: Cli, request: ControlRequest): Promise<unknown> {
  mkdirSync(cli.stateDir, { recursive: true, mode: 0o700 })
  let release: () => void
  try { release = lockSync(cli.stateDir, { stale: 30_000 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return requestControl(cli.stateDir, request)
    throw error
  }
  let store: Store | undefined
  try {
    store = new Store(join(cli.stateDir, 'superagent.sqlite'))
    const args = request.payload as { value?: unknown; baseRevision: number; revision?: number }
    if (request.action === 'settings.save') return saveSettings(store, sourceRegistry(() => store!.settings()), args.value, args.baseRevision)
    const prompts = new Prompts(store)
    if (request.action === 'prompts.save') return prompts.save(args.value, args.baseRevision)
    if (request.action === 'prompts.restore') return prompts.restore(args.revision!, args.baseRevision)
    throw new ControlError('not_running', 'Start the instance with run before managing its work')
  } finally { store?.close(); release() }
}

export async function intervention(cli: Cli, action: string, id: string, options: { reason?: string; text?: string; trigger?: string; note?: string }): Promise<void> {
  const store = openForRead(cli)
  let resolved = id
  let trigger = options.trigger
  try {
    if (action.startsWith('ticket.')) resolved = findTicket(store, id).id
    if (action.startsWith('trigger.')) resolved = resolveId(id, store.read.triggersByPrefix(id), item => item.id, 'trigger').id
    if (action.startsWith('decision.')) {
      const records = store.read.decisions({ kinds: [], since: '' }, 0, 100_000).items
      resolved = resolveId(id, records, item => item.id, 'decision').id
    }
    if (trigger) trigger = resolveId(trigger, store.read.triggersByPrefix(trigger), item => item.id, 'trigger').id
  } finally { store.close() }
  const payload = { id: resolved, ...options.reason ? { reason: options.reason } : {}, ...options.text ? { text: options.text } : {},
    ...trigger ? { trigger } : {}, ...options.note ? { note: options.note } : {} }
  const result = await requestControl(cli.stateDir, { action, payload })
  emit(cli, action.replace('.', ' '), result, () => line(JSON.stringify(result, null, 2)))
}

export function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8')) }
  catch (error) { throw new CliError('usage', `Cannot read JSON: ${error instanceof Error ? error.message : String(error)}`) }
}

export function promptShow(cli: Cli, options: { revision?: number }): void {
  const store = openForRead(cli)
  try {
    const prompts = new Prompts(store)
    const result = options.revision === undefined ? prompts.current() : prompts.get(options.revision)
    emit(cli, 'prompt show', result, () => line(JSON.stringify(result, null, 2)))
  } finally { store.close() }
}
export function promptHistory(cli: Cli): void {
  const store = openForRead(cli)
  try { emit(cli, 'prompt history', { versions: new Prompts(store).history() }, () => line(JSON.stringify(new Prompts(store).history(), null, 2))) }
  finally { store.close() }
}
export function promptPreview(cli: Cli, options: { file: string }): void {
  const config = PromptConfigSchema.parse(readJson(options.file))
  const result = { prompts: composePrompts(config) }
  emit(cli, 'prompt preview', result, () => line(JSON.stringify(result, null, 2)))
}
export async function promptSet(cli: Cli, options: { file: string; baseRevision: number }): Promise<void> {
  const value = PromptConfigSchema.parse(readJson(options.file))
  const result = await writeInstance(cli, { action: 'prompts.save', payload: { value, baseRevision: options.baseRevision } })
  emit(cli, 'prompt set', result, () => line(JSON.stringify(result, null, 2)))
}
export async function promptRestore(cli: Cli, revision: number, options: { baseRevision: number }): Promise<void> {
  const result = await writeInstance(cli, { action: 'prompts.restore', payload: { revision, baseRevision: options.baseRevision } })
  emit(cli, 'prompt restore', result, () => line(JSON.stringify(result, null, 2)))
}
export async function configImport(cli: Cli, options: { file: string; baseRevision: number }): Promise<void> {
  const result = await writeInstance(cli, { action: 'settings.save', payload: { value: readJson(options.file), baseRevision: options.baseRevision } })
  emit(cli, 'config import', result, () => line(JSON.stringify(result, null, 2)))
}
export function configHistory(cli: Cli): void {
  const store = openForRead(cli)
  try { const versions = store.settingsHistory(); emit(cli, 'config history', { versions }, () => line(JSON.stringify(versions, null, 2))) }
  finally { store.close() }
}
export function search(cli: Cli, query: string): void {
  const store = openForRead(cli)
  try {
    const term = query.toLowerCase()
    const triggers = store.read.search(query)
    const tickets = store.tickets.list().filter(ticket => ticket.id.startsWith(query) || ticket.title.toLowerCase().includes(term)).slice(0, 50)
    const threads = store.threads.list().filter(thread => thread.key.includes(query) || String(thread.meta.label ?? '').toLowerCase().includes(term)).slice(0, 50)
    const result = { triggers, tickets, threads }
    emit(cli, 'search', result, () => line(JSON.stringify(result, null, 2)))
  } finally { store.close() }
}
export function coordinatorRead(cli: Cli, options: { lines: number }, show = false): void {
  const store = openForRead(cli)
  try {
    const file = join(cli.stateDir, 'sessions', 'coordinator.jsonl')
    const entries = existsSync(file) ? readFileSync(file, 'utf8').split('\n').flatMap(text => {
      if (!text.trim()) return []
      try { return [JSON.parse(text) as { type: string; message?: unknown }] } catch { return [] }
    }) : []
    const result = show ? { sessionFile: file, exists: existsSync(file), messages: entries.filter(entry => entry.type === 'message').length,
      settingsRevision: store.get(KV.settings.revision) ?? 0, promptRevision: new Prompts(store).current().revision }
      : { messages: entries.filter(entry => entry.type === 'message').slice(-options.lines).map(entry => entry.message) }
    emit(cli, show ? 'coordinator show' : 'coordinator read', result, () => line(JSON.stringify(result, null, 2)))
  } finally { store.close() }
}
