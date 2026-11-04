import type { ReactElement, ReactNode } from 'react'
import { Popover as Base } from '@base-ui/react/popover'

/** A popover (Base UI) anchored to `trigger`, portalled above everything, closing on Escape or a click outside. */
export function Popover({ trigger, children, open, onOpenChange, align = 'end', className = '' }: {
  trigger: ReactElement; children: ReactNode; open?: boolean; onOpenChange?(open: boolean): void; align?: 'start' | 'center' | 'end'; className?: string
}) {
  return (
    <Base.Root {...(open !== undefined ? { open } : {})} onOpenChange={(next) => onOpenChange?.(next)}>
      <Base.Trigger render={trigger} />
      <Base.Portal>
        <Base.Positioner className="mu-layer" side="bottom" align={align} sideOffset={6}>
          <Base.Popup className={`mu-popover ${className}`}>{children}</Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}
