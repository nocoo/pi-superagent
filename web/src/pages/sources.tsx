import { DataTable, type DataTableColumn } from '@nocoo/basalt/components/data-table'
import { PageHeader } from '@nocoo/basalt/components/page-header'
import { ResourceList } from '@nocoo/basalt/components/resource-list'
import { arrays, formatValue, resultRecord, useCli, type JsonRecord } from '../models'
import { formatTime, statusLabel } from '../presentation'
import { EmptyState, JsonPreview, SectionCard, StatusBadge, dataError } from '../views'

export function SourcesPage() {
  const state = useCli<JsonRecord>(['source'], 5000)
  const pending = dataError(state, '暂无 Source')
  if (pending) return <><PageHeader title="来源" description="查看 Source 接收、健康与读取状态。" />{pending}</>

  const sources = arrays(state.data?.sources).map(resultRecord)
  const columns: DataTableColumn<JsonRecord>[] = [
    { id: 'source', header: '来源', width: 160, accessor: row => formatValue(row.source ?? row.part) },
    { id: 'state', header: '状态', width: 100, sortValue: row => statusLabel(row.state), accessor: row => <StatusBadge value={row.state} /> },
    { id: 'enabled', header: '启用', width: 100, accessor: row => row.enabled === true ? '是' : row.enabled === false ? '否' : '—' },
    { id: 'received', header: '接收', width: 100, textAlign: 'end', sortValue: row => Number(row.received ?? -1), accessor: row => formatValue(row.received) },
    { id: 'filtered', header: '过滤', width: 100, textAlign: 'end', sortValue: row => Number(row.filtered ?? -1), accessor: row => formatValue(row.filtered) },
    { id: 'lastAt', header: '最近到达', width: 160, accessor: row => formatTime(row.lastAt) },
  ]

  return <div className="sa-page">
    <ResourceList
      title="来源"
      description={`${sources.length} 个来源${state.data?.running === true ? ' · 服务运行中' : ''}`}
      data={sources.map(row => ({ name: formatValue(row.source ?? row.part), status: statusLabel(row.state) }))}
    >
      {sources.length ? <SectionCard title="接收状态" attached><DataTable aria-label="来源" edge="attached" data={sources} columns={columns} getRowId={(row, index) => typeof row.source === 'string' ? row.source : String(index)} /></SectionCard> : <EmptyState />}
    </ResourceList>

    <SectionCard title="来源配置"><JsonPreview value={sources} label="查看来源配置与原始数据" /></SectionCard>
  </div>
}
