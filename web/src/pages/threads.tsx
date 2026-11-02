import { Button, toast } from '@nocoo/basalt'
import { DataTable, type DataTableColumn } from '@nocoo/basalt/components/data-table'
import { PageHeader } from '@nocoo/basalt/components/page-header'
import { ResourceList } from '@nocoo/basalt/components/resource-list'
import { SectionRule } from '@nocoo/basalt/components/section-rule'
import type { RoutePageProps } from '../App'
import { arrays, formatValue, resultRecord, useCli, useMutation, type JsonRecord } from '../models'
import { formatTime, identityLabel } from '../presentation'
import { ConfirmAction, EmptyState, ErrorState, JsonPreview, KeyValue, SectionCard, StatusBadge, dataError } from '../views'

export function ThreadsPage({ route, navigate }: RoutePageProps) {
  const key = route.startsWith('/threads/') ? decodeURIComponent(route.slice('/threads/'.length)) : undefined
  return key ? <ThreadDetail threadKey={key} navigate={navigate} /> : <ThreadList navigate={navigate} />
}

function ThreadList({ navigate }: { navigate: (path: string) => void }) {
  const state = useCli<JsonRecord>(['thread', 'list'], 5000)
  const pending = dataError(state, '暂无 Thread')
  if (pending) return <><PageHeader title="线程与事件" description="查看订阅、触发与最近活动。" />{pending}</>

  const threads = arrays(state.data?.threads).map(resultRecord)
  const columns: DataTableColumn<JsonRecord>[] = [
    { id: 'label', header: '线程', width: 220, accessor: row => formatValue(row.label ?? row.key) },
    { id: 'evaluating', header: '状态', width: 100, sortValue: row => row.evaluating ? 1 : 0, accessor: row => <StatusBadge value={row.evaluating ? 'evaluating' : 'idle'} /> },
    { id: 'triggers', header: 'Trigger', width: 100, textAlign: 'end', sortValue: row => Number(row.triggers ?? -1), accessor: row => formatValue(row.triggers) },
    { id: 'subscribed', header: '订阅 Ticket', width: 110, textAlign: 'end', sortValue: row => Number(row.subscribed ?? -1), accessor: row => formatValue(row.subscribed) },
    { id: 'lastAt', header: '最近活动', width: 160, accessor: row => formatTime(row.lastAt) },
    { id: 'actions', header: '操作', sortable: false, width: 100, accessor: row => typeof row.key === 'string'
      ? <Button variant="outline" size="sm" onClick={() => navigate(`/threads/${encodeURIComponent(row.key as string)}`)}>查看</Button>
      : null },
  ]

  return <div className="sa-page">
    <ResourceList
      title="线程与事件"
      description={`${threads.length} 个线程`}
      data={threads.map(row => ({ name: formatValue(row.label ?? row.key), status: row.evaluating ? '评估中' : '空闲' }))}
    >
      {threads.length ? <SectionCard title="会话列表" attached><DataTable aria-label="线程" edge="attached" data={threads} columns={columns} getRowId={(row, index) => typeof row.key === 'string' ? row.key : String(index)} /></SectionCard> : <EmptyState />}
    </ResourceList>
  </div>
}

function ThreadDetail({ threadKey, navigate }: { threadKey: string; navigate: (path: string) => void }) {
  const state = useCli<JsonRecord>(['thread', 'show', threadKey], 3000)
  const mutation = useMutation<JsonRecord>()
  const pending = dataError(state, 'Thread 不存在')
  if (pending) return <><PageHeader title="线程详情" description={threadKey} />{pending}</>

  const thread = resultRecord(state.data?.thread)
  const triggers = arrays(state.data?.triggers).map(resultRecord)
  const decisions = arrays(state.data?.decisions).map(resultRecord)

  const unsubscribe = async () => {
    await mutation.execute(['thread', 'unsubscribe', threadKey])
    toast.success('已取消订阅')
    state.reload()
  }

  const columns: DataTableColumn<JsonRecord>[] = [
    { id: 'actor', header: '身份', width: 180, accessor: row => identityLabel(row.actor) },
    { id: 'at', header: '时间', width: 160, accessor: row => formatTime(row.at) },
    { id: 'text', header: '内容', width: 320, wrap: true, accessor: row => formatValue(row.text) },
    { id: 'kind', header: '来源类型', width: 100, sortValue: row => row.human ? 'human' : 'machine', accessor: row => <StatusBadge value={row.human ? 'human' : 'machine'} /> },
    { id: 'actions', header: '操作', sortable: false, width: 100, accessor: row => typeof row.id === 'string'
      ? <Button variant="outline" size="sm" loading={mutation.busy} onClick={() => {
        void (async () => {
          try {
            await mutation.execute(['trigger', 'reevaluate', row.id as string])
            toast.success('已加入重评')
            state.reload()
          } catch {
            // mutation.error is rendered near the page.
          }
        })()
      }}>重评</Button>
      : null },
  ]

  return <div className="sa-page">
    <PageHeader title={formatValue(resultRecord(thread.meta).label ?? thread.key)} description={threadKey} actions={<>
      <Button variant="outline" size="sm" onClick={() => navigate('/threads')}>返回列表</Button>
      <ConfirmAction label="取消订阅" title="取消 Thread 订阅" description="会移除该 Thread 上全部 Ticket 的订阅。" destructive busy={mutation.busy} onConfirm={unsubscribe} />
    </>} />

    {mutation.error && <ErrorState error={mutation.error} />}

    <SectionCard title="线程摘要">
      <KeyValue entries={[["线程", thread.key], ["最近活动", thread.lastAt], ["订阅数", arrays(thread.subscriptions).length], ["评估中", thread.evaluating ? '是' : '否']]} />
    </SectionCard>

    <SectionRule title="Trigger 事件" />
    {triggers.length ? <SectionCard title="事件列表" attached>
      <DataTable aria-label="Thread Trigger" edge="attached" data={triggers} columns={columns} getRowId={(row, index) => typeof row.id === 'string' ? row.id : String(index)} />
    </SectionCard> : <EmptyState label="暂无 Trigger" />}

    <SectionRule title="相关决策" />
    {decisions.length ? <div className="sa-grid">{decisions.map((decision, index) => <SectionCard key={typeof decision.id === 'string' ? decision.id : index} title={formatValue(decision.kind)} actions={<StatusBadge value={decision.kind} />}>
      <KeyValue entries={[["决策 ID", decision.id], ["时间", formatTime(decision.at)], ["强度", decision.strength], ["Ticket", decision.ticketId ?? '—']]} />
    </SectionCard>)}</div> : <EmptyState />}

    <SectionRule title="高级数据" />
    <SectionCard title="原始线程数据"><JsonPreview value={state.data} /></SectionCard>
  </div>
}
