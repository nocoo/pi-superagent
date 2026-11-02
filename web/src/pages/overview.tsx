import { Badge, Button } from '@nocoo/basalt'
import { DataTable, type DataTableColumn } from '@nocoo/basalt/components/data-table'
import { PageHeader } from '@nocoo/basalt/components/page-header'
import { SectionRule } from '@nocoo/basalt/components/section-rule'
import { StatCard, StatGrid } from '@nocoo/basalt/charts/stat-card'
import { arrays, entries, formatValue, resultRecord, useCli, type JsonRecord } from '../models'
import { formatTime, stageLabel, statusLabel, ticketOutcome } from '../presentation'
import { EmptyState, KeyValue, SectionCard, StatusBadge, dataError } from '../views'

export function OverviewPage() {
  const status = useCli<JsonRecord>(['status'], 5000)
  const tickets = useCli<JsonRecord>(['ticket', 'list', '--all'], 5000)
  const statusError = dataError(status, '暂无状态')
  if (statusError) return <><PageHeader title="概览" description="运行事实与当前需要关注的事项。" />{statusError}</>
  const ticketsError = dataError(tickets, '暂无任务')

  const needs = arrays(status.data?.needsPerson)
  const system = arrays(status.data?.system)
  const policy = resultRecord(status.data?.policy)
  const ticketRows = arrays(tickets.data?.tickets).map(resultRecord)
  const ticketUnavailable = tickets.error !== undefined
  const ticketLoading = tickets.loading
  const waiting = ticketRows.filter(ticket => ticket.stage === 'person').length
  const working = ticketRows.filter(ticket => ticket.stage === 'working').length
  const readyHealth = system.map(resultRecord).filter(item => item.state === 'ready').length

  const needColumns: DataTableColumn<JsonRecord>[] = [
    { id: 'title', header: '事项', width: 220, sortValue: row => formatValue(row.title ?? row.id), accessor: row => typeof row.id === 'string'
      ? <Button variant="link" size="sm" onClick={() => { window.location.hash = `/tasks/${encodeURIComponent(row.id as string)}` }}>{formatValue(row.title ?? row.id)}</Button>
      : formatValue(row.title ?? row.id) },
    { id: 'stage', header: '状态', width: 100, sortValue: row => statusLabel(row.action ?? row.stage), accessor: row => <StatusBadge value={row.action ?? row.stage} /> },
    { id: 'needs', header: '待办', width: 260, wrap: true, accessor: row => formatValue(row.needs) },
  ]

  const healthColumns: DataTableColumn<JsonRecord>[] = [
    { id: 'part', header: '组件', width: 140, accessor: row => formatValue(row.part) },
    { id: 'state', header: '状态', width: 100, sortValue: row => statusLabel(row.state), accessor: row => <StatusBadge value={row.state} /> },
    { id: 'detail', header: '说明', wrap: true, accessor: row => formatValue(row.detail) },
  ]

  const recentColumns: DataTableColumn<JsonRecord>[] = [
    { id: 'title', header: '任务', width: 260, wrap: true, sortValue: row => formatValue(row.title ?? row.id), accessor: row => typeof row.id === 'string'
      ? <Button variant="link" size="sm" onClick={() => { window.location.hash = `/tasks/${encodeURIComponent(row.id as string)}` }}>{formatValue(row.title ?? row.id)}</Button>
      : formatValue(row.title ?? row.id) },
    { id: 'stage', header: '阶段', width: 100, sortValue: row => stageLabel(row.stage), accessor: row => <Badge variant="secondary">{stageLabel(row.stage)}</Badge> },
    { id: 'updatedAt', header: '更新时间', width: 150, accessor: row => formatTime(row.updatedAt) },
    { id: 'outcome', header: '结果', width: 220, wrap: true, accessor: row => ticketOutcome(row) },
  ]

  return <div className="sa-page">
    <PageHeader title="概览" description="运行事实、人工待办与最近任务。" />
    <StatGrid columns={4}>
      <StatCard title="全部任务" value={ticketUnavailable ? '—' : ticketLoading ? '—' : ticketRows.length} subtitle={ticketUnavailable ? '任务查询不可用' : ticketLoading ? '正在读取任务' : '当前 Ticket 总数'} status={ticketUnavailable ? <span role="status">不可用</span> : ticketLoading ? <span role="status">读取中</span> : undefined} />
      <StatCard title="等待人工" value={ticketUnavailable || ticketLoading ? '—' : waiting} subtitle={ticketUnavailable ? '任务查询不可用' : '需要人工输入或决策'} />
      <StatCard title="执行中" value={ticketUnavailable || ticketLoading ? '—' : working} subtitle={ticketUnavailable ? '任务查询不可用' : '正在运行的任务'} />
      <StatCard title="健康组件" value={readyHealth} subtitle={`共 ${system.length} 项系统健康检查`} />
    </StatGrid>

    <SectionRule title={`人工待办 (${needs.length})`} />
    {needs.length ? <SectionCard title="需要人工处理" attached actions={<Badge variant="secondary">{needs.length} 项</Badge>}>
      <DataTable aria-label="人工待办" edge="attached" data={needs.map(resultRecord)} columns={needColumns} getRowId={(row, index) => typeof row.id === 'string' ? row.id : String(index)} />
    </SectionCard> : <EmptyState label="当前无需人工处理" />}

    <SectionRule title="系统健康" />
    {system.length ? <SectionCard title="组件状态" attached>
      <DataTable aria-label="系统健康" edge="attached" data={system.map(resultRecord)} columns={healthColumns} getRowId={(row, index) => typeof row.part === 'string' ? row.part : String(index)} />
    </SectionCard> : <EmptyState />}

    <SectionRule title="近期任务" />
    {ticketsError ?? (ticketRows.length ? <SectionCard title="最近记录" attached>
      <DataTable aria-label="近期任务" edge="attached" data={ticketRows.slice().sort((a, b) => formatValue(b.updatedAt).localeCompare(formatValue(a.updatedAt)))} columns={recentColumns} getRowId={(row, index) => typeof row.id === 'string' ? row.id : String(index)} />
    </SectionCard> : <EmptyState label="暂无任务" />)}

    <SectionRule title="策略" />
    <SectionCard title="当前策略"><KeyValue entries={entries(policy)} /></SectionCard>
  </div>
}
