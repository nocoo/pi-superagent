import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@nocoo/basalt'
import { DataTable, type DataTableColumn } from '@nocoo/basalt/components/data-table'
import { Input } from '@nocoo/basalt/components/input'
import { PageHeader } from '@nocoo/basalt/components/page-header'
import { formatValue, resultRecord, searchResultItems, useCli, type JsonRecord } from '../models'
import { formatTime, identityLabel, searchKind } from '../presentation'
import { EmptyState, SectionCard, dataError } from '../views'

export function SearchPage() {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const state = useCli<JsonRecord>(submitted ? ['search', submitted] : ['search', ''], 0, submitted !== '')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (query.trim()) setSubmitted(query.trim())
  }

  const pending = submitted ? dataError(state, '无搜索结果') : undefined
  const items = submitted ? searchResultItems(state.data).map(resultRecord) : []
  const columns: DataTableColumn<JsonRecord>[] = [
    { id: 'kind', header: '类型', width: 100, accessor: row => searchKind(row) },
    { id: 'title', header: '匹配内容', width: 440, wrap: true, accessor: row => formatValue(row.title ?? row.text ?? row.label ?? row.key ?? row.id) },
    { id: 'identity', header: '身份 / 来源', width: 180, accessor: row => identityLabel(row.actor ?? resultRecord(row.mandate).actor ?? row.source ?? row.ref) },
    { id: 'time', header: '时间', width: 160, accessor: row => formatTime(row.at ?? row.lastAt ?? row.updatedAt) },
  ]

  return <div className="sa-page">
    <PageHeader title="搜索" description="搜索 Trigger、Thread 和 Ticket。" filters={<form className="sa-search" onSubmit={submit}>
      <Input aria-label="搜索" autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="输入关键词" />
      <Button type="submit" disabled={!query.trim()}>搜索</Button>
    </form>} />

    {pending ?? (submitted ? items.length ? <SectionCard title={`搜索结果 · ${items.length} 条`} attached>
      <DataTable aria-label="搜索结果" edge="attached" data={items} columns={columns} getRowId={(row, index) => `${searchKind(row)}:${String(row.id ?? row.key ?? index)}`} />
    </SectionCard> : <EmptyState label="无搜索结果" /> : <EmptyState label="输入关键词后开始搜索" />)}
  </div>
}
