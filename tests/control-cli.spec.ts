import { afterEach, expect, it } from 'vitest'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store/store.ts'
import { SettingsSchema, policyVersion } from '../src/policy.ts'
import { packageRoot } from '../src/prompts.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'

const exec = promisify(execFile)
const roots: string[] = []
const children: ChildProcess[] = []
const executable = join(packageRoot(), 'lib', 'cli.js')
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      child.once('close', () => { clearTimeout(timer); resolve() })
      child.kill('SIGTERM')
    })
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('runs operator, prompt, source and configuration commands through the live owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sa-cli-'))
  roots.push(root)
  const state = join(root, 'state')
  const cli = async (args: string[]) => {
    const result = await exec(process.execPath, [executable, '--state-dir', state, '--json', ...args], { timeout: 20_000, env: { ...process.env, NODE_NO_WARNINGS: '1' } })
    return JSON.parse(result.stdout).result
  }
  await cli(['config', 'set', '--im', '--im-allowed', 'alice', '--inbox', '--inbox-allowed', 'helpdesk:alice', '--pause'])
  const store = new Store(join(state, 'superagent.sqlite'))
  const settings = store.settings()
  const trigger: Trigger = { id: 'a'.repeat(32), source: 'im', threads: [{ source: 'im', id: 'operator-test' }], actor: { source: 'im', id: 'alice' },
    human: true, addressed: 'mention', text: 'Write a summary', at: '2026-01-01T00:00:00.000Z', meta: { channel: 'operator-test' },
    channel: { source: 'im', thread: 'operator-test', address: { channel: 'operator-test' } } }
  const ticket: Ticket = { id: 'b'.repeat(32), title: 'Summarize', decisionId: 'accepted', createdAt: trigger.at, updatedAt: trigger.at,
    mandate: { strength: 'explicit', policyVersion: policyVersion(settings), actor: trigger.actor, scope: 'Summarize',
      basis: { via: 'addressed', addressed: 'mention', rules: ['copy'] } },
    channels: [trigger.channel!], origin: { triggerId: trigger.id, triggerIds: [trigger.id] }, inputs: [], undelivered: [],
    assignments: [{ id: 'assignment-one', state: 'running', createdAt: trigger.at, report: { state: 'blocked', summary: 'Which period?', at: trigger.at } }],
    attention: { id: 'question', question: 'Which period?' } }
  store.triggers.save(trigger)
  store.triggers.saveDisposition(trigger.id, { fanout: [], at: trigger.at })
  store.threads.save({ key: 'im:operator-test', ref: trigger.threads[0]!, createdAt: trigger.at, subscriptions: [ticket.id], correlated: [], pending: [], meta: {} })
  store.tickets.save(ticket)
  store.close()

  const runtime = spawn(process.execPath, [executable, '--state-dir', state, 'run'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } })
  children.push(runtime)
  let errors = ''
  runtime.stderr!.on('data', chunk => { errors += chunk.toString() })
  runtime.stdout!.resume()
  let ready = false
  for (let attempt = 0; attempt < 20; attempt++) {
    if (runtime.exitCode !== null) throw new Error(errors)
    if ((await cli(['status'])).running) { ready = true; break }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  expect(ready, errors).toBe(true)

  const before = await cli(['config', 'show'])
  const next = SettingsSchema.parse(before.settings)
  next.policy.rules[0]!.instruction = 'Use the updated terminology'
  const settingsFile = join(root, 'settings.json')
  writeFileSync(settingsFile, JSON.stringify(next))
  const saved = await cli(['config', 'import', '--file', settingsFile, '--base-revision', String(before.revision)])
  expect(saved.notified).toEqual([ticket.id])
  expect((await cli(['ticket', 'show', ticket.id])).ticket.inputs).toContainEqual(expect.objectContaining({ kind: 'policy-changed' }))
  await expect(cli(['config', 'import', '--file', settingsFile, '--base-revision', String(before.revision)])).rejects.toMatchObject({ stderr: expect.stringContaining('conflict') })

  await cli(['ticket', 'answer', ticket.id, '--text', 'Use March'])
  expect((await cli(['ticket', 'show', ticket.id])).ticket.inputs).toContainEqual(expect.objectContaining({ human: true }))
  await cli(['ticket', 'stop', ticket.id, '--reason', 'Operator decided'])
  expect((await cli(['ticket', 'show', ticket.id])).ticket.ended).toMatchObject({ by: 'human', outcome: 'stopped' })

  const prompt = await cli(['prompt', 'show'])
  prompt.config.shared = 'Return concise results'
  const promptFile = join(root, 'prompts.json')
  writeFileSync(promptFile, JSON.stringify(prompt.config))
  expect((await cli(['prompt', 'set', '--file', promptFile, '--base-revision', String(prompt.revision)])).revision).toBe(1)
  expect((await cli(['prompt', 'restore', '0', '--base-revision', '1'])).revision).toBe(2)

  const eventFile = join(root, 'event.json')
  writeFileSync(eventFile, JSON.stringify({ system: 'helpdesk', id: 'event-1', thread: 'case-1', actor: 'alice', text: 'Summarize this case' }))
  expect((await cli(['source', 'receive', '--file', eventFile])).received).toBe('stored')
  expect((await cli(['source', 'receive', '--file', eventFile])).received).toBe('duplicate')
  expect((await cli(['thread', 'show', 'inbox:helpdesk:case-1'])).thread.ref.source).toBe('inbox')
}, 45_000)
