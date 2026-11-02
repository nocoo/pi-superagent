import { describe, expect, it, vi, afterEach } from 'vitest'
import { textPage, threadPage, readGithubThread, resolveTrigger } from '../src/agents/context.ts'
import { askTool, reportTool, handbackTool } from '../src/agents/report-tool.ts'
import { COORDINATOR_TOOL_NAMES, coordinatorTools } from '../src/agents/coordinator-tools.ts'
import { createAgentSession, SessionManager, defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { PiCoordinator } from '../src/agents/pi-coordinator.ts'
import { humanFollowupNotice } from '../src/agents/pi-executor.ts'
import { Commands } from '../src/infra/commands.ts'

afterEach(() => vi.restoreAllMocks())
const deployment = { repository: 'org/repo', github: { cli: 'gh', login: 'bot', noreply: 'bot@example.com' } }

describe('investigation context', () => {
  it('pages text without losing the remainder', () => {
    expect(textPage('thread', 'abcdefghij', 2, 3)).toMatchObject({ text: 'cde', next_offset: 5 })
  })
  it('uses the clamped message limit for continuation', () => {
    const messages = Array.from({ length: 130 }, (_, id) => ({ id: String(id), text: 'message' }))
    const store = { read: { threadPage: (_thread: string, offset: number, limit: number) => messages.slice(offset, offset + limit) } }
    expect(threadPage(store as never, 'im:general', 0, 4000)).toMatchObject({ next_offset: 100 })
    expect(threadPage(store as never, 'im:general', 100, 100)).toMatchObject({ items: messages.slice(100), next_offset: undefined })
  })
  it('reads all GitHub API pages and retains review comments', async () => {
    vi.spyOn(Commands.prototype, 'api').mockResolvedValue({ id: 1, title: 'Request', body: 'Root', pull_request: {} } as never)
    const messages = Array.from({ length: 120 }, (_, id) => ({ id: id + 2, body: `message ${id}`, created_at: '2026-01-01' }))
    const pages = vi.spyOn(Commands.prototype, 'pages').mockImplementation(async (_schema, path) =>
      path.startsWith('issues/') ? messages : path.includes('/reviews') ? [] : [{ id: 999, body: 'Inline review', created_at: '2026-01-02' }])
    const first = await readGithubThread(deployment, 1, 0, 100) as { root: { body: string }; items: unknown[]; next_offset: number }
    expect(first.root.body).toBe('Root')
    expect(first.items).toHaveLength(100)
    expect(first.next_offset).toBe(100)
    const last = await readGithubThread(deployment, 1, 100, 100) as { items: { kind: string; body: string }[]; next_offset?: number }
    expect(last.items).toHaveLength(21)
    expect(last.items.at(-1)).toMatchObject({ kind: 'inline', body: 'Inline review' })
    expect(last.next_offset).toBeUndefined()
    expect(pages).toHaveBeenCalledWith(expect.anything(), 'issues/1/comments?per_page=100')
  })
})

it('keeps main-session routing tools active under a Pi allowlist', async () => {
  const tools = ['orchestrator_route', 'orchestrator_eval_decide'].map(name => defineTool({ name, label: name, description: name,
    parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }) }))
  const { session } = await createAgentSession({ sessionManager: SessionManager.inMemory(), tools: ['read', ...COORDINATOR_TOOL_NAMES], customTools: tools })
  try { for (const tool of tools) expect(session.getActiveToolNames()).toContain(tool.name) } finally { session.dispose() }
})

it('records unavailable rather than success when a coordinator records no decision', async () => {
  const decide = vi.fn()
  const candidate = { evalId: 'eval-1', strength: 'explicit', thread: { ref: { source: 'im', id: 'general' } },
    triggers: [{ id: 'trigger-1' }], tickets: [], policyVersion: 'v' }
  let boundary: ((event: unknown) => unknown) | undefined
  const session = { prompt: async () => {
    const event = { outcome: 'completed', context: { canContinue: true } }
    expect(boundary?.(event)).toMatchObject({ continue: true, entries: [expect.objectContaining({ customType: 'decision-required' })] })
    expect(boundary?.(event)).toBeUndefined()
  }, isStreaming: false, isIdle: true }
  const coordinator = new PiCoordinator({ engine: { candidate: () => candidate, candidateDelivered: () => {}, decide },
    store: { settings: () => ({ eval: { timeoutSeconds: 120, model: null }, policy: { rules: [] } }), read: { threadTriggers: () => [] } },
    effects: { handle: () => {}, cancel: () => {} }, sessions: { setPromptReader: () => {}, ensure: async (_id: string, profile: { extensions: ((api: unknown) => void)[] }) => {
      profile.extensions[0]!({ on: (_name: string, handler: (event: unknown) => unknown) => { boundary = handler; return () => {} } })
      return session
    } },
    deployment, stateDir: '/unused', lifetime: new AbortController().signal, paused: () => false,
    readPrompt: (role: string) => ({ revision: 1, text: role }),
  } as never)
  await (coordinator as unknown as { assess(id: string, evalId: string): Promise<void> }).assess('trigger-1', 'eval-1')
  expect(decide).toHaveBeenCalledWith('trigger-1', expect.objectContaining({ kind: 'unavailable', evalId: 'eval-1' }))
})

it('validates within the tool and binds decisions to each current evaluation', async () => {
  let triggerId = 'trigger-1', evalId = 'eval-1'
  const decide = vi.fn(() => ({ kind: 'accept' }))
  const tool = coordinatorTools({ engine: { candidate: (id: string) => id === triggerId ? { evalId, strength: 'inferred' } : undefined, decide },
    store: { triggers: { get: (id: string) => ({ id }) }, settings: () => ({ eval: { mode: 'auto' }, policy: { rules: [{ id: 'copy', enabled: true }] } }) }, deployment, paused: () => false,
  } as never).find(item => item.name === 'orchestrator_eval_decide')!
  const input = { trigger_id: triggerId, eval_id: evalId, decision: 'accept', rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'Requested' }],
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'A precise request' },
    title: 'Fix copy', scope: 'One string', intent_evidence: 'Requested', reason: 'Rule matched', worktree_name: 'fix-copy' }
  await expect(tool.execute('bad', { ...input, rule_assessments: [] }, undefined, undefined, {} as never)).rejects.toThrow()
  expect(decide).not.toHaveBeenCalled()
  await tool.execute('first', input, undefined, undefined, {} as never)
  triggerId = 'trigger-2'; evalId = 'eval-2'
  await expect(tool.execute('stale', input, undefined, undefined, {} as never)).rejects.toThrow()
  await tool.execute('second', { ...input, trigger_id: triggerId, eval_id: evalId }, undefined, undefined, {} as never)
  expect(decide).toHaveBeenCalledTimes(2)
})

it('records a positive observe-mode assessment without accepting work', async () => {
  const decide = vi.fn(() => ({ kind: 'ignore' }))
  const tool = coordinatorTools({ engine: { candidate: () => ({ evalId: 'eval', strength: 'inferred' }), decide },
    store: { triggers: { get: (id: string) => ({ id }) }, settings: () => ({ eval: { mode: 'observe' }, policy: { rules: [{ id: 'copy', enabled: true }] } }) }, deployment, paused: () => false,
  } as never).find(item => item.name === 'orchestrator_eval_decide')!
  await tool.execute('observe', { trigger_id: 'event', eval_id: 'eval', decision: 'accept',
    rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'Requested' }],
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'Specific task' },
    title: 'Copy task', scope: 'One string', intent_evidence: 'Requested', reason: 'Matched' }, undefined, undefined, {} as never)
  expect(decide).toHaveBeenCalledWith('event', expect.objectContaining({ kind: 'ignore', audit: expect.objectContaining({ would_accept: true }) }))
})

it('preserves the trigger identity and full human stop request in coordinator notices', () => {
  expect(PiCoordinator.sessionId).toBe('coordinator')
  expect(JSON.parse(humanFollowupNotice('task-1', { id: 'event-1', source: 'im', text: 'Stop this task' } as never)))
    .toMatchObject({ ticket_id: 'task-1', trigger_id: 'event-1', source: 'im', text: 'Stop this task' })
})

it('awaits report persistence and can clear an outstanding question', async () => {
  const submit = vi.fn(async () => {})
  const tool = reportTool(submit, () => 'origin')
  await tool.execute('clear', { state: 'progress', summary: 'Answer received', question: null }, undefined, undefined, {} as never)
  expect(submit).toHaveBeenCalledWith({ state: 'progress', summary: 'Answer received', question: null }, undefined, undefined)
  submit.mockRejectedValueOnce(new Error('Invalid PR'))
  await expect(tool.execute('pr', { state: 'ready', summary: 'Done', pr_number: 1 }, undefined, undefined, {} as never)).rejects.toThrow('Invalid PR')
})

it('resolves unique short IDs but never guesses a corrupted long ID', () => {
  const records = [{ id: 'abcdef120000000000000000000000' }, { id: 'fedcba980000000000000000000000' }]
  const store = { triggers: { get: (id: string) => records.find(item => item.id === id) }, read: {
    triggersByPrefix: (id: string) => records.filter(item => item.id.startsWith(id)), recentTriggers: () => records,
  } }
  expect(resolveTrigger(store as never, 'abcdef12').id).toBe(records[0]!.id)
  expect(() => resolveTrigger(store as never, 'abcdef129999999999')).toThrow('Recent trigger IDs: abcdef12, fedcba98')
  records.push({ id: 'abcdef121111111111111111111111' })
  expect(() => resolveTrigger(store as never, 'abcdef12')).toThrow('2 triggers match')
})

it('records a structured question through the explicit ask tool', async () => {
  const submit = vi.fn(async () => {})
  const result = await askTool(submit, () => 'origin').execute('ask', { question: 'Which destination?' }, undefined, undefined, {} as never)
  expect(submit).toHaveBeenCalledWith({ state: 'blocked', summary: 'Which destination?', question: 'Which destination?', askedBy: 'origin' }, undefined, undefined)
  expect(result.terminate).toBe(true)
})

it('records the actual handback reason', async () => {
  const submit = vi.fn(() => true)
  await handbackTool(submit).execute('handoff', { trigger_id: 'other', reason: 'Another customer request' }, undefined, undefined, {} as never)
  expect(submit).toHaveBeenCalledWith('other', 'Another customer request')
})
