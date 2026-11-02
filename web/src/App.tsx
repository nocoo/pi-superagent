import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Badge, Button, Input, Tabs, TabsContent, TabsList, TabsTrigger, toast } from '@nocoo/basalt'
import { InputArea } from '@nocoo/basalt/components/input-area'
import { PageHeader } from '@nocoo/basalt/components/page-header'
import { SectionRule } from '@nocoo/basalt/components/section-rule'
import { arrays, entries, formatValue, resultRecord, searchResultItems, useCli, useMutation, type JsonRecord } from './models'
import { textLines } from './diff'
import { ConfirmAction, EmptyState, ErrorState, JsonPreview, KeyValue, LoadingState, SectionCard, StatusBadge, TextDiff } from './views'

export interface RoutePageProps {
  route: string
  navigate: (path: string) => void
}

function dataError<T>(state: { data?: T; loading: boolean; error?: Error }, fallback: string) {
  if (state.error) return <ErrorState error={state.error} />
  if (state.loading) return <LoadingState />
  if (state.data === undefined) return <EmptyState label={fallback} />
  return undefined
}

export function OverviewPage() {
  const status = useCli<JsonRecord>(['status'], 5000)
  const tickets = useCli<JsonRecord>(['ticket', 'list', '--all'], 5000)
  const statusError = dataError(status, '暂无状态')
  const ticketsError = dataError(tickets, '暂无任务')
  if (statusError) return statusError
  const needs = arrays(status.data?.needsPerson)
  const system = arrays(status.data?.system)
  const policy = resultRecord(status.data?.policy)
  const ticketRows = arrays(tickets.data?.tickets)
  return <>
    <PageHeader title="概览" description="只显示需要人工处理或系统异常的事实。" />
    <SectionRule title={`需要人工处理 (${needs.length})`} />
    {needs.length ? <div className="web-card-grid">{needs.map((item, index) => {
      const record = resultRecord(item)
      return <SectionCard key={typeof record.id === 'string' ? record.id : index} title={formatValue(record.title ?? record.id)} actions={<Badge>{formatValue(record.action ?? record.stage)}</Badge>}>
        <KeyValue entries={entries({ id: record.id, needs: record.needs })} />
      </SectionCard>
    })}</div> : <EmptyState label="当前无需人工处理" />}
    {ticketsError || <>
      <SectionRule title="任务概要" />
      <div className="web-card-grid">
        {['person', 'working', 'idle', 'ended'].map(stage => {
          const count = ticketRows.filter(item => resultRecord(item).stage === stage).length
          return <SectionCard key={stage} title={stage}><KeyValue entries={[[stage, count]]} /></SectionCard>
        })}
      </div>
    </>}
    <SectionRule title="系统健康" />
    {system.length ? <div className="web-card-grid">{system.map((item, index) => {
      const record = resultRecord(item)
      return <SectionCard key={typeof record.part === 'string' ? record.part : index} title={formatValue(record.part)} actions={<StatusBadge value={record.state} />}>
        <p>{formatValue(record.detail)}</p>
      </SectionCard>
    })}</div> : <EmptyState />}
    <SectionRule title="策略" />
    <SectionCard title="当前策略"><KeyValue entries={entries(policy)} /></SectionCard>
  </>
}

export function TasksPage({ route, navigate }: RoutePageProps) {
  const id = route.startsWith('/tasks/') ? decodeURIComponent(route.slice('/tasks/'.length)) : undefined
  return id ? <TaskDetail id={id} navigate={navigate} /> : <TaskList navigate={navigate} />
}

function TaskList({ navigate }: { navigate: (path: string) => void }) {
  const [stage, setStage] = useState('')
  const args = stage === 'ended'
    ? ['ticket', 'list', '--all', '--stage', 'ended']
    : stage
      ? ['ticket', 'list', '--stage', stage]
      : ['ticket', 'list', '--all']
  const state = useCli<JsonRecord>(args, 3000)
  const pending = dataError(state, '暂无任务')
  if (pending) return <><PageHeader title="任务" description="按需人工处理和执行阶段查看任务。" />{pending}</>
  const tickets = arrays(state.data?.tickets)
  return <>
    <PageHeader title="任务" description="按需人工处理和执行阶段查看任务。" actions={<div className="web-inline">
      {['', 'person', 'working', 'idle', 'ended'].map(value => <Button key={value || 'all'} size="sm" variant={stage === value ? 'default' : 'outline'} onClick={() => setStage(value)}>
        {value || '全部'}
      </Button>)}
    </div>} />
    {tickets.length ? <div className="web-card-grid">{tickets.map((item, index) => {
      const ticket = resultRecord(item)
      const id = typeof ticket.id === 'string' ? ticket.id : undefined
      return <SectionCard key={id ?? index} title={formatValue(ticket.title ?? ticket.id)} actions={<StatusBadge value={ticket.stage} />}>
        <p className="web-muted">{formatValue(ticket.outcome ?? ticket.summary ?? ticket.report)}</p>
        {id && <Button variant="outline" size="sm" onClick={() => navigate(`/tasks/${encodeURIComponent(id)}`)}>查看详情</Button>}
      </SectionCard>
    })}</div> : <EmptyState />}
  </>
}

function TaskDetail({ id, navigate }: { id: string; navigate: (path: string) => void }) {
  const state = useCli<JsonRecord>(['ticket', 'show', id], 3000)
  const session = useCli<JsonRecord>(['ticket', 'read', id, '--lines', '40'], 5000)
  const mutation = useMutation<JsonRecord>()
  const [reason, setReason] = useState('')
  const [text, setText] = useState('')
  const [trigger, setTrigger] = useState('')
  const [note, setNote] = useState('')
  const pending = dataError(state, '任务不存在')
  if (pending) return <><PageHeader title="任务详情" description={id} actions={<Button variant="outline" size="sm" onClick={() => navigate('/tasks')}>返回列表</Button>} />{pending}</>
  const ticket = resultRecord(state.data?.ticket)
  const origin = resultRecord(state.data?.origin)
  const stage = resultRecord(state.data?.stage)
  const actions = resultRecord(state.data?.actions)
  const stageText = stage.stage === 'person' && stage.action
    ? `person / ${formatValue(stage.action)}`
    : formatValue(stage.stage)
  const run = async (args: string[]) => {
    try {
      await mutation.execute(args)
      toast.success('已执行')
      state.reload()
      session.reload()
    } catch {
      // mutation.execute exposes the UI error through useMutation.
    }
  }
  const messages = arrays(session.data?.messages)
  return <>
    <PageHeader title={formatValue(ticket.title ?? id)} description={stageText} actions={<>
      <Button variant="outline" size="sm" onClick={() => navigate('/tasks')}>返回列表</Button>
      {actions.retry === true && <ConfirmAction label="重试" title="重试任务" description="仅在 Ticket 可重试时创建新 Assignment。" busy={mutation.busy} onConfirm={() => run(['ticket', 'retry', id])} />}
      {actions.stop === true && <ConfirmAction label="停单" title="停止任务" description="停止后 Ticket 不再接收新工作。" destructive busy={mutation.busy} onConfirm={() => run(['ticket', 'stop', id, '--reason', reason])}>
        <InputArea aria-label="停止原因" value={reason} onChange={event => setReason(event.target.value)} placeholder="可选原因" />
      </ConfirmAction>}
    </>} />
    {mutation.error && <ErrorState error={mutation.error} />}
    <SectionCard title="授权与范围">
      <KeyValue entries={entries({ title: ticket.title, ended: ticket.ended, mandate: ticket.mandate, scope: ticket.scope, stage: stageText })} />
    </SectionCard>
    <SectionRule title="原始 Trigger" />
    <SectionCard title={formatValue(origin.id)}><KeyValue entries={entries(origin)} /></SectionCard>
    <SectionRule title="Assignment 与输入" />
    <SectionCard title="Assignments"><JsonPreview value={ticket.assignments} /></SectionCard>
    <SectionCard title="Inputs"><JsonPreview value={ticket.inputs} /></SectionCard>
    <SectionRule title="工作会话" />
    {session.error ? <ErrorState error={session.error} /> : session.loading ? <LoadingState /> : messages.length
      ? <div className="web-card-grid">{messages.map((item, index) => {
          const message = resultRecord(item)
          const content = Array.isArray(message.content) ? message.content.map(part => {
            const record = resultRecord(part)
            return record.type === 'text' ? formatValue(record.text) : JSON.stringify(record)
          }).join('\n') : formatValue(message.content)
          return <SectionCard key={typeof message.id === 'string' ? message.id : index} title={formatValue(message.role ?? 'message')}>
            <pre className="web-json">{content}</pre>
          </SectionCard>
        })}</div>
      : <EmptyState label="暂无工作会话记录" />}
    <SectionRule title="人工操作" />
    <div className="web-card-grid">
      {actions.note === true && <SectionCard title="添加说明"><form className="web-form" onSubmit={event => { event.preventDefault(); void run(['ticket','note',id,'--text',text]) }}>
        <InputArea aria-label="说明" value={text} onChange={event => setText(event.target.value)} />
        <Button type="submit" size="sm" loading={mutation.busy}>发送说明</Button>
      </form></SectionCard>}
      {actions.answer === true && <SectionCard title="回答人工问题"><form className="web-form" onSubmit={event => { event.preventDefault(); void run(['ticket','answer',id,'--text',text]) }}>
        <InputArea aria-label="回答" value={text} onChange={event => setText(event.target.value)} />
        <Button type="submit" variant="outline" size="sm" loading={mutation.busy}>发送回答</Button>
      </form></SectionCard>}
      {actions.attach === true && <SectionCard title="关联 Trigger"><form className="web-form" onSubmit={event => { event.preventDefault(); void run(['ticket','attach',id,'--trigger',trigger,'--note',note]) }}>
        <Input aria-label="Trigger ID" value={trigger} onChange={event => setTrigger(event.target.value)} placeholder="Trigger ID" />
        <InputArea aria-label="关联说明" value={note} onChange={event => setNote(event.target.value)} />
        <Button type="submit" variant="outline" size="sm" loading={mutation.busy}>关联重评</Button>
      </form></SectionCard>}
      {actions.requestStatus === true && <SectionCard title="请求状态"><Button variant="outline" size="sm" loading={mutation.busy} onClick={() => void run(['ticket','request-status',id])}>请求 Worker 状态</Button></SectionCard>}
    </div>
  </>
}

export function ThreadsPage({ route, navigate }: RoutePageProps) {
  const key = route.startsWith('/threads/') ? decodeURIComponent(route.slice('/threads/'.length)) : undefined
  return key ? <ThreadDetail threadKey={key} navigate={navigate} /> : <ThreadList navigate={navigate} />
}

function ThreadList({ navigate }: { navigate: (path: string) => void }) {
  const state = useCli<JsonRecord>(['thread', 'list'], 5000)
  const pending = dataError(state, '暂无 Thread')
  if (pending) return <><PageHeader title="线程与事件" description="会话、订阅和 Trigger 的时间线。" />{pending}</>
  const threads = arrays(state.data?.threads)
  return <>
    <PageHeader title="线程与事件" description="会话、订阅和 Trigger 的时间线。" />
    {threads.length ? <div className="web-card-grid">{threads.map((item, index) => {
      const thread = resultRecord(item)
      const key = typeof thread.key === 'string' ? thread.key : undefined
      return <SectionCard key={key ?? index} title={formatValue(thread.label ?? thread.key)} actions={<StatusBadge value={thread.evaluating ? 'evaluating' : 'idle'} />}>
        <KeyValue entries={entries({ triggers: thread.triggers, subscribed: thread.subscribed, lastAt: thread.lastAt })} />
        {key && <Button variant="outline" size="sm" onClick={() => navigate(`/threads/${encodeURIComponent(key)}`)}>查看事件</Button>}
      </SectionCard>
    })}</div> : <EmptyState />}
  </>
}

function ThreadDetail({ threadKey, navigate }: { threadKey: string; navigate: (path: string) => void }) {
  const state = useCli<JsonRecord>(['thread', 'show', threadKey], 3000)
  const mutation = useMutation<JsonRecord>()
  const pending = dataError(state, 'Thread 不存在')
  if (pending) return <><PageHeader title="线程详情" description={threadKey} />{pending}</>
  const thread = resultRecord(state.data?.thread)
  const triggers = arrays(state.data?.triggers)
  const run = async () => { try { await mutation.execute(['thread','unsubscribe',threadKey]); toast.success('已取消订阅'); state.reload() } catch { /* mutation.error is rendered near the page */ } }
  return <>
    <PageHeader title={formatValue(thread.meta ? (thread.meta as JsonRecord).label : thread.key)} description={threadKey} actions={<>
      <Button variant="outline" size="sm" onClick={() => navigate('/threads')}>返回列表</Button>
      <ConfirmAction label="取消订阅" title="取消 Thread 订阅" description="会移除该 Thread 上全部 Ticket 的订阅。" destructive busy={mutation.busy} onConfirm={run} />
    </>} />
    {mutation.error && <ErrorState error={mutation.error} />}
    {triggers.length ? <div className="web-card-grid">{triggers.map((item, index) => {
      const trigger = resultRecord(item)
      return <SectionCard key={typeof trigger.id === 'string' ? trigger.id : index} title={formatValue(trigger.actor)} actions={<StatusBadge value={trigger.human ? 'human' : 'machine'} />}>
        <KeyValue entries={entries({ id: trigger.id, at: trigger.at, text: trigger.text, addressed: trigger.addressed, url: trigger.url })} />
        {typeof trigger.id === 'string' && <Button variant="outline" size="sm" loading={mutation.busy} onClick={() => {
          void (async () => { try { await mutation.execute(['trigger','reevaluate',trigger.id as string]); toast.success('已加入重评'); state.reload() } catch { /* mutation.error is rendered near the page */ } })()
        }}>重评</Button>}
      </SectionCard>
    })}</div> : <EmptyState />}
  </>
}

export function DecisionsPage() {
  const state = useCli<JsonRecord>(['decision', 'list', '--since', '24h'], 5000)
  const mutation = useMutation<JsonRecord>()
  const pending = dataError(state, '暂无决策')
  if (pending) return <><PageHeader title="决策" description="Eval 结论、规则匹配和方向事实。" />{pending}</>
  const decisions = arrays(state.data?.decisions)
  return <>
    <PageHeader title="决策" description="Eval 结论、规则匹配和方向事实。" />
    {mutation.error && <ErrorState error={mutation.error} />}
    {decisions.length ? <div className="web-card-grid">{decisions.map((item, index) => {
      const decision = resultRecord(item)
      const id = typeof decision.id === 'string' ? decision.id : undefined
      return <SectionCard key={id ?? index} title={formatValue(decision.kind)} actions={<StatusBadge value={decision.kind} />}>
        <KeyValue entries={entries(decision)} />
        {decision.kind === 'unavailable' && decision.dismissed !== true && id && <ConfirmAction label="Dismiss" title="Dismiss unavailable decision" description="只移除当前未判定决策的问题提示。" busy={mutation.busy} onConfirm={async () => {
          try { await mutation.execute(['decision','dismiss',id]); toast.success('已处理'); state.reload() } catch { /* mutation.error is rendered near the page */ }
        }} />}
      </SectionCard>
    })}</div> : <EmptyState />}
  </>
}

export function SourcesPage() {
  const state = useCli<JsonRecord>(['source'], 5000)
  const pending = dataError(state, '暂无 Source')
  if (pending) return <><PageHeader title="来源" description="Source 接收、健康和读取状态。" />{pending}</>
  const sources = arrays(state.data?.sources)
  return <>
    <PageHeader title="来源" description="Source 接收、健康和读取状态。" />
    {sources.length ? <div className="web-card-grid">{sources.map((item, index) => {
      const source = resultRecord(item)
      return <SectionCard key={typeof source.part === 'string' ? source.part : index} title={formatValue(source.part)} actions={<StatusBadge value={source.state} />}>
        <KeyValue entries={entries(source)} />
      </SectionCard>
    })}</div> : <EmptyState />}
  </>
}

export function SearchPage() {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const state = useCli<JsonRecord>(submitted ? ['search', submitted] : ['search', ''], 0, submitted !== '')
  const submit = (event: FormEvent) => { event.preventDefault(); if (query.trim()) setSubmitted(query.trim()) }
  const hasResult = submitted !== ''
  const pending = hasResult ? dataError(state, '无搜索结果') : undefined
  if (pending) return <><PageHeader title="搜索" description="搜索 Trigger、Thread 和 Ticket。" />
    <form className="web-search" onSubmit={submit}><Input aria-label="搜索" value={query} onChange={event => setQuery(event.target.value)} /><Button type="submit">搜索</Button></form>{pending}</>
  const items = searchResultItems(state.data)
  return <>
    <PageHeader title="搜索" description="搜索 Trigger、Thread 和 Ticket。" />
    <form className="web-search" onSubmit={submit}><Input aria-label="搜索" value={query} onChange={event => setQuery(event.target.value)} /><Button type="submit">搜索</Button></form>
    {submitted && (items.length ? <div className="web-card-grid">{items.map((item, index) => {
      const record = resultRecord(item)
      return <SectionCard key={typeof record.id === 'string' ? record.id : typeof record.key === 'string' ? record.key : index} title={formatValue(record.title ?? record.preview ?? record.label ?? record.key ?? record.id)}>
        <KeyValue entries={entries(record)} />
      </SectionCard>
    })}</div> : <EmptyState label="无搜索结果" />)}
  </>
}

interface PromptSnapshot {
  revision: number
  savedAt?: string
  config: { orchestrator: string; assess: string; work: string; shared: string }
}

export function PromptsPage() {
  const show = useCli<PromptSnapshot>(['prompt', 'show'], 3000)
  const history = useCli<{ versions: PromptSnapshot[] }>(['prompt', 'history'], 5000)
  const mutation = useMutation<PromptSnapshot | { prompts: { orchestrator: string; assess: string; work: string } }>()
  const [tab, setTab] = useState('edit')
  const [config, setConfig] = useState<PromptSnapshot['config']>({ orchestrator: '', assess: '', work: '', shared: '' })
  const [baseRevision, setBaseRevision] = useState<number>()
  const [baseConfig, setBaseConfig] = useState<PromptSnapshot['config']>()
  const [dirty, setDirty] = useState(false)
  const [remoteRevision, setRemoteRevision] = useState<number>()
  const [preview, setPreview] = useState<{ prompts: { orchestrator: string; assess: string; work: string } }>()
  useEffect(() => {
    if (!show.data) return
    setRemoteRevision(show.data.revision)
    if (!dirty) {
      setBaseRevision(show.data.revision)
      setBaseConfig(show.data.config)
      setConfig(show.data.config)
    }
  }, [show.data, dirty])
  const pending = dataError(show, '暂无 Prompt 配置')
  if (pending) return <><PageHeader title="Prompt" description="编辑、预览、比较和恢复配置版本。" />{pending}</>
  if (!show.data) return <EmptyState label="暂无 Prompt 配置" />
  const revision = baseRevision ?? show.data.revision
  const saved = baseConfig ?? show.data.config
  const editConfig = (next: PromptSnapshot['config']) => {
    if (baseRevision === undefined) {
      setBaseRevision(show.data!.revision)
      setBaseConfig(show.data!.config)
    }
    setConfig(next)
    setDirty(true)
  }
  const reloadDraft = async () => {
    try {
      const latest = await mutation.execute<PromptSnapshot>(['prompt', 'show'])
      setBaseRevision(latest.revision)
      setBaseConfig(latest.config)
      setConfig(latest.config)
      setRemoteRevision(latest.revision)
      setDirty(false)
      show.reload()
    } catch {
      // The reload error is already handled by the CLI request boundary.
    }
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    try {
      const result = await mutation.execute<PromptSnapshot>(['prompt','set','--base-revision',String(revision),'--file','-'], JSON.stringify(config))
      toast.success('Prompt 已保存为新版本')
      setBaseRevision(result.revision)
      setBaseConfig(result.config)
      setConfig(result.config)
      setRemoteRevision(result.revision)
      setDirty(false)
      show.reload(); history.reload()
    } catch {
      // mutation.error is rendered near the page.
    }
  }
  const previewDraft = async () => {
    try {
      const result = await mutation.execute<{ prompts: { orchestrator: string; assess: string; work: string } }>(['prompt','preview','--file','-'], JSON.stringify(config))
      setPreview(result)
    } catch {
      // mutation.error is rendered near the page.
    }
  }
  const versions = history.data?.versions ?? []
  const compareText = tab === 'compare' ? preview?.prompts.orchestrator ?? '' : ''
  return <>
    <PageHeader title="Prompt" description={`草稿基准版本 ${revision}${dirty ? '（未保存草稿）' : ''}`} />
    {mutation.error && <ErrorState error={mutation.error} />}
    {dirty && remoteRevision !== undefined && remoteRevision !== revision && <SectionCard title="服务器 Prompt 已更新" actions={<Button variant="outline" size="sm" onClick={() => void reloadDraft()}>重新加载并放弃草稿</Button>}>
      <p>草稿仍基于版本 {revision}，服务器当前为版本 {remoteRevision}。保存前请先重新加载草稿。</p>
    </SectionCard>}
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList><TabsTrigger value="edit">编辑</TabsTrigger><TabsTrigger value="preview">预览</TabsTrigger><TabsTrigger value="compare">比较</TabsTrigger><TabsTrigger value="history">历史与恢复</TabsTrigger></TabsList>
      <TabsContent value="edit"><form className="web-form" onSubmit={save}>
        {(['orchestrator','assess','work','shared'] as const).map(name => <label key={name} className="web-field"><span>{name}</span>
          <InputArea aria-label={name} disabled={mutation.busy} value={config[name]} onChange={event => editConfig({ ...config, [name]: event.target.value })} />
        </label>)}
        <Button type="submit" loading={mutation.busy}>保存新版本</Button>
      </form></TabsContent>
      <TabsContent value="preview"><div className="web-actions"><Button variant="outline" size="sm" loading={mutation.busy} onClick={() => void previewDraft()}>生成预览</Button></div>
        {preview ? <div className="web-card-grid"><SectionCard title="Orchestrator"><pre className="web-json">{preview.prompts.orchestrator}</pre></SectionCard>
          <SectionCard title="Assessor"><pre className="web-json">{preview.prompts.assess}</pre></SectionCard>
          <SectionCard title="Worker"><pre className="web-json">{preview.prompts.work}</pre></SectionCard></div> : <EmptyState label="尚未生成预览" />}
      </TabsContent>
      <TabsContent value="compare">{preview ? <>
        <SectionRule title="Orchestrator 与已保存配置" />
        <TextDiff lines={textLines(saved.orchestrator, compareText)} />
        <SectionRule title="Assessor 与已保存配置" />
        <TextDiff lines={textLines(saved.assess, preview.prompts.assess)} />
        <SectionRule title="Worker 与已保存配置" />
        <TextDiff lines={textLines(saved.work, preview.prompts.work)} />
      </> : <EmptyState label="先在预览页生成草稿" />}</TabsContent>
      <TabsContent value="history">{versions.length ? <div className="web-card-grid">{versions.map(version => <SectionCard key={version.revision} title={`版本 ${version.revision}`} actions={<StatusBadge value={version.savedAt ?? 'saved'} />}>
        <KeyValue entries={entries({ revision: version.revision, savedAt: version.savedAt })} />
        <ConfirmAction label="恢复此版本" title="恢复 Prompt 版本" description="恢复会创建新版本，不会覆写历史。" busy={mutation.busy} onConfirm={async () => {
          const restored = await mutation.execute<PromptSnapshot>(['prompt','restore',String(version.revision),'--base-revision',String(revision)])
          toast.success('已恢复为新版本')
          setBaseRevision(restored.revision); setBaseConfig(restored.config); setConfig(restored.config); setRemoteRevision(restored.revision); setDirty(false)
          show.reload(); history.reload()
        }} />
      </SectionCard>)}</div> : <EmptyState />}</TabsContent>
    </Tabs>
  </>
}

export function ConfigPage() {
  const state = useCli<JsonRecord>(['config', 'show'], 3000)
  const history = useCli<{ versions: JsonRecord[] }>(['config', 'history'], 5000)
  const mutation = useMutation<JsonRecord>()
  const [json, setJson] = useState('{\n}')
  const [baseRevision, setBaseRevision] = useState<number>()
  const [dirty, setDirty] = useState(false)
  const [remoteRevision, setRemoteRevision] = useState<number>()
  useEffect(() => {
    if (!state.data) return
    const revision = typeof state.data.revision === 'number' ? state.data.revision : 0
    setRemoteRevision(revision)
    if (!dirty) {
      const text = JSON.stringify(state.data.settings ?? {}, null, 2)
      setBaseRevision(revision)
      setJson(text)
    }
  }, [state.data, dirty])
  const pending = dataError(state, '暂无配置')
  if (pending) return <><PageHeader title="配置" description="部署、Policy、Eval 和 Worker 设置。" />{pending}</>
  if (!state.data) return <EmptyState label="暂无配置" />
  const revision = baseRevision ?? (typeof state.data.revision === 'number' ? state.data.revision : 0)
  const reloadDraft = async () => {
    try {
      const latest = await mutation.execute<JsonRecord>(['config', 'show'])
      const text = JSON.stringify(latest.settings ?? {}, null, 2)
      const latestRevision = typeof latest.revision === 'number' ? latest.revision : 0
      setBaseRevision(latestRevision)
      setJson(text)
      setRemoteRevision(latestRevision)
      setDirty(false)
      state.reload()
    } catch (error) {
      // Keep the visible request error in this component's existing state boundary.
      void error
    }
  }
  const importConfig = async (event?: FormEvent) => {
    event?.preventDefault()
    try {
      const result = await mutation.execute<JsonRecord>(['config','import','--base-revision',String(revision),'--file','-'], json)
      toast.success('配置已导入')
      const text = JSON.stringify(result.settings ?? JSON.parse(json), null, 2)
      const resultRevision = typeof result.revision === 'number' ? result.revision : revision
      setBaseRevision(resultRevision)
      setJson(text)
      setRemoteRevision(resultRevision)
      setDirty(false)
      state.reload(); history.reload()
    } catch {
      // mutation.error is rendered near the page.
    }
  }
  const versions = history.data?.versions ?? []
  return <>
    <PageHeader title="配置" description={`草稿基准版本 ${revision}${dirty ? '（未保存草稿）' : ''}`} />
    {mutation.error && <ErrorState error={mutation.error} />}
    {dirty && remoteRevision !== undefined && remoteRevision !== revision && <SectionCard title="服务器配置已更新" actions={<Button variant="outline" size="sm" onClick={() => void reloadDraft()}>重新加载并放弃草稿</Button>}>
      <p>草稿仍基于版本 {revision}，服务器当前为版本 {remoteRevision}。导入前请先重新加载草稿。</p>
    </SectionCard>}
    <SectionCard title="完整配置"><JsonPreview value={state.data.settings} /></SectionCard>
    <SectionRule title="导入完整 settings" />
    <form className="web-form" onSubmit={importConfig}>
      <InputArea aria-label="完整 settings JSON" disabled={mutation.busy} value={json} onChange={event => { setJson(event.target.value); setDirty(true); if (baseRevision === undefined) setBaseRevision(typeof state.data?.revision === 'number' ? state.data.revision : 0) }} />
      <ConfirmAction label="导入配置" title="导入完整 settings" description="导入不成功不会修改配置。" busy={mutation.busy} onConfirm={() => { void importConfig() }} />
    </form>
    <SectionRule title="配置历史" />
    {versions.length ? <div className="web-card-grid">{versions.map((version, index) => {
      const record = resultRecord(version)
      return <SectionCard key={typeof record.revision === 'number' ? record.revision : index} title={`版本 ${formatValue(record.revision)}`}><JsonPreview value={record} /></SectionCard>
    })}</div> : <EmptyState />}
  </>
}

export function ChatPage() {
  const [channel, setChannel] = useState('')
  const [text, setText] = useState('')
  const [as, setAs] = useState('')
  const [replyTo, setReplyTo] = useState('')
  const args = channel.trim() ? ['chat', channel.trim(), '--lines', '50'] : ['chat', 'none', '--lines', '20']
  const state = useCli<JsonRecord>(args, channel.trim() ? 1000 : 0, channel.trim() !== '')
  const mutation = useMutation<JsonRecord>()
  const send = async (event: FormEvent) => {
    event.preventDefault()
    if (!channel.trim() || !text.trim()) return
    const sendArgs = ['chat',channel.trim(),'--send',text.trim(), ...(as.trim() ? ['--as',as.trim()] : []), ...(replyTo.trim() ? ['--reply-to',replyTo.trim()] : [])]
    try {
      await mutation.execute(sendArgs)
      setText(''); toast.success('消息已发送'); state.reload()
    } catch {
      // mutation.error is rendered near the page.
    }
  }
  const messages = channel.trim() && state.data ? arrays(state.data.messages) : []
  return <>
    <PageHeader title="本地 Chat" description="仅通过本地 IM channel 发送和读取消息。" />
    {mutation.error && <ErrorState error={mutation.error} />}
    <form className="web-form" onSubmit={send}>
      <div className="web-inline"><Input aria-label="channel" value={channel} onChange={event => setChannel(event.target.value)} placeholder="channel" />
        <Input aria-label="发送者" value={as} onChange={event => setAs(event.target.value)} placeholder="发送者（可选）" />
        <Input aria-label="reply-to" value={replyTo} onChange={event => setReplyTo(event.target.value)} placeholder="reply-to（可选）" /></div>
      <InputArea aria-label="消息" value={text} onChange={event => setText(event.target.value)} />
      <Button type="submit" loading={mutation.busy} disabled={!channel.trim() || !text.trim()}>发送</Button>
    </form>
    {channel.trim() && (state.error ? <ErrorState error={state.error} /> : state.loading ? <LoadingState /> : messages.length ? <div className="web-card-grid">{messages.map((item, index) => {
      const message = resultRecord(item)
      return <SectionCard key={typeof message.id === 'string' ? message.id : index} title={formatValue(message.from)} actions={<StatusBadge value={message.at} />}><p>{formatValue(message.text)}</p></SectionCard>
    })}</div> : <EmptyState label="channel 暂无消息" />)}
  </>
}

export function CoordinatorPage() {
  const show = useCli<JsonRecord>(['coordinator','show'], 3000)
  const read = useCli<JsonRecord>(['coordinator','read','--lines','40'], 3000)
  const showPending = dataError(show, '暂无协调会话')
  const readPending = dataError(read, '暂无会话记录')
  return <>
    <PageHeader title="主协调会话" description="只读查看协调状态和最近会话内容。" />
    <SectionRule title="状态" />
    {showPending ?? <SectionCard title="Coordinator"><JsonPreview value={show.data} /></SectionCard>}
    <SectionRule title="最近记录" />
    {readPending ?? <SectionCard title="会话记录"><div className="web-card-grid">{arrays(read.data?.messages).map((message, index) =>
      <SectionCard key={typeof (resultRecord(message)).id === 'string' ? (resultRecord(message)).id as string : index} title={`消息 ${index + 1}`}><JsonPreview value={message} /></SectionCard>
    )}</div>{arrays(read.data?.messages).length === 0 && <EmptyState label="暂无主协调会话消息" />}</SectionCard>}
  </>
}
