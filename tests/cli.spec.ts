/**
 * The command line is the product's only surface, so its promises are tested as promises: exit codes, the JSON shape,
 * the error codes, and the rule that a write says what it changed. Each case runs the built CLI as a child process,
 * because that is what a person and a script both do.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store/store.ts'
import { packageRoot } from '../src/prompts.ts'
import type { Ticket } from '../src/core/index.ts'

const cli = join(packageRoot(), 'lib', 'cli.js')
const dirs: string[] = []
const stateDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'))
  dirs.push(dir)
  return join(dir, 'state')
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

interface Result { code: number; out: string; err: string }

/** Runs the CLI and returns its streams and status without throwing on a non-zero exit. */
function run(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Result {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: options.cwd, env: { ...process.env, ...options.env } })
  return { code: result.status ?? -1, out: result.stdout, err: result.stderr }
}

const json = (result: Result): { command: string; result?: unknown; error?: { code: string; message: string } } =>
  JSON.parse(result.out || result.err) as never

describe('invocation', () => {
  it('answers help, version and no arguments with success', () => {
    for (const args of [[], ['--help'], ['-V']]) {
      const result = run(args)
      expect(result.code, `${args.join(' ') || '(none)'} exited ${result.code}: ${result.err}`).toBe(0)
      expect(result.out.length).toBeGreaterThan(0)
    }
  })

  it('tells a wrong invocation from a right one whose answer is no', () => {
    expect(run(['bogus']).code).toBe(2)
    expect(run(['status', '--nope']).code).toBe(2)
    expect(run(['ticket', 'show']).code).toBe(2)
  })

  it('prints a group’s commands when the group is named alone', () => {
    const result = run(['ticket'])
    expect(result.code).toBe(0)
    for (const name of ['list', 'show', 'read', 'wait']) expect(result.out).toMatch(new RegExp(`^\\s+${name}\\b`, 'm'))
    // A group named alone asks a question, so its help goes to stdout like any other answer.
    expect(result.err).toBe('')
  })

  it('refuses a state directory that has no instance, without creating one', () => {
    const dir = stateDir()
    const result = run(['--state-dir', dir, 'status'])
    expect(result.code).toBe(1)
    expect(result.err).toMatch(/no instance/)
    expect(execFileSync('sh', ['-c', `test -e ${dir} && echo yes || echo no`], { encoding: 'utf8' }).trim()).toBe('no')
  })
})

describe('the JSON shape', () => {
  it('wraps every result in its command name', () => {
    const dir = stateDir()
    expect(run(['--state-dir', dir, 'config', 'set', '--im', '--im-allowed', 'nocoo']).code).toBe(0)
    const result = run(['--state-dir', dir, '--json', 'status'])
    expect(result.code).toBe(0)
    expect(json(result).command).toBe('status')
    expect(json(result).result).toMatchObject({ running: false, needsPerson: [] })
  })

  it('reports a failure on stderr with a stable code', () => {
    const result = run(['--state-dir', stateDir(), '--json', 'ticket', 'show', 'abcd'])
    expect(result.code).toBe(1)
    expect(result.out).toBe('')
    expect(json(result).error).toMatchObject({ code: 'no_instance' })
    expect(json(result).command).toBe('ticket show')
  })

  it('never mixes data and prose on stdout', () => {
    const dir = stateDir()
    run(['--state-dir', dir, 'config', 'set', '--im', '--im-allowed', 'nocoo'])
    const result = run(['--state-dir', dir, '--json', 'source'])
    expect(() => JSON.parse(result.out)).not.toThrow()
  })
})

describe('config set', () => {
  it('prints what it changed and nothing else', () => {
    const dir = stateDir()
    const result = run(['--state-dir', dir, 'config', 'set', '--im', '--mode', 'auto'])
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/mode\s+observe\s+→\s+auto/)
    expect(result.out).toMatch(/written/)
  })

  it('writes nothing with --dry-run', () => {
    const dir = stateDir()
    run(['--state-dir', dir, 'config', 'set', '--im'])
    const dry = run(['--state-dir', dir, 'config', 'set', '--mode', 'auto', '--dry-run'])
    expect(dry.code).toBe(0)
    expect(dry.out).toMatch(/dry run/)
    const store = new Store(join(dir, 'superagent.sqlite'))
    try { expect(store.settings().eval.mode).toBe('observe') } finally { store.close() }
  })

  it('refuses a change that would remove an authorized login, and says which', () => {
    const dir = stateDir()
    run(['--state-dir', dir, 'config', 'set', '--repository', 'a/b', '--allowed', 'nocoo', 'bob'])
    const refused = run(['--state-dir', dir, 'config', 'set', '--allowed', 'nocoo'])
    expect(refused.code).toBe(2)
    expect(refused.err).toMatch(/would remove bob/)
    const accepted = run(['--state-dir', dir, 'config', 'set', '--allowed', 'nocoo', '--yes'])
    expect(accepted.code).toBe(0)
    expect(accepted.out).toMatch(/removes bob/)
  })

  it('rejects a repository that is not owner/name', () => {
    const result = run(['--state-dir', stateDir(), 'config', 'set', '--repository', 'nope'])
    expect(result.code).toBe(2)
    expect(result.err).toMatch(/owner\/name/)
  })

  it('says so when there is nothing to change', () => {
    const dir = stateDir()
    run(['--state-dir', dir, 'config', 'set', '--im'])
    expect(run(['--state-dir', dir, 'config', 'set', '--im']).out).toMatch(/nothing to change/)
  })
})

describe('status --check', () => {
  const ticket: Ticket = { id: 'a'.repeat(32), title: 'waiting on a person', decisionId: 'd', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', channels: [], inputs: [], undelivered: [], origin: { triggerId: 't', triggerIds: ['t'] },
    mandate: { strength: 'explicit', policyVersion: 'v', scope: 's', actor: { source: 'im', id: 'nocoo' }, basis: { via: 'addressed', addressed: 'mention' } },
    attention: { id: 'q', question: 'which module?' },
    assignments: [{ id: 'a1', state: 'running', createdAt: '2026-01-01T00:00:01.000Z', report: { state: 'blocked', summary: 'need a decision', at: '2026-01-01T00:00:02.000Z' } }] }

  /** An instance with one ticket that waits for an answer. */
  function waiting(): string {
    const dir = stateDir()
    run(['--state-dir', dir, 'config', 'set', '--im'])
    const store = new Store(join(dir, 'superagent.sqlite'))
    try { store.tickets.save(ticket) } finally { store.close() }
    return dir
  }

  it('exits 1 only when asked to check', () => {
    const dir = waiting()
    expect(run(['--state-dir', dir, 'status']).code).toBe(0)
    const checked = run(['--state-dir', dir, 'status', '--check'])
    expect(checked.code).toBe(1)
    expect(checked.out).toMatch(/needs a person \(1\)/)
    expect(checked.out).toMatch(/which module\?/)
  })

  it('exits 0 when nothing needs a person', () => {
    const dir = stateDir()
    run(['--state-dir', dir, 'config', 'set', '--im'])
    expect(run(['--state-dir', dir, 'status', '--check']).code).toBe(0)
  })
})

describe('identifiers', () => {
  it('refuses a prefix too short to identify anything', () => {
    const dir = stateDir()
    run(['--state-dir', dir, 'config', 'set', '--im'])
    const result = run(['--state-dir', dir, 'ticket', 'show', 'abc'])
    expect(result.code).toBe(2)
    expect(result.err).toMatch(/too short/)
  })

  it('reports a prefix that matches nothing', () => {
    const dir = stateDir()
    run(['--state-dir', dir, 'config', 'set', '--im'])
    expect(run(['--state-dir', dir, 'ticket', 'show', 'abcdef']).code).toBe(1)
  })
})

describe('chat', () => {
  it('writes one message with --send and reads it back without a terminal', () => {
    const dir = stateDir()
    const send = run(['--state-dir', dir, 'chat', 'general', '--send', 'hello', '--as', 'nocoo'])
    expect(send.code).toBe(0)
    expect(send.out).toMatch(/general/)
    const read = run(['--state-dir', dir, 'chat', 'general'])
    expect(read.code).toBe(0)
    expect(read.out).toMatch(/nocoo\s+hello/)
  })

  it('refuses a channel name that cannot be a file', () => {
    expect(run(['--state-dir', stateDir(), 'chat', '../etc', '--send', 'x']).code).toBe(1)
  })

  it('refuses --send without a message', () => {
    expect(run(['--state-dir', stateDir(), 'chat', 'general', '--send', '   ']).code).toBe(2)
  })
})

describe('following one piece of work', () => {
  const mandate = { strength: 'explicit' as const, policyVersion: 'v', scope: 's',
    actor: { source: 'im', id: 'nocoo' }, basis: { via: 'addressed' as const, addressed: 'mention' as const } }
  const ticket = (id: string, extra: Partial<Ticket> = {}): Ticket => ({ id, title: 'work', decisionId: 'd', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', channels: [], inputs: [], undelivered: [], origin: { triggerId: 't', triggerIds: ['t'] },
    mandate, assignments: [{ id: 'a1', state: 'running', createdAt: '2026-01-01T00:00:01.000Z' }], ...extra })

  /** An instance holding the given records. */
  function seeded(records: { tickets?: Ticket[]; threads?: ThreadRecord[]; triggers?: TriggerRecord[]; decisions?: DecisionRecord[] }): string {
    const dir = stateDir()
    run(['--state-dir', dir, 'config', 'set', '--im'])
    const store = new Store(join(dir, 'superagent.sqlite'))
    try {
      store.atomic(() => {
        for (const item of records.tickets ?? []) store.tickets.save(item)
        for (const item of records.threads ?? []) store.threads.save(item)
        for (const item of records.triggers ?? []) {
          store.triggers.save(item.trigger)
          store.triggers.saveDisposition(item.trigger.id, item.disposition)
        }
        for (const item of records.decisions ?? []) store.decisions.save(item)
      })
    } finally { store.close() }
    return dir
  }

  it('returns at once when the ticket is already where it was asked to wait for', () => {
    const dir = seeded({ tickets: [ticket('b'.repeat(32), { ended: { at: '2026-01-01T00:00:09.000Z', by: 'executor', outcome: 'completed' } })] })
    const result = run(['--state-dir', dir, 'ticket', 'wait', 'b'.repeat(8), '--until', 'ended', '--timeout', '2000'])
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/ended/)
  })

  it('blocks while the stage does not match, then fails on its own timeout', () => {
    const dir = seeded({ tickets: [ticket('c'.repeat(32))] })
    const result = run(['--state-dir', dir, 'ticket', 'wait', 'c'.repeat(8), '--until', 'ended', '--timeout', '400', '--interval', '100'])
    expect(result.code).toBe(1)
    expect(result.err).toMatch(/is working, not ended/)
  })

  it('rejects a stage it cannot wait for', () => {
    const dir = seeded({ tickets: [ticket('d'.repeat(32))] })
    expect(run(['--state-dir', dir, 'ticket', 'wait', 'd'.repeat(8), '--until', 'nope']).code).toBe(2)
  })

  it('finds a decision by the Trigger it judged, not only by its own id', () => {
    const trigger: TriggerRecord['trigger'] = { id: 'e'.repeat(32), source: 'im', threads: [{ source: 'im', id: 'general' }],
      actor: { source: 'im', id: 'nocoo' }, human: true, at: '2026-01-01T00:00:00.000Z', text: 'fix it', meta: {} }
    const decision: DecisionRecord = { id: 'f'.repeat(32), evalId: 'x', threadKey: 'im:general', triggerIds: [trigger.id],
      policyVersion: 'v', at: '2026-01-01T00:00:01.000Z', kind: 'ignore', reason: [{ code: 'noRuleMatched' }], strength: 'inferred',
      audit: { rule_assessments: [{ rule_id: 'copy', matched: false, reason: 'not a typo' }],
        direction: { implementation_requested: false, target_basis: 'undetermined', requires_design_decision: true, evidence: 'unclear' } } }
    const dir = seeded({ triggers: [{ trigger, disposition: { fanout: [], decisionId: decision.id, at: '2026-01-01T00:00:01.000Z' } }], decisions: [decision] })

    const byTrigger = run(['--state-dir', dir, 'decision', 'show', 'eeeeeeee'])
    expect(byTrigger.code).toBe(0)
    expect(byTrigger.out).toMatch(/ignore/)
    expect(byTrigger.out).toMatch(/enabled admission rule matched/i)
    expect(byTrigger.out).toMatch(/open decision\s+true/)

    expect(run(['--state-dir', dir, 'decision', 'show', 'ffffffff']).out).toMatch(/ignore/)
    expect(run(['--state-dir', dir, 'decision', 'show', '00000000']).code).toBe(1)
  })

  it('describes what became of each Trigger on a thread', () => {
    const trigger: TriggerRecord['trigger'] = { id: '1'.repeat(32), source: 'im', threads: [{ source: 'im', id: 'general' }],
      actor: { source: 'im', id: 'nocoo' }, human: true, at: '2026-01-01T00:00:00.000Z', text: 'the coffee is in the wrong month', meta: {} }
    const thread: ThreadRecord = { key: 'im:general', ref: { source: 'im', id: 'general' }, createdAt: '2026-01-01T00:00:00.000Z',
      lastAt: '2026-01-01T00:00:00.000Z', subscriptions: [], correlated: [], pending: [], meta: {} }
    const dir = seeded({ threads: [thread], triggers: [{ trigger, disposition: { fanout: [], requeued: true, at: '2026-01-01T00:00:01.000Z' } }] })
    const result = run(['--state-dir', dir, 'thread', 'show', 'im:general'])
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/queued for Eval/)
  })
})

interface ThreadRecord { key: string; ref: { source: string; id: string }; createdAt: string; lastAt?: string
  subscriptions: string[]; correlated: string[]; pending: string[]; meta: Record<string, unknown> }

interface TriggerRecord {
  trigger: { id: string; source: string; threads: { source: string; id: string }[]; actor: { source: string; id: string }
    human: boolean; at: string; text: string; meta: Record<string, unknown> }
  disposition: { fanout: string[]; requeued?: true; decisionId?: string; at: string }
}
type DecisionRecord = { id: string; evalId: string; threadKey: string; triggerIds: string[]; policyVersion: string; at: string
  kind: 'ignore' | 'accept' | 'stop' | 'unavailable'; reason: { code: string }[]; strength: 'explicit' | 'inferred'
  audit?: Record<string, unknown> }
