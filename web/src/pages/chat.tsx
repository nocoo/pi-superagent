import { useState } from 'react'
import { toast } from '@nocoo/basalt'
import { ChatComposer } from '@nocoo/basalt/components/chat-composer'
import { ChatMessage } from '@nocoo/basalt/components/chat-message'
import { Input } from '@nocoo/basalt/components/input'
import { PageHeader } from '@nocoo/basalt/components/page-header'
import { arrays, formatValue, resultRecord, useCli, useMutation, type JsonRecord } from '../models'
import { formatTime, messageText, toolSummary } from '../presentation'
import { EmptyState, ErrorState, LoadingState, SectionCard } from '../views'

export function ChatPage() {
  const [channel, setChannel] = useState('')
  const [drafts, setDrafts] = useState<Record<string, { text: string; replyTo: string }>>({})
  const [as, setAs] = useState('')
  const key = channel.trim()
  const { text, replyTo } = drafts[key] ?? { text: '', replyTo: '' }
  const setText = (text: string) => setDrafts(current => ({ ...current, [key]: { ...current[key] ?? { replyTo: '' }, text } }))
  const setReplyTo = (replyTo: string) => setDrafts(current => ({ ...current, [key]: { ...current[key] ?? { text: '' }, replyTo } }))
  const args = channel.trim() ? ['chat', channel.trim(), '--lines', '50'] : ['chat', 'none', '--lines', '20']
  const state = useCli<JsonRecord>(args, channel.trim() ? 1000 : 0, channel.trim() !== '')
  const mutation = useMutation<JsonRecord>()

  const send = async (draft: string) => {
    if (!channel.trim() || !draft.trim()) return
    const sendArgs = ['chat', channel.trim(), '--send', draft.trim(), ...(as.trim() ? ['--as', as.trim()] : []), ...(replyTo.trim() ? ['--reply-to', replyTo.trim()] : [])]
    await mutation.execute(sendArgs)
    setText('')
    toast.success('消息已发送')
    state.reload()
  }

  const messages = channel.trim() && state.data ? arrays(state.data.messages).map(resultRecord) : []

  return <div className="sa-page">
    <PageHeader title="本地 Chat" description="通过本地 IM channel 发送和读取消息。" />
    {mutation.error && <ErrorState error={mutation.error} />}

    <SectionCard title="本地会话"><div className="sa-form">
    <div className="sa-toolbar-fields">
      <Input aria-label="channel" disabled={mutation.busy} value={channel} onChange={event => { setChannel(event.target.value); mutation.clearError() }} placeholder="channel" />
      <Input aria-label="发送者" disabled={mutation.busy} value={as} onChange={event => setAs(event.target.value)} placeholder="发送者（可选）" />
      <Input aria-label="reply-to" disabled={mutation.busy} value={replyTo} onChange={event => setReplyTo(event.target.value)} placeholder="reply-to（可选）" />
    </div>
    <ChatComposer
      className="sa-composer"
      label="消息"
      sendLabel="发送"
      placeholder="输入消息"
      value={text}
      onValueChange={setText}
      onSend={send}
      disabled={mutation.busy || !channel.trim()}
    />
    </div></SectionCard>

    {channel.trim() ? state.error ? <ErrorState error={state.error} /> : state.loading ? <LoadingState /> : messages.length ? <div className="sa-chat-feed" aria-label="聊天记录">
      {messages.map((message, index) => {
        const from = formatValue(message.from).toLowerCase()
        const assistant = message.kind === 'bot' || from === 'agent' || from === 'assistant'
        const content = messageText(message)
        const role = typeof message.role === 'string' ? message.role.toLowerCase() : ''
        if (!content && ['thinking', 'system', 'toolcall', 'tool_call', 'toolresult', 'tool_result', 'write', 'report', 'orchestrator_ack'].includes(role)) {
          return <SectionCard key={typeof message.id === 'string' ? message.id : index} title="工具与报告记录">
            <pre className="sa-json">{toolSummary(message)}</pre>
          </SectionCard>
        }
        if (!content) return null
        return <SectionCard key={typeof message.id === 'string' ? message.id : index} title={formatValue(message.from)}>
          <ChatMessage
            variant={assistant ? 'assistant' : 'user'}
            author={`${formatValue(message.from)}${message.at ? ` · ${formatTime(message.at)}` : ''}`}
            content={content}
          />
        </SectionCard>
      })}
    </div> : <EmptyState label="channel 暂无消息" /> : <EmptyState label="输入 channel 后读取消息" />}
  </div>
}
