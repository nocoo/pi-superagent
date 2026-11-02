import { useState } from 'react'
import type { FormEvent } from 'react'
import { Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger, toast } from '@nocoo/basalt'
import { ChatComposer } from '@nocoo/basalt/components/chat-composer'
import { ChatMessage } from '@nocoo/basalt/components/chat-message'
import { DataTable, type DataTableColumn } from '@nocoo/basalt/components/data-table'
import { Input } from '@nocoo/basalt/components/input'
import { InputArea } from '@nocoo/basalt/components/input-area'
import { PageHeader } from '@nocoo/basalt/components/page-header'
import { ResourceList } from '@nocoo/basalt/components/resource-list'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@nocoo/basalt/components/select'
import { SectionRule } from '@nocoo/basalt/components/section-rule'
import type { RoutePageProps } from '../App'
import { arrays, formatValue, resultRecord, useCli, useMutation, type JsonRecord } from '../models'
import { actionLabel, formatTime, identityLabel, messageText, stageLabel, ticketOutcome, ticketProblem, ticketReport, ticketScope, toolSummary } from '../presentation'
import { ConfirmAction, EmptyState, ErrorState, JsonPreview, KeyValue, LoadingState, SectionCard, StatusBadge, dataError } from '../views'

export function TasksPage({ route, navigate }: RoutePageProps) {
  const id = route.startsWith('/tasks/') ? decodeURIComponent(route.slice('/tasks/'.length)) : undefined
  return id ? <TaskDetail id={id} navigate={navigate} /> : <TaskList navigate={navigate} />
}

function TaskList({ navigate }: { navigate: (path: string) => void }) {
  const [stage, setStage] = useState('all')
  const args = stage === 'ended'
    ? ['ticket', 'list', '--all', '--stage', 'ended']
    : stage === 'all'
      ? ['ticket', 'list', '--all']
      : ['ticket', 'list', '--stage', stage]
  const state = useCli<JsonRecord>(args, 3000)
  const pending = dataError(state, '暂无任务')
  if (pending) return <><PageHeader title="任务" description="按阶段查看当前工作与结果。" />{pending}</>

  const tickets = arrays(state.data?.tickets).map(resultRecord)
  const stages = [
    { value: 'all', label: '全部' },
    { value: 'person', label: '等待人工' },
    { value: 'working', label: '执行中' },
    { value: 'idle', label: '空闲' },
    { value: 'ended', label: '已结束' },
  ]
  const columns: DataTableColumn<JsonRecord>[] = [
    { id: 'title', header: '任务', width: 280, wrap: true, accessor: row => formatValue(row.title ?? row.id) },
    { id: 'stage', header: '阶段', width: 110, sortValue: row => stageLabel(row.stage), accessor: row => <StatusBadge value={row.stage} /> },
    { id: 'updatedAt', header: '更新时间', width: 150, accessor: row => formatTime(row.updatedAt) },
    { id: 'outcome', header: '结果', width: 220, wrap: true, accessor: row => ticketOutcome(row) },
    { id: 'actions', header: '操作', sortable: false, width: 100, accessor: row => typeof row.id === 'string'
      ? <Button variant="outline" size="sm" onClick={() => navigate(`/tasks/${encodeURIComponent(row.id as string)}`)}>查看</Button>
      : null },
  ]

  return <div className="sa-page">
    <ResourceList
      title="任务"
      description={`${tickets.length} 个任务`}
      data={tickets.map(row => ({ name: formatValue(row.title ?? row.id), status: stageLabel(row.stage) }))}
      toolbar={<Select value={stage} onValueChange={setStage}>
        <SelectTrigger size="sm" aria-label="任务阶段"><SelectValue /></SelectTrigger>
        <SelectContent>{stages.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
      </Select>}
    >
      {tickets.length ? <SectionCard title="任务列表" attached><DataTable aria-label="任务" edge="attached" data={tickets} columns={columns} getRowId={(row, index) => typeof row.id === 'string' ? row.id : String(index)} /></SectionCard> : <EmptyState />}
    </ResourceList>
  </div>
}

function TaskDetail({ id, navigate }: { id: string; navigate: (path: string) => void }) {
  const state = useCli<JsonRecord>(['ticket', 'show', id], 3000)
  const session = useCli<JsonRecord>(['ticket', 'read', id, '--lines', '40'], 5000)
  const mutation = useMutation<JsonRecord>()
  const [reason, setReason] = useState('')
  const [answerText, setAnswerText] = useState('')
  const [noteText, setNoteText] = useState('')
  const [trigger, setTrigger] = useState('')
  const [attachNote, setAttachNote] = useState('')
  const pending = dataError(state, '任务不存在')
  if (pending) return <><PageHeader title="任务详情" description={id} actions={<Button variant="outline" size="sm" onClick={() => navigate('/tasks')}>返回列表</Button>} />{pending}</>

  const ticket = resultRecord(state.data?.ticket)
  const origin = resultRecord(state.data?.origin)
  const stage = resultRecord(state.data?.stage)
  const actions = resultRecord(state.data?.actions)
  const stageText = stage.stage === 'person' && stage.action
    ? `等待人工：${formatValue(stage.action)}`
    : stageLabel(stage.stage)
  const problem = ticketProblem(ticket, origin)
  const scope = ticketScope(ticket)
  const report = ticketReport(ticket)

  const run = async (args: string[]) => {
    try {
      await mutation.execute(args)
      toast.success('已执行')
      state.reload()
      session.reload()
    } catch {
      // mutation.error is rendered near the page.
    }
  }

  const answer = async (text: string) => {
    try {
      await mutation.execute(['ticket', 'answer', id, '--text', text])
      toast.success('已发送回答')
      setAnswerText('')
      state.reload()
      session.reload()
    } catch {
      throw new Error(mutation.error?.message ?? '回答发送失败')
    }
  }

  const messages = arrays(session.data?.messages).map(resultRecord)

  return <div className="sa-page">
    <PageHeader title={formatValue(ticket.title ?? id)} description={`阶段：${stageText}`} actions={<>
      <Button variant="outline" size="sm" onClick={() => navigate('/tasks')}>返回列表</Button>
      {actions.retry === true && <ConfirmAction label="重试" title="重试任务" description="仅在 Ticket 可重试时创建新 Assignment。" busy={mutation.busy} onConfirm={() => run(['ticket', 'retry', id])} />}
      {actions.stop === true && <ConfirmAction label="停单" title="停止任务" description="停止后 Ticket 不再接收新工作。" destructive busy={mutation.busy} onConfirm={() => run(['ticket', 'stop', id, '--reason', reason])}>
        <InputArea aria-label="停止原因" value={reason} onChange={event => setReason(event.target.value)} placeholder="可选原因" />
      </ConfirmAction>}
    </>} />

    {mutation.error && <ErrorState error={mutation.error} />}

    <div className={actions.answer === true ? 'sa-two-column' : 'sa-stack'}>
      <SectionCard title="当前问题">
        <ChatMessage variant="assistant" author={identityLabel(origin.actor)} content={problem} />
      </SectionCard>
      {actions.answer === true && <SectionCard title="回答入口" actions={<StatusBadge value="person" />}>
        <ChatComposer
          className="sa-composer"
          label="回答"
          sendLabel="发送回答"
          placeholder="输入回复内容"
          value={answerText}
          onValueChange={setAnswerText}
          onSend={answer}
          disabled={mutation.busy}
        />
      </SectionCard>}
    </div>

    <SectionCard title="授权范围">
      <p className="sa-issue">{scope}</p>
    </SectionCard>

    <SectionRule title="最新报告" />
    <SectionCard title="结果">
      <ChatMessage variant="assistant" author="任务报告" content={report} />
    </SectionCard>

    <SectionRule title="人工操作" />
    <div className="sa-grid">
      {actions.note === true && <SectionCard title="添加说明">
        <form className="sa-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void run(['ticket', 'note', id, '--text', noteText]) }}>
          <InputArea aria-label="说明" value={noteText} onChange={event => setNoteText(event.target.value)} placeholder="说明内容" />
          <div className="sa-actions"><Button type="submit" size="sm" loading={mutation.busy}>{actionLabel('note')}</Button></div>
        </form>
      </SectionCard>}
      {actions.attach === true && <SectionCard title="关联 Trigger">
        <form className="sa-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void run(['ticket', 'attach', id, '--trigger', trigger, '--note', attachNote]) }}>
          <Input aria-label="Trigger ID" value={trigger} onChange={event => setTrigger(event.target.value)} placeholder="Trigger ID" />
          <InputArea aria-label="关联说明" value={attachNote} onChange={event => setAttachNote(event.target.value)} placeholder="关联说明" />
          <div className="sa-actions"><Button type="submit" variant="outline" size="sm" loading={mutation.busy}>{actionLabel('attach')}</Button></div>
        </form>
      </SectionCard>}
      {actions.requestStatus === true && <SectionCard title="请求状态">
        <Button variant="outline" size="sm" loading={mutation.busy} onClick={() => void run(['ticket', 'request-status', id])}>{actionLabel('requestStatus')}</Button>
      </SectionCard>}
    </div>

    <SectionRule title="工作会话" />
    {session.error ? <ErrorState error={session.error} /> : session.loading ? <LoadingState /> : messages.length ? <div className="sa-thread-feed">
      {messages.map((message, index) => {
        const role = formatValue(message.role).toLowerCase()
        const content = messageText(message)
        if (!content && ['thinking', 'system', 'toolcall', 'tool_call', 'toolresult', 'tool_result', 'write', 'report', 'orchestrator_ack'].includes(role)) {
          return <SectionCard key={typeof message.id === 'string' ? message.id : index} title="工具与报告记录">
            <pre className="sa-json">{toolSummary(message)}</pre>
          </SectionCard>
        }
        if (!content) return null
        return <SectionCard key={typeof message.id === 'string' ? message.id : index} title={formatValue(message.role)}>
          <ChatMessage variant={role === 'user' ? 'user' : 'assistant'} author={formatValue(message.role)} content={content} />
        </SectionCard>
      })}
    </div> : <EmptyState label="暂无工作会话记录" />}

    <SectionRule title="任务元数据" />
    <SectionCard title="授权与范围">
      <KeyValue entries={[["任务 ID", ticket.id], ["创建时间", ticket.createdAt], ["更新时间", ticket.updatedAt], ["来源", origin.source], ["来源身份", identityLabel(origin.actor)], ["阶段", stageText]]} />
    </SectionCard>
    <Collapsible>
      <CollapsibleTrigger className="sa-json-trigger">查看高级任务数据</CollapsibleTrigger>
      <CollapsibleContent><div className="sa-stack">
        <SectionCard title="Assignments"><JsonPreview value={ticket.assignments} /></SectionCard>
        <SectionCard title="Inputs"><JsonPreview value={ticket.inputs} /></SectionCard>
        <SectionCard title="原始 Trigger"><JsonPreview value={origin} /></SectionCard>
        <SectionCard title="执行信息"><JsonPreview value={ticket.execution} /></SectionCard>
        <SectionCard title="授权记录"><JsonPreview value={ticket.mandate} label="查看授权强度、依据与策略版本" /></SectionCard>
        {ticket.ended !== undefined && <SectionCard title="结束记录"><JsonPreview value={ticket.ended} label="查看结束原因、操作者与时间" /></SectionCard>}
      </div></CollapsibleContent>
    </Collapsible>
  </div>
}
