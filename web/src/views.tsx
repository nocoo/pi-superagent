import type { ReactNode } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger, Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@nocoo/basalt'
import { DescriptionList } from '@nocoo/basalt/components/description-list'
import { Empty } from '@nocoo/basalt/components/empty'
import { Loader } from '@nocoo/basalt/components/loader'
import { SkeletonLine } from '@nocoo/basalt/components/skeleton-line'
import { LayerCard } from '@nocoo/basalt/components/layer-card'
import { formatValue } from './models'
import { statusLabel } from './presentation'

export function dataError<T>(state: { data?: T; loading: boolean; error?: Error; reload?: () => void }, fallback: string) {
  if (state.error) return <ErrorState error={state.error} reload={state.reload} />
  if (state.loading) return <LoadingState />
  if (state.data === undefined) return <EmptyState label={fallback} />
  return undefined
}

export function LoadingState({ label = '正在读取…' }: { label?: string }) {
  return <LayerCard className="sa-state sa-loading">
    <LayerCard.Loading label={label}>
      <Loader label={label} showElapsed={false} />
      <div className="sa-skeletons" aria-label={label}>
        <SkeletonLine height={10} maxWidth={90} />
        <SkeletonLine height={10} maxWidth={70} />
        <SkeletonLine height={10} maxWidth={55} />
      </div>
    </LayerCard.Loading>
  </LayerCard>
}

export function ErrorState({ error, reload }: { error: Error; reload?: () => void }) {
  return <LayerCard className="sa-state">
    <Empty role="alert" title="读取失败" description={error.message} action={reload ? <Button variant="outline" size="sm" onClick={reload}>重新加载</Button> : undefined} />
  </LayerCard>
}

export function EmptyState({ label = '暂无数据', reload }: { label?: string; reload?: () => void }) {
  return <LayerCard className="sa-state">
    <Empty role="status" title={label} action={reload ? <Button variant="outline" size="sm" onClick={reload}>重新加载</Button> : undefined} />
  </LayerCard>
}

export function SectionCard({ title, children, actions, className, attached = false }: {
  title: ReactNode
  children: ReactNode
  actions?: ReactNode
  className?: string
  attached?: boolean
}) {
  return <LayerCard className={`sa-panel ${className ?? ''}`}>
    <LayerCard.Header>
      <div className="sa-card-heading"><span>{title}</span>{actions}</div>
    </LayerCard.Header>
    {attached ? children : <LayerCard.Body>{children}</LayerCard.Body>}
  </LayerCard>
}

export function KeyValue({ entries }: { entries: readonly (readonly [string, unknown])[] }) {
  return <DescriptionList columns={2}>
    {entries.map(([name, value]) => <DescriptionList.Item key={name} term={name}>{formatValue(value)}</DescriptionList.Item>)}
  </DescriptionList>
}

export function TextDiff({ lines }: { lines: readonly { kind: 'same' | 'add' | 'remove'; text: string }[] }) {
  return <pre className="sa-diff" aria-label="文本差异">
    {lines.map((line, index) => <span key={index} className={`sa-diff-${line.kind}`}>
      {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}{line.text}{'\n'}
    </span>)}
  </pre>
}

export function JsonPreview({ value, label = '查看 JSON' }: { value: unknown; label?: string }) {
  return <Collapsible>
    <CollapsibleTrigger className="sa-json-trigger">{label}</CollapsibleTrigger>
    <CollapsibleContent>
      <pre className="sa-json" aria-label={label}>{JSON.stringify(value, null, 2)}</pre>
    </CollapsibleContent>
  </Collapsible>
}

export function StatusBadge({ value }: { value: unknown }) {
  const text = formatValue(value)
  const normalized = text.toLowerCase()
  const zh = statusLabel(value)
  const variant = normalized.includes('error') || normalized.includes('failed') || normalized.includes('blocked') || normalized.includes('stopped')
    ? 'destructive'
    : normalized.includes('ready') || normalized.includes('success') || normalized.includes('sent') || normalized.includes('working') || normalized.includes('accept')
      ? 'default'
      : 'secondary'
  return <Badge variant={variant as 'default' | 'destructive' | 'secondary'}>{zh}</Badge>
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
        <AlertDialogAction onClick={() => { void (async () => { try { await onConfirm() } catch { return } })() }}>{confirmLabel}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}
