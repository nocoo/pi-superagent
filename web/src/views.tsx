import type { ReactNode } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger, Badge, Button, LayerCard,
} from '@nocoo/basalt'
import { DescriptionList } from '@nocoo/basalt/components/description-list'
import { formatValue } from './models'

export function LoadingState({ label = '正在读取…' }: { label?: string }) {
  return <p className="web-state" role="status">{label}</p>
}

export function ErrorState({ error }: { error: Error }) {
  return <p className="web-state web-error" role="alert">{error.message}</p>
}

export function EmptyState({ label = '暂无数据' }: { label?: string }) {
  return <p className="web-state web-muted" role="status">{label}</p>
}

export function SectionCard({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return <LayerCard>
    <LayerCard.Header>
      <div className="web-card-heading"><span>{title}</span>{actions}</div>
    </LayerCard.Header>
    <LayerCard.Body>{children}</LayerCard.Body>
  </LayerCard>
}

export function KeyValue({ entries }: { entries: readonly (readonly [string, unknown])[] }) {
  return <DescriptionList columns={2}>
    {entries.map(([name, value]) => <DescriptionList.Item key={name} term={name}>{formatValue(value)}</DescriptionList.Item>)}
  </DescriptionList>
}

export function TextDiff({ lines }: { lines: readonly { kind: 'same' | 'add' | 'remove'; text: string }[] }) {
  return <pre className="web-diff" aria-label="文本差异">
    {lines.map((line, index) => <span key={index} className={`web-diff-${line.kind}`}>
      {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}{line.text}{'\n'}
    </span>)}
  </pre>
}

export function JsonPreview({ value }: { value: unknown }) {
  return <pre className="web-json">{JSON.stringify(value, null, 2)}</pre>
}

export function StatusBadge({ value }: { value: unknown }) {
  const text = formatValue(value)
  const normalized = text.toLowerCase()
  const variant = normalized.includes('error') || normalized.includes('failed') || normalized.includes('blocked') || normalized.includes('stopped') ? 'destructive'
    : normalized.includes('ready') || normalized.includes('success') || normalized.includes('sent') || normalized.includes('working') ? 'default'
    : 'secondary'
  return <Badge variant={variant as 'default' | 'destructive' | 'secondary'}>{text}</Badge>
}

export function ConfirmAction({ label, title, description, confirmLabel = '确认', destructive = false,
  busy = false, onConfirm, children }: {
  label: ReactNode; title: string; description: string; confirmLabel?: string; destructive?: boolean; busy?: boolean
  onConfirm: () => void | Promise<void>; children?: ReactNode
}) {
  return <AlertDialog>
    <AlertDialogTrigger asChild><Button variant={destructive ? 'destructive' : 'outline'} size="sm" disabled={busy}>{label}</Button></AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      {children}
      <AlertDialogFooter>
        <AlertDialogCancel>取消</AlertDialogCancel>
        <AlertDialogAction onClick={() => { void (async () => { try { await onConfirm() } catch { /* action components render request errors */ } })() }}>{confirmLabel}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}
