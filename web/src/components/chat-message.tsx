import { useEffect, useState } from 'react'
import { Button } from '@nocoo/basalt/components/button'
import { Check, Copy } from '@nocoo/basalt/icons'

export interface ChatMessageProps {
  variant: 'user' | 'assistant'
  content: string
  author?: string
  className?: string
}

export function ChatMessage({ variant, content, author, className }: ChatMessageProps) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <article
      aria-label={`${author || (variant === 'user' ? 'You' : 'Assistant')} message`}
      className={`basalt-ui group min-w-0 space-y-basalt-content-gap ${className ?? ''}`}
    >
      <div className={`flex ${variant === 'user' ? 'justify-end' : 'justify-start'}`}>
        <div
          data-basalt-surface={variant === 'user' ? '' : undefined}
          className={`min-w-0 space-y-basalt-content-gap ${
            variant === 'user'
              ? 'max-w-[90%] rounded-basalt-lg px-basalt-panel-x py-basalt-panel-y'
              : 'w-full'
          }`}
        >
          {content && (
            <p className="whitespace-pre-wrap break-words text-basalt-base leading-[var(--basalt-line-relaxed)]">
              {content}
            </p>
          )}
        </div>
      </div>
      {content && (
        <div
          data-slot="chat-actions"
          className={`flex flex-wrap items-center gap-basalt-space-xs text-basalt-muted-foreground ${
            variant === 'user'
              ? 'justify-end -mr-[calc((var(--basalt-size-action)-var(--basalt-size-icon))/2)]'
              : '-ml-[calc((var(--basalt-size-action)-var(--basalt-size-icon))/2)]'
          }`}
        >
          <Button size="icon" variant="ghost" aria-label={copied ? 'Copied' : 'Copy message'} onClick={() => void copy()}>
            {copied ? <Check strokeWidth={1.5} /> : <Copy strokeWidth={1.5} />}
          </Button>
        </div>
      )}
    </article>
  )
}
