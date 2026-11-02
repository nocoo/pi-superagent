import { describe, expect, it } from 'vitest'
import {
  actionLabel,
  compactId,
  configSummary,
  formatTime,
  identityLabel,
  isCurrentRevision,
  messageText,
  searchKind,
  stageLabel,
  statusLabel,
  ticketOutcome,
  ticketScope,
  ticketProblem,
  ticketReport,
  toolStatus,
  toolSummary,
} from '../web/src/presentation'

describe('presentation helpers', () => {
  it('rejects a stale query snapshot after a confirmed save', () => {
    expect(isCurrentRevision(1, undefined)).toBe(true)
    expect(isCurrentRevision(1, 2)).toBe(false)
    expect(isCurrentRevision(2, 2)).toBe(true)
    expect(isCurrentRevision(3, 2)).toBe(true)
  })

  it('maps real lifecycle states to readable Chinese labels', () => {
    expect(statusLabel('ready')).toBe('就绪')
    expect(statusLabel('person')).toBe('等待人工')
    expect(statusLabel('waiting')).toBe('等待事件')
    expect(statusLabel('working')).toBe('执行中')
    expect(statusLabel('completed')).toBe('已完成')
    expect(statusLabel('stopped')).toBe('已停止')
    expect(statusLabel('accept')).toBe('已接受')
    expect(actionLabel('answer')).toBe('回答')
    expect(actionLabel('review')).toBe('审核')
    expect(stageLabel('ended')).toBe('已结束')
  })

  it('uses readable fallbacks for unknown or missing times and ids', () => {
    expect(formatTime('not-a-time')).toBe('not-a-time')
    expect(formatTime(undefined)).toBe('—')
    expect(formatTime(1793593298992)).not.toBe('—')
    expect(compactId('5dc27ca6b609fc1441633ecc1590a1ac')).toBe('5dc27ca6…0a1ac')
  })

  it('picks the task problem, report, and outcome from CLI records', () => {
    const ticket = {
      title: 'Refund reply',
      summary: 'completed',
      mandate: { scope: 'Draft a refund reply' },
      assignments: [{ report: { summary: 'Wrote reply.txt' } }],
    }
    expect(ticketProblem({ ...ticket, attention: { question: 'Which refund window?' } }, { text: '@agent Draft a refund reply' })).toBe('Which refund window?')
    expect(ticketProblem(ticket, { text: '@agent Draft a refund reply' })).toBe('@agent Draft a refund reply')
    expect(ticketReport(ticket)).toBe('Wrote reply.txt')
    expect(ticketOutcome({ ...ticket, ended: { outcome: 'completed' } })).toBe('completed')
    expect(ticketScope(ticket)).toBe('Draft a refund reply')
  })

  it('extracts visible chat text without inventing hidden reasoning', () => {
    expect(messageText({ text: '30-day refund window' })).toBe('30-day refund window')
    expect(messageText({ content: [{ type: 'text', text: 'Drafted' }, { type: 'text', text: 'reply.txt' }] })).toBe('Drafted\nreply.txt')
    expect(messageText({ role: 'thinking', text: 'hidden reasoning' })).toBe('')
    expect(messageText({ role: 'toolCall', content: [{ type: 'toolCall', text: 'secret tool json' }] })).toBe('')
    expect(messageText({ role: 'assistant', content: [{ type: 'text', text: 'Proceeding' }, { type: 'toolCall', name: 'orchestrator_route', arguments: { trigger_id: 'x' } }] })).toContain('工具调用：orchestrator_route')
    expect(toolStatus({ isError: true })).toBe('error')
    expect(toolStatus({ isError: false })).toBe('complete')
    expect(toolStatus({})).toBe('pending')
    expect(toolSummary({ role: 'write', text: 'Successfully wrote to reply.txt' })).toBe('Successfully wrote to reply.txt')
  })

  it('summarizes the real config shape', () => {
    expect(configSummary({ settings: { paused: false, sources: { im: { enabled: true }, inbox: { enabled: false } }, policy: { rules: [{ id: 'r1' }] }, eval: { mode: 'observe', model: { provider: 'local', model: 'group/coding' } }, executor: { model: { provider: 'local', model: 'group/coding' }, maxWorkers: 2 } } })).toEqual({ paused: false, evalMode: 'observe', evalModel: 'local/group/coding', executorModel: 'local/group/coding', maxWorkers: 2, sources: 'im', policyRules: 1 })
  })

  it('keeps identities and search types explicit', () => {
    expect(identityLabel({ id: 'alice' })).toBe('alice')
    expect(identityLabel({ name: 'Helpdesk' })).toBe('Helpdesk')
    expect(searchKind({ key: 'im:question' })).toBe('Thread')
    expect(searchKind({ id: 'ticket-1', title: 'Refund' })).toBe('Ticket')
    expect(searchKind({ id: 'trigger-1' })).toBe('Trigger')
  })
})
