import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger, toast } from '@nocoo/basalt'
import { Button } from '@nocoo/basalt/components/button'
import { InputArea } from '@nocoo/basalt/components/input-area'
import { PageHeader } from '@nocoo/basalt/components/page-header'
import { SectionRule } from '@nocoo/basalt/components/section-rule'
import { textLines } from '../diff'
import { arrays, formatValue, useCli, useMutation } from '../models'
import { formatTime, isCurrentRevision } from '../presentation'
import { ConfirmAction, EmptyState, ErrorState, KeyValue, LoadingState, SectionCard, StatusBadge, TextDiff, dataError } from '../views'

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
    if (!show.data || !isCurrentRevision(show.data.revision, baseRevision)) return
    setRemoteRevision(show.data.revision)
    if (!dirty) {
      setBaseRevision(show.data.revision)
      setBaseConfig(show.data.config)
      setConfig(show.data.config)
    }
  }, [show.data, dirty, baseRevision])

  const pending = dataError(show, '暂无 Prompt 配置')
  if (pending) return <><PageHeader title="Prompt" description="编辑、预览、比较和恢复配置版本。" />{pending}</>

  const data = show.data!
  const revision = baseRevision ?? data.revision
  const saved = baseConfig ?? data.config

  const editConfig = (next: PromptSnapshot['config']) => {
    if (baseRevision === undefined) {
      setBaseRevision(data.revision)
      setBaseConfig(data.config)
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
      // mutation.error is rendered near the page.
    }
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    try {
      const result = await mutation.execute<PromptSnapshot>(['prompt', 'set', '--base-revision', String(revision), '--file', '-'], JSON.stringify(config))
    toast.success('Prompt 已保存为新版本')
    setBaseRevision(result.revision)
    setBaseConfig(result.config)
    setConfig(result.config)
    setRemoteRevision(result.revision)
    setDirty(false)
    show.reload()
      history.reload()
    } catch {
      // mutation.error is rendered near the page.
    }
  }

  const previewDraft = async () => {
    try {
      const result = await mutation.execute<{ prompts: { orchestrator: string; assess: string; work: string } }>(['prompt', 'preview', '--file', '-'], JSON.stringify(config))
      setPreview(result)
    } catch {
      // mutation.error is rendered near the page.
    }
  }

  const versions = arrays(history.data?.versions)

  return <div className="sa-page">
    <PageHeader title="Prompt" description={`草稿基准版本 ${revision}${dirty ? '（未保存草稿）' : ''}`} />
    {mutation.error && <ErrorState error={mutation.error} />}
    {dirty && remoteRevision !== undefined && remoteRevision !== revision && <SectionCard title="服务器 Prompt 已更新" actions={<Button variant="outline" size="sm" onClick={() => void reloadDraft()}>重新加载并放弃草稿</Button>}>
      <p>草稿仍基于版本 {revision}，服务器当前为版本 {remoteRevision}。保存前请先重新加载草稿。</p>
    </SectionCard>}

    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="edit">编辑</TabsTrigger>
        <TabsTrigger value="preview">预览</TabsTrigger>
        <TabsTrigger value="compare">比较</TabsTrigger>
        <TabsTrigger value="history">历史与恢复</TabsTrigger>
      </TabsList>

      <TabsContent value="edit">
        <SectionCard title="Prompt 草稿">
        <form className="sa-form" onSubmit={save}>
          {(['orchestrator', 'assess', 'work', 'shared'] as const).map(name => <label key={name} className="sa-field"><span>{name}</span>
            <InputArea aria-label={name} disabled={mutation.busy} value={config[name]} onChange={event => editConfig({ ...config, [name]: event.target.value })} />
          </label>)}
          <div className="sa-actions"><Button type="submit" loading={mutation.busy}>保存新版本</Button></div>
        </form>
        </SectionCard>
      </TabsContent>

      <TabsContent value="preview">
        <div className="sa-actions"><Button variant="outline" size="sm" loading={mutation.busy} onClick={() => void previewDraft()}>生成预览</Button></div>
        {preview ? <div className="sa-grid">
          <SectionCard title="Orchestrator"><pre className="sa-json">{preview.prompts.orchestrator}</pre></SectionCard>
          <SectionCard title="Assessor"><pre className="sa-json">{preview.prompts.assess}</pre></SectionCard>
          <SectionCard title="Worker"><pre className="sa-json">{preview.prompts.work}</pre></SectionCard>
        </div> : <EmptyState label="尚未生成预览" />}
      </TabsContent>

      <TabsContent value="compare">
        <div className="sa-stack">
          <SectionCard title="Orchestrator 与已保存配置">
            <TextDiff lines={textLines(saved.orchestrator, config.orchestrator)} />
          </SectionCard>
          <SectionCard title="Assessor 与已保存配置">
            <TextDiff lines={textLines(saved.assess, config.assess)} />
          </SectionCard>
          <SectionCard title="Worker 与已保存配置">
            <TextDiff lines={textLines(saved.work, config.work)} />
          </SectionCard>
          <SectionRule title="Shared 与已保存配置" />
          <SectionCard title="Shared"><TextDiff lines={textLines(saved.shared, config.shared)} /></SectionCard>
        </div>
      </TabsContent>

      <TabsContent value="history">
        {history.error ? <ErrorState error={history.error} /> : history.loading ? <LoadingState /> : versions.length ? <div className="sa-grid">{versions.map((item, index) => {
          const version = item as PromptSnapshot
          return <SectionCard key={typeof version.revision === 'number' ? version.revision : index} title={`版本 ${formatValue(version.revision)}`} actions={<StatusBadge value={version.savedAt ?? 'saved'} />}>
            <KeyValue entries={[["版本", version.revision], ["保存时间", formatTime(version.savedAt)]]} />
            <ConfirmAction label="恢复此版本" title="恢复 Prompt 版本" description="恢复会创建新版本，不会覆写历史。" busy={mutation.busy} onConfirm={async () => {
              const restored = await mutation.execute<PromptSnapshot>(['prompt', 'restore', String(version.revision), '--base-revision', String(revision)])
              toast.success('已恢复为新版本')
              setBaseRevision(restored.revision)
              setBaseConfig(restored.config)
              setConfig(restored.config)
              setRemoteRevision(restored.revision)
              setDirty(false)
              show.reload()
              history.reload()
            }} />
          </SectionCard>
        })}</div> : <EmptyState />}
      </TabsContent>
    </Tabs>
  </div>
}
