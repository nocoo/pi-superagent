/**
 * Probe: does a person's message reach a working worker *inside* its turn?
 *
 * The whole point of using a Pi session rather than a one-shot CLI is mid-turn steering: a correction should enter
 * after the current assistant turn and its tool calls, before the next model request. A follow-up would wait for the
 * run to settle, which is the wrong behaviour for a correction.
 *
 * This probe builds a real ticket, starts a real worker on a slow multi-step task, sends a correction while it works,
 * and then reports three independent kinds of evidence:
 *
 * 1. what the worker produced (did the correction change the outcome)
 * 2. where the correction sits in the Pi session file (before or after the run settled)
 * 3. the timing the Engine recorded for the delivered input
 *
 * Usage: pnpm build && node scripts/probe-steer.ts
 */
// eslint-disable-next-line
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host } from '../lib/runtime/host.js'
import { policyVersion, SettingsSchema } from '../lib/policy.js'
import type { Trigger } from '../lib/core/index.js'

const MODEL = process.env.PROBE_MODEL ?? 'magpie/group/coding'
const stateDir = join(mkdtempSync(join(tmpdir(), 'probe-steer-')), 'state')
const thread = { source: 'probe', id: 'p1' }
const person = { source: 'probe', id: 'alice' }

const settings = SettingsSchema.parse({
  policy: {
    // One rule so an explicit request is admissible without a rule catalogue to maintain here.
    rules: [{ id: 'demo', name: 'Probe task', enabled: true, instruction: 'Any request to create or change files in this directory.' }],
    sources: { probe: { allowed: [{ id: 'alice' }] } },
  },
  eval: { mode: 'auto', timeoutSeconds: 180, model: { provider: 'magpie', model: MODEL.split('/').slice(1).join('/') } },
  executor: { model: { provider: 'magpie', model: MODEL.split('/').slice(1).join('/') }, maxWorkers: 1, prepare: '' },
})

const host = new Host({ stateDir, deployment: { repository: 'probe/demo', github: { cli: 'gh', login: 'probe-agent', noreply: '' } } })
host.store.saveSettings(settings, { source: 'internal', block: 'policy', policyVersion: policyVersion(settings), policyChanged: false, notified: [] })

function trigger(id: string, text: string, at: string): Trigger {
  return { id, source: 'probe', threads: [thread], actor: person, human: true, addressed: 'mention', at, text,
    channel: { source: 'probe', thread: 'p1', address: { message: id } }, meta: {} }
}

const started = new Date()
const instructions = [
  'Work step by step. Create the files data/a.txt, data/b.txt, data/c.txt, data/d.txt, data/e.txt and data/f.txt,',
  'one at a time, each containing its own letter on a single line.',
  'After each file, run `sleep 5` before creating the next one. Do not create two files in one step.',
  'When all six exist, report ready.',
].join(' ')
const correction = 'Stop creating files. Only data/a.txt and data/b.txt are needed. Delete nothing, then report ready now.'

host.start()
host.engine.receive(trigger('t1', instructions, started.toISOString()))

/** Waits until `check` returns a value, or throws after `ms`. */
async function until<T>(what: string, check: () => T | undefined, ms = 240_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

const ticket = await until('the ticket', () => {
  const decided = host.store.read.recentDecisions(0, 5).find(item => item.threadKey === 'probe:p1')
  if (decided && decided.kind !== 'accept') {
    throw new Error(`The assessment ended as ${decided.kind}: ${JSON.stringify(decided.reason)}`)
  }
  return host.store.tickets.list()[0]
})
console.log(`ticket ${ticket.id} accepted after ${Date.now() - started.getTime()} ms`)
await until('the worker to start', () => host.store.tickets.get(ticket.id)?.assignments.some(item => item.report) || undefined, 180_000)
  .catch(() => undefined)

// Wait until the worker is visibly working, then correct it.
await new Promise(resolve => setTimeout(resolve, 8000))
const sentAt = new Date()
host.engine.receive(trigger('t2', correction, sentAt.toISOString()))
console.log(`correction sent ${sentAt.getTime() - started.getTime()} ms in`)

const ended = await until('the ticket to end', () => { const now = host.store.tickets.get(ticket.id); return now?.ended ? now : undefined })
console.log(`ticket ended ${ended.ended!.at} as ${ended.ended!.outcome}`)

const work = join(stateDir, 'work')
const directory = ended.execution?.directory ?? work
const files = existsSync(join(directory, 'data')) ? readdirSync(join(directory, 'data')).sort() : []
const inputs = ended.inputs.map(input => input.kind === 'trigger'
  ? { id: input.id, trigger: input.triggerId, deliveredTo: input.deliveredTo, readAt: input.readAt }
  : { id: input.id, kind: input.kind })

console.log('\n=== evidence 1: what the worker produced ===')
console.log('files in data/:', files.length ? files.join(' ') : '(none)')
console.log('correction honoured:', files.every(name => ['a.txt', 'b.txt'].includes(name)) && files.length > 0)

console.log('\n=== evidence 2: where the correction sits in the session ===')
const session = join(stateDir, 'sessions', `worker-${ticket.id}.jsonl`)
if (!existsSync(session)) console.log('no session file at', session)
else {
  const entries = readFileSync(session, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  const kinds = entries.filter(entry => entry.type === 'message').map(entry => {
    const message = entry.message as { role?: string; content?: unknown } | undefined
    const parts = Array.isArray(message?.content) ? message.content as Array<{ type?: string; text?: string; name?: string }> : []
    const tools = parts.filter(part => part.type === 'toolCall').map(part => part.name).join(',')
    const text = parts.filter(part => part.type === 'text').map(part => part.text).join(' ')
      || (typeof message?.content === 'string' ? message.content : '')
    return `${message?.role ?? '?'}${tools ? `[${tools}]` : ''}${text.includes('Stop creating files') ? ' <<< CORRECTION' : ''}`
  })
  const at = kinds.findIndex(line => line.includes('CORRECTION'))
  console.log(`messages before the correction: ${at}`)
  console.log('turn shape:', kinds.join(' | ').slice(0, 1200))
  console.log('\nthe correction entered inside the run:', at > 0 && at < kinds.length - 1)
}

console.log('\n=== evidence 3: what the Engine recorded ===')
console.log(JSON.stringify(inputs, null, 2))
console.log('\nassignment:', JSON.stringify(ended.assignments.map(item => ({ state: item.state, report: item.report?.state }))))

await host.stop()
console.log('\nstate dir:', stateDir)
