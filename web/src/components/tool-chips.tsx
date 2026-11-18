import { useState } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@nocoo/basalt'
import { Loader } from '@nocoo/basalt/components/loader'
import { Check, CircleAlert, FileText, Pencil, Sparkles, Terminal } from '@nocoo/basalt/icons'

export interface ToolStep {
  id: string
  kind: 'think' | 'read' | 'write' | 'run'
  label: string
  target?: string
  detail?: string
  status: 'pending' | 'running' | 'complete' | 'error'
}

export interface ToolChipsProps {
  steps: readonly ToolStep[]
  title?: string
  defaultOpen?: boolean
  className?: string
}

const ICONS = { think: Sparkles, read: FileText, write: Pencil, run: Terminal } as const

export function ToolChips({ steps, title, defaultOpen = true, className }: ToolChipsProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [expanded, setExpanded] = useState<string[]>([])
  const completed = steps.filter(step => step.status === 'complete').length

  const toggle = (id: string, next: boolean) => {
    setExpanded(current => next ? [...current, id] : current.filter(item => item !== id))
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={`basalt-ui w-full space-y-basalt-content-gap leading-[var(--basalt-line-body)] ${className ?? ''}`}
    >
      <CollapsibleTrigger className="rounded-basalt-sm px-basalt-row-x py-basalt-control-y text-basalt-muted-foreground">
        <span role="status">{title ?? `${steps.length} tool calls · ${completed} complete`}</span>
      </CollapsibleTrigger>
      <CollapsibleContent unstyled className="space-y-basalt-space-sm">
        {steps.map(step => {
          const Icon = ICONS[step.kind]
          return (
            <Collapsible
              key={step.id}
              open={expanded.includes(step.id)}
              onOpenChange={next => toggle(step.id, next)}
            >
              <CollapsibleTrigger
                aria-label={[step.label, step.target, step.status].filter(Boolean).join(' ')}
                className="w-full min-h-basalt-control items-start justify-between rounded-basalt-sm px-basalt-row-x py-basalt-row-y leading-basalt-row"
              >
                <span className="flex min-w-0 items-start gap-basalt-row-gap text-basalt-base leading-basalt-row">
                  <span className="flex h-[var(--basalt-line-row)] w-basalt-icon-lg shrink-0 items-center justify-center">
                    <Icon aria-hidden="true" className="size-basalt-icon-lg" strokeWidth={1.5} />
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-basalt-row-gap">
                    <span>{step.label}</span>
                    {step.target && (
                      <span className="max-w-full truncate font-mono text-basalt-base text-basalt-muted-foreground">
                        {step.target}
                      </span>
                    )}
                  </span>
                  <span
                    role="img"
                    aria-label={step.status}
                    className="flex h-[var(--basalt-line-row)] w-basalt-icon-sm shrink-0 items-center justify-center"
                  >
                    {step.status === 'running' ? (
                      <Loader size={12} showLabel={false} showElapsed={false} aria-hidden="true" />
                    ) : step.status === 'complete' ? (
                      <Check size={12} />
                    ) : step.status === 'error' ? (
                      <CircleAlert size={12} className="text-basalt-danger" />
                    ) : null}
                  </span>
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent unstyled className="pl-basalt-row-content pr-basalt-row-x pb-basalt-row-y">
                <p className="whitespace-pre-wrap break-words text-basalt-base text-basalt-muted-foreground">
                  {step.detail || 'No output yet'}
                </p>
              </CollapsibleContent>
            </Collapsible>
          )
        })}
        {steps.length === 0 && (
          <p className="px-basalt-row-x py-basalt-space-lg text-basalt-sm text-basalt-muted-foreground">
            No tool calls yet
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
