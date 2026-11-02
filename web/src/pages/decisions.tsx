import { toast } from '@nocoo/basalt'
import { DataTable, type DataTableColumn } from '@nocoo/basalt/components/data-table'
import { PageHeader } from '@nocoo/basalt/components/page-header'
import { SectionRule } from '@nocoo/basalt/components/section-rule'
import { arrays, formatValue, resultRecord, useCli, useMutation, type JsonRecord } from '../models'
import { formatTime, statusLabel } from '../presentation'
import { ConfirmAction, EmptyState, ErrorState, JsonPreview, SectionCard, StatusBadge, dataError } from '../views'

export function DecisionsPage() {
  const state = useCli<JsonRecord>(['decision', 'list', '--since', '24h'], 5000)
  const mutation = useMutation<JsonRecord>()
  const pending = dataError(state, '暂无决策')
  if (pending) return <><PageHeader title="决策" description="查看 Eval 结论与规则匹配事实。" />{pending}</>

  const decisions = arrays(state.data?.decisions).map(resultRecord)
  const columns: DataTableColumn<JsonRecord>[] = [
    { id: 'kind', header: '结论', width: 120, sortValue: row => statusLabel(row.kind), accessor: row => <StatusBadge value={row.kind} /> },
    { id: 'at', header: '时间', width: 160, accessor: row => formatTime(row.at) },
    { id: 'thread', header: '线程', width: 180, accessor: row => formatValue(row.threadKey) },
    { id: 'strength', header: '强度', width: 100, accessor: row => statusLabel(row.strength) },
    { id: 'ticket', header: 'Ticket', width: 150, accessor: row => formatValue(row.ticketId ?? '—') },
    { id: 'actions', header: '操作', sortable: false, width: 120, accessor: row => row.kind === 'unavailable' && row.dismissed !== true && typeof row.id === 'string'
      ? <ConfirmAction label="取消提示" title="取消不可用决策提示" description="只移除当前未判定决策的问题提示。" busy={mutation.busy} onConfirm={async () => {
        await mutation.execute(['decision', 'dismiss', row.id as string])
        toast.success('已处理')
        state.reload()
      }} />
      : null },
  ]

  return <div className="sa-page">
    <PageHeader title="决策" description="查看 Eval 结论与规则匹配事实。" />
    {mutation.error && <ErrorState error={mutation.error} />}
    {decisions.length ? <SectionCard title={`过去 24 小时 · ${decisions.length} 条决策`} attached>
      <DataTable aria-label="决策" edge="attached" data={decisions} columns={columns} getRowId={(row, index) => typeof row.id === 'string' ? row.id : String(index)} />
    </SectionCard> : <EmptyState />}
    <SectionCard title="审计数据"><JsonPreview value={decisions} label="查看完整决策记录" /></SectionCard>
  </div>
}
