import { ChatMessage } from '@nocoo/basalt/components/chat-message'
import { ToolChips } from '@nocoo/basalt/components/tool-chips'
import { PageHeader } from '@nocoo/basalt/components/page-header'
import { SectionRule } from '@nocoo/basalt/components/section-rule'
import { arrays, formatValue, resultRecord, useCli, type JsonRecord } from '../models'
import { formatTime, messageText, toolStatus, toolSummary } from '../presentation'
import { EmptyState, JsonPreview, KeyValue, SectionCard, dataError } from '../views'

export function CoordinatorPage() {
  const show = useCli<JsonRecord>(['coordinator', 'show'], 3000)
  const read = useCli<JsonRecord>(['coordinator', 'read', '--lines', '40'], 3000)
  const showPending = dataError(show, '暂无协调会话')
  const readPending = dataError(read, '暂无会话记录')

  const showData = show.data ?? {}
  const readData = read.data ?? {}
  const messages = readPending ? [] : arrays(readData.messages).map(resultRecord)

  return <div className="sa-page">
    <PageHeader title="主协调会话" description="只读查看协调状态和最近会话。" />

    <SectionRule title="状态" />
    {showPending ?? <SectionCard title="协调会话">
      <KeyValue entries={[
        ["会话文件", showData.sessionFile],
        ["会话文件存在", showData.exists === true ? '是' : showData.exists === false ? '否' : '—'],
        ["消息数", showData.messages],
        ["配置版本", showData.settingsRevision],
        ["Prompt 版本", showData.promptRevision],
      ]} />
      <JsonPreview value={showData} label="查看协调状态 JSON" />
    </SectionCard>}

    <SectionRule title="最近记录" />
    {readPending ?? (messages.length ? <div className="sa-chat-feed" aria-label="协调会话记录">
      {messages.map((message, index) => {
        const role = formatValue(message.role).toLowerCase()
        const user = role === 'user'
        const content = messageText(message)
        const at = formatTime(message.timestamp)
        if (role === 'toolresult' || role === 'tool_result') {
          return <SectionCard key={typeof message.id === 'string' ? message.id : index} title="工具结果">
            <ToolChips title="协调步骤" defaultOpen={false} steps={[{
              id: typeof message.id === 'string' ? message.id : String(index),
              kind: 'run',
              label: typeof message.toolName === 'string' ? message.toolName : '工具调用',
              detail: toolSummary(message),
              status: toolStatus(message),
            }]} />
          </SectionCard>
        }
        if (!content && ['thinking', 'system', 'toolcall', 'tool_call', 'write', 'report', 'orchestrator_ack'].includes(role)) return null
        if (!content) return null
        return <SectionCard key={typeof message.id === 'string' ? message.id : index} title={formatValue(message.role)}>
          <ChatMessage
            variant={user ? 'user' : 'assistant'}
            author={`${formatValue(message.role)}${at !== '—' ? ` · ${at}` : ''}`}
            content={content}
          />
        </SectionCard>
      })}
    </div> : <EmptyState label="暂无主协调会话消息" />)}

    {readData.details ? <><SectionRule title="高级详情" /><SectionCard title="会话详情"><JsonPreview value={readData.details} /></SectionCard></> : null}
  </div>
}
