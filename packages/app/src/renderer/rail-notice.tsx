// A notice in the rail, above Settings: a mark in its tone (a dot on its icon; quiet, none), what it says as its
// tooltip, and all it says and offers in a popover beside it, opened by a click. Pressing one of its buttons closes it.
import { useState, type ComponentType, type ReactNode } from 'react'
import { Popover } from '@superego/ui'

export type NoticeTone = 'accent' | 'blocked' | 'error'

export function RailNotice({ kind, label, tone, icon: Icon, quiet = false, onOpen, children }: {
  /** Which notice it is, as a class: `rail-notice--<kind>`. */
  kind: string
  label: string
  tone: NoticeTone
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>
  /** Put off: no dot, the icon faint. */
  quiet?: boolean
  onOpen?(): void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) onOpen?.() }} side="right" align="end" tooltip={label}
      className="rail-notice__popup"
      trigger={(
        <button type="button" aria-label={label} className={`rail-notice rail-notice--${kind} rail-notice--${tone} ${quiet ? 'is-quiet' : ''} ${open ? 'is-open' : ''}`}>
          <Icon size={17} aria-hidden />
        </button>
      )}>
      <div onClick={(event) => { if ((event.target as Element).closest('button')) setOpen(false) }}>{children}</div>
    </Popover>
  )
}
