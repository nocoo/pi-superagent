import { type FormEvent, type KeyboardEvent, useId, useRef, useState } from 'react'
import { Button } from '@nocoo/basalt/components/button'
import { Textarea } from '@nocoo/basalt/components/textarea'
import { ArrowUp } from '@nocoo/basalt/icons'

export interface ChatComposerProps {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
  label?: string
  placeholder?: string
  onSend: (text: string) => void | Promise<void>
  sendLabel?: string
  className?: string
}

export function ChatComposer({
  disabled = false,
  label = 'Message',
  placeholder,
  onSend,
  sendLabel = 'Send message',
  className,
  value,
  defaultValue = '',
  onValueChange,
}: ChatComposerProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultValue)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const ref = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)
  const errorId = useId()

  const text = value ?? uncontrolled
  const update = (next: string) => {
    if (value === undefined) setUncontrolled(next)
    onValueChange?.(next)
    if (error) setError(undefined)
  }

  const trimmed = text.trim()
  const canSend = !disabled && !pending && trimmed.length > 0

  const submit = async () => {
    if (!canSend) return
    setPending(true)
    setError(undefined)
    try {
      await onSend(trimmed)
      if (value === undefined) setUncontrolled('')
      ref.current?.focus()
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败')
    } finally {
      setPending(false)
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void submit()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void submit()
  }

  return (
    <form className={`basalt-ui shrink-0 ${className ?? ''}`} onSubmit={onSubmit}>
      <div className="basalt-focus-group rounded-basalt-lg bg-basalt-control p-basalt-space-lg ring-1 ring-basalt-border">
        <Textarea
          ref={ref}
          value={text}
          onChange={event => update(event.target.value)}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={placeholder}
          disabled={disabled || pending}
          aria-label={label}
          aria-describedby={error ? errorId : undefined}
          className="basalt-chat-input min-h-[calc(1lh+var(--basalt-space-2))] resize-none overflow-y-auto border-0 bg-transparent px-basalt-space-sm py-basalt-space-sm text-basalt-base leading-[var(--basalt-line-body)] shadow-none ring-0 outline-none"
        />
        <div className="mt-basalt-content-gap flex items-center justify-end gap-basalt-content-gap">
          <Button type="submit" size="icon" disabled={!canSend} loading={pending} aria-label={sendLabel}>
            <ArrowUp className="h-basalt-4 w-basalt-4" strokeWidth={2.25} />
          </Button>
        </div>
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-basalt-content-gap text-basalt-sm text-basalt-danger">
          {error}
        </p>
      )}
    </form>
  )
}
