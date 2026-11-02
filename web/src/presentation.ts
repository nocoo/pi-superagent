import { arrays, formatValue, resultRecord, type JsonRecord } from './models'

export function formatTime(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      }).format(date)
    }
  }
  if (typeof value !== 'string' || !value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

export function statusLabel(value: unknown): string {
  const text = formatValue(value).toLowerCase()
  const labels: Record<string, string> = {
    ready: '就绪', success: '成功', completed: '已完成', ended: '已结束', sent: '已发送',
    working: '执行中', person: '等待人工', waiting: '等待事件', idle: '空闲', stopped: '已停止',
    off: '已关闭', blocked: '受阻', unavailable: '不可用', evaluating: '评估中',
    accepting: '已接受', accept: '已接受', error: '错误', failed: '失败', pending: '待处理',
  }
  return labels[text] ?? formatValue(value)
}

export function stageLabel(value: unknown): string {
  const text = formatValue(value).toLowerCase()
  return text === 'person' ? '等待人工'
    : text === 'working' ? '执行中'
    : text === 'idle' ? '空闲'
    : text === 'ended' ? '已结束'
    : text === 'ready' ? '就绪'
    : statusLabel(value)
}

export function actionLabel(value: unknown): string {
  const text = formatValue(value).toLowerCase()
  const labels: Record<string, string> = {
    answer: '回答', note: '说明', attach: '关联触发器', retry: '重试', stop: '停单',
    requeststatus: '请求状态', review: '审核', reevaluate: '重评', unsubscribe: '取消订阅', dismiss: '取消提示',
  }
  return labels[text] ?? formatValue(value)
}

export function toolCallSummary(part: JsonRecord): string {
  const name = typeof part.name === 'string' ? part.name
    : typeof part.toolName === 'string' ? part.toolName
    : typeof part.function === 'object' && part.function !== null
      ? typeof (part.function as JsonRecord).name === 'string' ? (part.function as JsonRecord).name as string
      : '工具'
    : '工具'
  return `工具调用：${name}`
}

export function messageText(message: JsonRecord): string {
  const role = typeof message.role === 'string' ? message.role.toLowerCase() : ''
  if (['thinking', 'system', 'toolcall', 'tool_call', 'toolresult', 'tool_result', 'write', 'report', 'orchestrator_ack'].includes(role)) return ''
  if (typeof message.text === 'string') return message.text
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content.map(part => {
      const record = resultRecord(part)
      const type = typeof record.type === 'string' ? record.type.toLowerCase() : ''
      if (type === 'thinking' || type === 'reasoning' || type === 'toolresult' || type === 'tool_result') return ''
      if (type === 'toolcall' || type === 'tool_call') return toolCallSummary(record)
      if (typeof record.text === 'string') return record.text
      return ''
    }).filter(Boolean).join('\n')
  }
  return formatValue(message.text ?? message.content)
}

export function toolStatus(message: JsonRecord): 'complete' | 'error' | 'pending' {
  if (message.isError === true) return 'error'
  if (message.isError === false) return 'complete'
  return 'pending'
}

export function configSummary(data: JsonRecord): { paused: unknown; evalMode: unknown; evalModel: unknown; executorModel: unknown; maxWorkers: unknown; sources: unknown; policyRules: unknown } {
  const settings = resultRecord(data.settings)
  const evalSettings = resultRecord(settings.eval)
  const evalModel = resultRecord(evalSettings.model)
  const executor = resultRecord(settings.executor)
  const executorModel = resultRecord(executor.model)
  const sources = resultRecord(settings.sources)
  const enabledSources = Object.entries(sources).filter(([, value]) => resultRecord(value).enabled === true).map(([name]) => name)
  const policy = resultRecord(settings.policy)
  const rules = arrays(policy.rules)
  return {
    paused: settings.paused,
    evalMode: evalSettings.mode,
    evalModel: typeof evalModel.model === 'string' ? `${typeof evalModel.provider === 'string' ? `${evalModel.provider}/` : ''}${evalModel.model}` : '—',
    executorModel: typeof executorModel.model === 'string' ? `${typeof executorModel.provider === 'string' ? `${executorModel.provider}/` : ''}${executorModel.model}` : '—',
    maxWorkers: executor.maxWorkers,
    sources: enabledSources.length ? enabledSources.join('、') : '无启用来源',
    policyRules: rules.length,
  }
}

export function ticketProblem(ticket: JsonRecord, origin: JsonRecord): string {
  const attention = resultRecord(ticket.attention)
  if (typeof attention.question === 'string' && attention.question.trim()) return attention.question
  if (typeof origin.text === 'string' && origin.text.trim()) return origin.text
  const mandate = resultRecord(ticket.mandate)
  if (typeof mandate.scope === 'string' && mandate.scope.trim()) return mandate.scope
  return typeof ticket.title === 'string' ? ticket.title : '暂无任务问题'
}

export function ticketScope(ticket: JsonRecord): string {
  const mandate = resultRecord(ticket.mandate)
  return typeof mandate.scope === 'string' && mandate.scope.trim() ? mandate.scope : '—'
}

export function toolSummary(message: JsonRecord): string {
  const role = typeof message.role === 'string' ? message.role : '工具'
  if (typeof message.text === 'string') {
    const text = message.text.trim()
    if (text.length <= 160) return text
    return `${text.slice(0, 157)}…`
  }
  if (Array.isArray(message.content)) {
    const text = message.content.map(part => {
      const record = resultRecord(part)
      if (typeof record.text === 'string') return record.text
      return ''
    }).filter(Boolean).join('\n').trim()
    if (text) return text.length <= 160 ? text : `${text.slice(0, 157)}…`
  }
  return `${role} 调用记录`
}

export function ticketReport(ticket: JsonRecord): string {
  const assignments = arrays(ticket.assignments)
  for (let index = assignments.length - 1; index >= 0; index--) {
    const assignment = resultRecord(assignments[index])
    const report = resultRecord(assignment.report)
    if (typeof report.summary === 'string' && report.summary.trim()) return report.summary
  }
  if (typeof ticket.summary === 'string' && ticket.summary.trim()) return ticket.summary
  return '暂无最新报告'
}

export function ticketOutcome(ticket: JsonRecord): string {
  const ended = resultRecord(ticket.ended)
  if (typeof ended.outcome === 'string') return ended.outcome
  if (typeof ticket.summary === 'string') return ticket.summary
  const report = ticketReport(ticket)
  return report === '暂无最新报告' ? '—' : report
}

export function identityLabel(value: unknown): string {
  if (typeof value === 'string') return value
  const record = resultRecord(value)
  if (typeof record.id === 'string') return record.id
  if (typeof record.name === 'string') return record.name
  return '—'
}

export function searchKind(item: JsonRecord): 'Trigger' | 'Thread' | 'Ticket' {
  if (typeof item.key === 'string') return 'Thread'
  if (typeof item.id === 'string' && typeof item.title === 'string') return 'Ticket'
  return 'Trigger'
}

export function compactId(value: unknown): string {
  const text = formatValue(value)
  return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-5)}` : text
}
