import assert from 'node:assert/strict'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, createWriteStream } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = join(repository, 'lib', 'cli.js')
const root = join(repository, '.local', `live-${Date.now().toString(36)}`)
const stateDir = join(root, 'state')
const agentDir = join(root, 'pi')
const endpoint = process.env.PI_SUPERAGENT_TEST_ENDPOINT ?? 'http://127.0.0.1:3425'
const model = process.env.PI_SUPERAGENT_TEST_MODEL ?? 'group/coding'
mkdirSync(agentDir, { recursive: true })
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { local: {
  baseUrl: `${endpoint.replace(/\/$/, '')}/v1`, api: 'openai-completions', apiKey: 'local',
  models: [{ id: model, name: model, reasoning: true, input: ['text', 'image'], contextWindow: 128000, maxTokens: 8192 }],
} } }, null, 2))
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'local', defaultModel: model, defaultThinkingLevel: 'high',
  defaultProjectTrust: 'always', cacheWarming: 'off', enableInstallTelemetry: false, enableAnalytics: false }))
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, NODE_NO_WARNINGS: '1' }
const results: { check: string; evidence: unknown }[] = []
let runtime: ChildProcess | undefined

async function cli<T = Record<string, unknown>>(args: string[], input?: unknown): Promise<T> {
  if (input === undefined) {
    const { stdout } = await exec(process.execPath, [cliPath, '--state-dir', stateDir, '--json', ...args],
      { cwd: root, env, timeout: 25_000, maxBuffer: 8 * 1024 * 1024 })
    return JSON.parse(stdout).result as T
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, '--state-dir', stateDir, '--json', ...args], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { errors += chunk })
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI input command timed out')) }, 25_000)
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', code => {
      clearTimeout(timeout)
      if (code !== 0) { reject(new Error(errors || output)); return }
      try { resolve(JSON.parse(output).result as T) } catch (error) { reject(error) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(input))
  })
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until<T>(label: string, read: () => Promise<T | undefined | false>, timeout = 180_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await delay(800)
  }
  throw new Error(`Timed out: ${label}. Inspect ${root}`)
}
interface Ticket { id: string; title: string; stage: string; ended?: { outcome: string }; attention?: { question: string };
  assignments: { report?: { state: string; summary: string } }[]; channels: { source: string; thread: string }[]; execution: { directory: string } }
async function tickets(): Promise<Ticket[]> { return (await cli<{ tickets: Ticket[] }>(['ticket', 'list', '--all'])).tickets }
async function ticketOn(channel: string): Promise<Ticket | undefined> {
  const task = (await tickets()).find(ticket => ticket.channels.some(item => item.thread === channel))
  if (!task) {
    const decisions = await cli<{ decisions: { threadKey: string; kind: string; reason: unknown }[] }>(['decision', 'list', '--since', '24h'])
    const refused = decisions.decisions.find(decision => decision.threadKey.endsWith(`:${channel}`) && ['ignore', 'unavailable'].includes(decision.kind))
    if (refused) throw new Error(`The coordinator did not accept ${channel}: ${JSON.stringify(refused)}`)
  }
  return task
}
async function completed(channel: string): Promise<Ticket> {
  return until(`task ${channel} completes`, async () => {
    const ticket = await ticketOn(channel)
    if (ticket?.assignments.at(-1)?.report?.state === 'failed') throw new Error(`Task failed: ${JSON.stringify(ticket)}`)
    if (ticket?.ended && ticket.ended.outcome !== 'completed') throw new Error(`Task did not complete: ${JSON.stringify(ticket)}`)
    return ticket?.ended?.outcome === 'completed' && ticket
  })
}
async function send(channel: string, text: string): Promise<void> { await cli(['chat', channel, '--as', 'alice', '--send', text]) }
function recorded(check: string, evidence: unknown): void {
  results.push({ check, evidence })
  writeFileSync(join(root, 'results.json'), JSON.stringify({ endpoint, model, stateDir, results }, null, 2))
  process.stdout.write(`PASS ${check}\n`)
}
async function start(): Promise<void> {
  const log = createWriteStream(join(root, 'runtime.log'), { flags: 'a' })
  runtime = spawn(process.execPath, [cliPath, '--state-dir', stateDir, 'run', '--verbose'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  runtime.stdout!.pipe(log, { end: false })
  runtime.stderr!.pipe(log, { end: false })
  runtime.once('close', () => log.end())
  await until('runtime starts', async () => {
    if (runtime?.exitCode !== null) throw new Error(`Runtime exited; inspect ${join(root, 'runtime.log')}`)
    try { return (await cli<{ running: boolean }>(['status'])).running } catch { return false }
  }, 30_000)
}
async function stop(): Promise<void> {
  const child = runtime
  runtime = undefined
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.once('close', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop().finally(() => process.exit(1)) })
process.stdout.write(`Local acceptance evidence: ${root}\n`)
try {
  await cli(['config', 'set', '--im', '--im-allowed', 'alice', '--inbox', '--inbox-allowed', 'helpdesk:alice',
    '--model', `local/${model}`, '--assess-model', `local/${model}`, '--max-workers', '2'])
  const config = await cli<{ settings: { policy: { rules: unknown[] }; eval: { timeoutSeconds: number } }; revision: number }>(['config', 'show'])
  config.settings.policy.rules = []
  config.settings.eval.timeoutSeconds = 180
  await cli(['config', 'import', '--file', '-', '--base-revision', String(config.revision)], config.settings)
  const notes = join(root, 'operations-notes.txt')
  writeFileSync(notes, 'The support team needs a daily refund summary. The approved period is March. Duplicate cases should be grouped by customer. No software changes are needed.\n')
  await start()

  await send('writing', `@agent Read ${notes}. Write summary.md in your task directory with exactly three actionable bullet points about these operations notes. This is a writing task, not a coding task: do not use git or create a pull request. Report ready when the file is written.`)
  const writing = await completed('writing')
  const summary = readFileSync(join(writing.execution.directory, 'summary.md'), 'utf8')
  assert.match(summary, /refund|support|March/i)
  assert.equal(summary.split('\n').filter(line => /^\s*[-*]\s/.test(line)).length, 3)
  recorded('explicit non-coding task without any rule', { ticket: writing.id, directory: writing.execution.directory })

  await send('question', '@agent Draft a two-sentence customer reply about a refund. Before writing it, ask me whether the approved refund window is 7 or 30 days; do not choose it yourself. After my answer, write reply.txt in your task directory and report ready. Do not use GitHub.')
  const question = await until('worker asks the operator', async () => { const task = await ticketOn('question'); return task?.attention && task })
  await cli(['ticket', 'answer', question.id, '--text', 'The approved window is 30 days. Include the exact phrase "30-day refund window" in the reply.'])
  const answered = await completed('question')
  assert.match(readFileSync(join(answered.execution.directory, 'reply.txt'), 'utf8'), /30-day refund window/)
  recorded('structured human question and CLI answer', { ticket: answered.id })

  const event = { system: 'helpdesk', id: 'case-001-created', thread: 'case-001', actor: 'alice',
    text: 'Add the invoice amounts EUR 12 and EUR 30. Report the total as EUR 42 in your final result. This is an administrative calculation; no code, repository or PR is required.' }
  const received = await cli<{ received: string; trigger: string }>(['source', 'receive', '--file', '-'], event)
  assert.equal(received.received, 'stored')
  assert.equal((await cli<{ received: string }>(['source', 'receive', '--file', '-'], event)).received, 'duplicate')
  const external = await completed('helpdesk:case-001')
  const replies = await until('adapter receives the result', async () => {
    const rows = await cli<{ replies: { ticketId?: string; text: string }[] }>(['source', 'replies', '--system', 'helpdesk'])
    return rows.replies.some(reply => reply.ticketId === external.id && /42/.test(reply.text)) && rows.replies
  })
  recorded('generic external-system intake and local reply delivery', { ticket: external.id, trigger: received.trigger, replies })

  const prompts = await cli<{ revision: number; config: Record<string, string> }>(['prompt', 'show'])
  prompts.config.work += '\nFor this local acceptance run, append PROMPT-LIVE-VERIFIED to every report summary.\n'
  await cli(['prompt', 'set', '--file', '-', '--base-revision', String(prompts.revision)], prompts.config)
  await send('writing', '@agent Update the existing summary.md by appending the line "Reviewed by operations." Keep the three original bullets. Report ready after this same task is updated.')
  const resumed = await until('same task resumes with updated prompt', async () => {
    const task = await ticketOn('writing')
    return task?.id === writing.id && task.assignments.length >= 2 && task.ended?.outcome === 'completed'
      && task.assignments.at(-1)?.report?.summary.includes('PROMPT-LIVE-VERIFIED') && task
  })
  assert.match(readFileSync(join(resumed.execution.directory, 'summary.md'), 'utf8'), /Reviewed by operations/)
  recorded('live prompt revision and persistent worker resume', { ticket: resumed.id, assignments: resumed.assignments.length })

  await send('steering', '@agent Create first.txt containing one in your task directory. Then run sleep 8. Then create second.txt containing two, run sleep 8, and create third.txt containing three. Do not combine these steps into one command. Report ready only after the requested sequence is complete. No repository is involved.')
  const steering = await until('worker creates the first artifact', async () => {
    const task = await ticketOn('steering')
    return task && existsSync(join(task.execution.directory, 'first.txt')) && task
  })
  await send('steering', '@agent Correction: the requested output is now only first.txt. Do not create second.txt or third.txt. Report ready for this reduced task after the current command returns.')
  await completed('steering')
  assert.equal(existsSync(join(steering.execution.directory, 'second.txt')), false)
  assert.equal(existsSync(join(steering.execution.directory, 'third.txt')), false)
  recorded('mid-turn correction through the CLI', { ticket: steering.id })

  await send('stop', '@agent Prepare a travel recommendation, but first ask me which destination I want. Wait for my answer; do not choose a destination or finish the recommendation.')
  const waiting = await until('task waits before operator stop', async () => { const task = await ticketOn('stop'); return task?.attention && task })
  await cli(['ticket', 'stop', waiting.id, '--reason', 'Operator acceptance test'])
  const stopped = await cli<{ ticket: Ticket }>(['ticket', 'show', waiting.id])
  assert.equal(stopped.ticket.ended?.outcome, 'stopped')
  recorded('operator stop withdraws the task', { ticket: waiting.id })

  const observation = await cli<{ revision: number; settings: { sources: { im: { config: Record<string, unknown> } }; policy: { rules: unknown[] } } }>(['config', 'show'])
  observation.settings.sources.im.config.observed = ['observed']
  observation.settings.policy.rules = [{ id: 'notes', name: 'Summarize operations notes', enabled: true,
    instruction: 'When a person asks to summarize operations notes into a few action items, propose a bounded writing task. Read the named file and base the assessment on its actual contents. No coding is involved.' }]
  await cli(['config', 'import', '--file', '-', '--base-revision', String(observation.revision)], observation.settings)
  await send('observed', `Please summarize the operations notes at ${notes} into three actionable bullet points in a local summary.`)
  const observed = await until('proactive assessment records would_accept', async () => {
    const rows = await cli<{ decisions: { threadKey: string; kind: string; audit?: { would_accept?: boolean }; reason: unknown }[] }>(['decision', 'list', '--since', '24h'])
    const decision = rows.decisions.find(item => item.threadKey === 'im:observed')
    if (decision && !decision.audit?.would_accept) throw new Error(`Unexpected proactive assessment: ${JSON.stringify(decision)}`)
    return decision
  })
  assert.equal((await tickets()).some(task => task.channels.some(channel => channel.thread === 'observed')), false)
  recorded('investigated proactive work stays unaccepted in observe mode', observed)

  const before = await cli<{ sessionFile: string; messages: number }>(['coordinator', 'show'])
  const beforeCount = (await tickets()).length
  await stop()
  await start()
  const after = await cli<{ sessionFile: string; messages: number }>(['coordinator', 'show'])
  assert.equal(after.sessionFile, before.sessionFile)
  assert.ok(after.messages >= before.messages)
  assert.equal((await tickets()).length, beforeCount)
  recorded('restart retains coordination history without duplicate tasks', after)
  await stop()
  process.stdout.write(`All ${results.length} live checks passed. Evidence retained at ${root}\n`)
} finally { await stop() }
