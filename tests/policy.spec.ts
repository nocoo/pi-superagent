/**
 * The authorization layer: who may originate work, at what strength, and what a later policy change does to a Mandate.
 * These are the rules the project exists for, so they are tested through the real `SettingsSchema` rather than a fake.
 */
import { describe, expect, it } from 'vitest'
import { SettingsSchema, settingsPolicy, policyVersion, assessmentOutcome, type Settings } from '../src/policy.ts'
import type { Mandate, SourceScope, Thread, Ticket, Trigger } from '../src/core/index.ts'

const alice = { source: 'github', id: 'alice' }
const stranger = { source: 'github', id: 'mallory' }
const thread: Thread = { key: 'github:1', ref: { source: 'github', id: '1' }, createdAt: '2026-01-01T00:00:00.000Z', subscriptions: [], correlated: [], pending: [], meta: {} }

function settings(overrides: Record<string, unknown> = {}): Settings {
  return SettingsSchema.parse({
    policy: { sources: { github: { allowed: [{ id: 'alice' }] } } },
    sources: { github: { enabled: true, config: { observeIssues: true } } },
    ...overrides,
  })
}

/** Every scope of this Source listens, and reports the admission row the trigger belongs to. */
const scope: SourceScope = { scope: () => ({ listened: true, observed: true, row: 'issues' }) }

function trigger(id: string, actor = alice, overrides: Partial<Trigger> = {}): Trigger {
  return { id, source: 'github', threads: [{ source: 'github', id: '1' }], actor, human: true,
    at: `2026-01-01T00:00:0${id}Z`, text: `message ${id}`, meta: { kind: 'issue' }, ...overrides }
}

const ticket = { id: 't1', mandate: { strength: 'explicit', policyVersion: 'v', scope: 's', actor: alice, basis: { via: 'addressed', addressed: 'mention' } } } as unknown as Ticket

describe('the gate', () => {
  it('admits a listed sender who addresses the agent as an explicit request', () => {
    const result = settingsPolicy(settings(), scope).gate(trigger('1', alice, { addressed: 'mention' }), thread, [])
    expect(result).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention' } })
  })

  it('ignores a sender who is not on the list, even when addressing the agent', () => {
    const result = settingsPolicy(settings(), scope).gate(trigger('1', stranger, { addressed: 'mention' }), thread, [])
    expect(result).toMatchObject({ admissible: false, reason: 'not_a_member' })
  })

  it('lets an admission cell admit an unlisted sender explicitly, which is how a support chat is opened', () => {
    const config = settings({ policy: { sources: { github: { allowed: [], admission: { issues: { unlistedAddressed: 'explicit' } } } } } })
    const result = settingsPolicy(config, scope).gate(trigger('1', stranger, { addressed: 'mention' }), thread, [])
    expect(result).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'admission', cell: 'unlistedAddressed' } })
  })

  it('turns an unaddressed message into an inferred candidate only where the Source observes all messages', () => {
    const policy = settingsPolicy(settings(), scope)
    expect(policy.gate(trigger('1', alice), thread, [])).toMatchObject({ admissible: true, strength: 'inferred' })
    const observedOnly = settingsPolicy(settings({ sources: { github: { enabled: true, config: {} } } }),
      { scope: () => ({ listened: true, observed: false, row: 'issues' }) })
    expect(observedOnly.gate(trigger('1', alice), thread, [])).toMatchObject({ admissible: false })
  })

  it('follows a thread that already has a ticket, at explicit strength for a listed sender', () => {
    const participating = { ...thread, subscriptions: ['t1'] }
    const result = settingsPolicy(settings(), scope).gate(trigger('2', alice), participating, [ticket])
    expect(result).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'followup' } })
  })

  it('never admits an inferred candidate while the accept mode is off', () => {
    const off = settingsPolicy(settings({ eval: { mode: 'off' } }), scope)
    expect(off.gate(trigger('1', alice), thread, [])).toMatchObject({ admissible: false })
  })

  it('refuses a machine message unless the Source lists that bot', () => {
    const bot = { source: 'github', id: 'dependabot[bot]' }
    expect(settingsPolicy(settings(), scope).gate(trigger('1', bot, { human: false }), thread, [])).toMatchObject({ admissible: false })
    const listed = settings({ policy: { sources: { github: { allowed: [{ id: 'alice' }], bots: [{ id: 'dependabot[bot]' }] } } } })
    expect(settingsPolicy(listed, scope).gate(trigger('1', bot, { human: false, addressed: 'mention' }), thread, []))
      .toMatchObject({ admissible: true, strength: 'inferred' })
  })
})

describe('revalidation before resume', () => {
  const mandate = (overrides: Partial<Mandate> = {}): Mandate => ({
    strength: 'explicit', policyVersion: 'v', scope: 's', actor: alice,
    basis: { via: 'addressed', addressed: 'mention', source: 'github', scope: {}, row: 'issues' }, ...overrides,
  })

  it('holds while the sender stays on the list', () => {
    expect(settingsPolicy(settings(), scope).revalidate(mandate())).toBe(true)
  })

  it('revokes once the sender is removed from the list', () => {
    const without = settings({ policy: { sources: { github: { allowed: [] } } } })
    expect(settingsPolicy(without, scope).revalidate(mandate())).toBe(false)
  })

  it('revokes an inferred mandate once the accept mode leaves auto', () => {
    const inferred = mandate({ strength: 'inferred', basis: { via: 'admission', cell: 'listedUnaddressed', source: 'github', scope: {}, row: 'issues', observation: { mode: 'auto' }, rules: ['copy'] } })
    expect(settingsPolicy(settings({ eval: { mode: 'auto' } }), scope).revalidate(inferred)).toBe(true)
    expect(settingsPolicy(settings({ eval: { mode: 'observe' } }), scope).revalidate(inferred)).toBe(false)
  })

  it('revokes a mandate whose matched rule was disabled', () => {
    const proactive = mandate({ strength: 'inferred', basis: { via: 'admission', cell: 'listedUnaddressed', source: 'github', scope: {}, observation: { mode: 'auto' }, rules: ['copy'] } })
    const disabled = settings({ eval: { mode: 'auto' }, policy: { rules: SettingsSchema.parse({}).policy.rules.map(rule => ({ ...rule, enabled: rule.id !== 'copy' })) } })
    expect(settingsPolicy(disabled, scope).revalidate(proactive)).toBe(false)
  })
})

describe('the policy version', () => {
  it('tracks the rules, the accept mode and each source part, and nothing else', () => {
    const base = settings()
    expect(policyVersion(settings({ eval: { mode: 'auto' } }))).not.toBe(policyVersion(base))
    expect(policyVersion(settings({ executor: { maxWorkers: 7 } }))).toBe(policyVersion(base))
    expect(policyVersion(settings({ paused: true }))).toBe(policyVersion(base))
  })
})

describe('an assessment', () => {
  const assess = (matched: boolean, decision: 'accept' | 'ignore' = 'accept') => ({
    decision,
    rule_assessments: SettingsSchema.parse({}).policy.rules.map(rule => ({ rule_id: rule.id, matched: rule.id === 'copy' ? matched : false, reason: 'because' })),
    direction: { implementation_requested: true, target_basis: 'specified' as const, requires_design_decision: false, evidence: 'she asked' },
    title: 'Fix a typo', scope: 'one string', reason: 'asked', intent_evidence: '"fix the typo"', acknowledgement: 'On it.',
    worktree_name: 'fix-typo',
  })

  it('accepts inferred work only in auto mode, recording what it would have accepted otherwise', () => {
    const observing = settings()
    expect(assessmentOutcome(assess(true), observing, 'inferred')).toMatchObject({ kind: 'ignore', audit: { would_accept: true } })
    expect(assessmentOutcome(assess(true), settings({ eval: { mode: 'auto' } }), 'inferred')).toMatchObject({ kind: 'accept', rules: ['copy'] })
  })

  it('ignores an accept that matched no rule, however settled the request looks', () => {
    expect(assessmentOutcome(assess(false), settings({ eval: { mode: 'auto' } }), 'inferred')).toMatchObject({ kind: 'ignore', reason: { code: 'noRuleMatched' } })
  })

  it('ignores an accept whose direction is not settled, which stops a design debate from becoming a ticket', () => {
    const open = { ...assess(true), direction: { implementation_requested: true, target_basis: 'undetermined' as const, requires_design_decision: true, evidence: 'they are still deciding' } }
    expect(assessmentOutcome(open, settings({ eval: { mode: 'auto' } }), 'inferred')).toMatchObject({ kind: 'ignore', reason: { code: 'directionUnsettled' } })
  })

  it('refuses an assessment that does not judge every enabled rule exactly once', () => {
    const partial = { ...assess(true), rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'x' }] }
    expect(() => assessmentOutcome(partial, settings(), 'inferred')).toThrow(/every enabled rule/)
  })
})
