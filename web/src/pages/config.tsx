import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger, toast } from '@nocoo/basalt'
import { Button } from '@nocoo/basalt/components/button'
import { InputArea } from '@nocoo/basalt/components/input-area'
import { PageHeader } from '@nocoo/basalt/components/page-header'
import { SectionRule } from '@nocoo/basalt/components/section-rule'
import { arrays, formatValue, resultRecord, useCli, useMutation, type JsonRecord } from '../models'
import { configSummary } from '../presentation'
import { ConfirmAction, EmptyState, ErrorState, JsonPreview, LoadingState, KeyValue, SectionCard, dataError } from '../views'

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
    if (!dirty && (baseRevision === undefined || revision >= baseRevision)) {
      setBaseRevision(revision)
      setJson(JSON.stringify(state.data.settings ?? {}, null, 2))
    }
  }, [state.data, dirty, baseRevision])

  const pending = dataError(state, '暂无配置')
  if (pending) return <><PageHeader title="配置" description="部署、Policy、Eval 和 Worker 设置。" />{pending}</>

  const data = state.data!
  const revision = baseRevision ?? (typeof data.revision === 'number' ? data.revision : 0)

  const reloadDraft = async () => {
    try {
      const latest = await mutation.execute<JsonRecord>(['config', 'show'])
    const latestRevision = typeof latest.revision === 'number' ? latest.revision : 0
    setBaseRevision(latestRevision)
    setJson(JSON.stringify(latest.settings ?? {}, null, 2))
    setRemoteRevision(latestRevision)
    setDirty(false)
      state.reload()
    } catch {
      // mutation.error is rendered near the page.
    }
  }

  const importConfig = async (event?: FormEvent) => {
    event?.preventDefault()
    try {
      const result = await mutation.execute<JsonRecord>(['config', 'import', '--base-revision', String(revision), '--file', '-'], json)
    toast.success('配置已导入')
    const text = JSON.stringify(result.settings ?? JSON.parse(json), null, 2)
    const resultRevision = typeof result.revision === 'number' ? result.revision : revision
    setBaseRevision(resultRevision)
    setJson(text)
    setRemoteRevision(resultRevision)
    setDirty(false)
    state.reload()
      history.reload()
    } catch {
      // mutation.error is rendered near the page.
    }
  }

  const versions = arrays(history.data?.versions).map(resultRecord)
  const summary = configSummary(data)

  return <div className="sa-page">
    <PageHeader title="配置" description={`草稿基准版本 ${revision}${dirty ? '（未保存草稿）' : ''}`} />
    {mutation.error && <ErrorState error={mutation.error} />}
    {dirty && remoteRevision !== undefined && remoteRevision !== revision && <SectionCard title="服务器配置已更新" actions={<Button variant="outline" size="sm" onClick={() => void reloadDraft()}>重新加载并放弃草稿</Button>}>
      <p>草稿仍基于版本 {revision}，服务器当前为版本 {remoteRevision}。导入前请先重新加载草稿。</p>
    </SectionCard>}

    <Tabs defaultValue="edit">
      <TabsList>
        <TabsTrigger value="edit">编辑草稿</TabsTrigger>
        <TabsTrigger value="current">当前配置</TabsTrigger>
        <TabsTrigger value="history">版本历史</TabsTrigger>
      </TabsList>

      <TabsContent value="edit">
        <SectionCard title="完整 settings 草稿">
        <form className="sa-form" onSubmit={event => { void importConfig(event) }}>
          <label className="sa-field"><span>完整 settings JSON</span>
            <InputArea aria-label="完整 settings JSON" disabled={mutation.busy} value={json} onChange={event => {
              setJson(event.target.value)
              setDirty(true)
              if (baseRevision === undefined) setBaseRevision(typeof data.revision === 'number' ? data.revision : 0)
            }} />
          </label>
          <div className="sa-actions"><ConfirmAction label="导入配置" title="导入完整 settings" description="导入不成功不会修改配置。" busy={mutation.busy} onConfirm={() => importConfig()} /></div>
        </form>
        </SectionCard>
      </TabsContent>

      <TabsContent value="current">
        <div className="sa-grid">
          <SectionCard title="运行模式"><KeyValue entries={[["暂停", summary.paused === true ? '是' : '否'], ["Eval 模式", summary.evalMode]]} /></SectionCard>
          <SectionCard title="模型"><KeyValue entries={[["Eval 模型", summary.evalModel], ["执行模型", summary.executorModel]]} /></SectionCard>
          <SectionCard title="并发与来源"><KeyValue entries={[["最大 Worker", summary.maxWorkers], ["启用来源", summary.sources]]} /></SectionCard>
          <SectionCard title="策略"><KeyValue entries={[["版本", data.policyVersion], ["规则数", summary.policyRules], ["配置版本", data.revision]]} /></SectionCard>
        </div>
        <SectionRule title="高级数据" />
        <SectionCard title="完整配置"><JsonPreview value={data.settings} /></SectionCard>
      </TabsContent>

      <TabsContent value="history">
        {history.error ? <ErrorState error={history.error} /> : history.loading ? <LoadingState /> : versions.length ? <div className="sa-grid">{versions.map((version, index) => {
          const record = resultRecord(version)
          return <SectionCard key={typeof record.revision === 'number' ? record.revision : index} title={`版本 ${formatValue(record.revision)}`}>
            <JsonPreview value={record} />
          </SectionCard>
        })}</div> : <EmptyState />}
      </TabsContent>
    </Tabs>
  </div>
}
