/**
 * Drives the bootstrap target through the local IM, using nothing but the command line.
 *
 * Every message goes through `pi-superagent chat`, so this script uses exactly the surface a person uses; the channel
 * files are never touched directly. Start the agent first, in another shell:
 *
 *   node lib/cli.js run
 *
 * then:
 *
 *   node scripts/drive-ledger.ts
 *
 * Options: `--state-dir DIR`, `--channel NAME`, `--gap MS` (time between messages), `--dry-run`.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'lib', 'cli.js')

const { values } = parseArgs({
  options: {
    'state-dir': { type: 'string' },
    channel: { type: 'string', default: 'general' },
    gap: { type: 'string', default: '25000' },
    'dry-run': { type: 'boolean', default: false },
  },
})

interface Step {
  /** Who says it. Two names, so the channel looks like a conversation rather than a control socket. */
  from: string
  text: string
  /** How long to wait after saying it, so the agent has a turn to act. */
  wait: number
  /** What this step is meant to exercise, printed as the script runs. */
  proves: string
}

const SCRIPT: Step[] = [
  { from: 'nocoo', text: '@agent 3 月 1 号凌晨那笔手冲咖啡，被算到 2 月去了',
    wait: 90_000, proves: 'a specific, locatable defect becomes one ticket and gets fixed' },
  { from: 'nocoo', text: '餐饮那个数不对吧，我退了两次款怎么还变高了',
    wait: 90_000, proves: 'a defect that needs the data read, not just the code' },
  { from: 'lin', text: '这个月感觉花得有点多',
    wait: 20_000, proves: 'vague chatter is ignored, without a ticket and without a question' },
  { from: 'nocoo', text: '顺便能不能加个 web 界面看看',
    wait: 40_000, proves: 'an out-of-scope request does not expand the open ticket' },
  { from: 'nocoo', text: '先别管 web 了，把 check 加上对日期的校验',
    wait: 90_000, proves: 'a correction reaches a worker that is already running' },
]

const run = (args: string[]): string => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' }).trimEnd()

const base = values['state-dir'] ? ['--state-dir', values['state-dir']] : []
const channel = values.channel!
const gap = Number(values.gap)

for (const [index, step] of SCRIPT.entries()) {
  console.log(`\n── ${index + 1}/${SCRIPT.length}  ${step.proves}`)
  console.log(`   ${step.from}: ${step.text}`)
  if (values['dry-run']) continue
  console.log(`   → ${run([...base, 'chat', channel, '--send', step.text, '--as', step.from])}`)
  const wait = Math.round(step.wait * (gap / 25_000))
  console.log(`   … waiting ${Math.round(wait / 1000)}s`)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
  for (const line of run([...base, 'status']).split('\n').filter(line => /needs a person|^  (review|answer|blocked|failed)/.test(line))) {
    console.log(`   ${line.trim()}`)
  }
}

if (!values['dry-run']) {
  console.log('\n── the conversation')
  console.log(run([...base, 'chat', channel]))
  console.log('\n── tickets')
  console.log(run([...base, 'ticket', 'list', '--all']))
}
