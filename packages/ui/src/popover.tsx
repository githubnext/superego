import type { ReactElement, ReactNode } from 'react'
import { Popover as Base } from '@base-ui/react/popover'
import { Tooltip } from '@base-ui/react/tooltip'

/**
 * A popover (Base UI) anchored to `trigger`, portalled above everything, closing on Escape or a click outside. With
 * `tooltip`, the trigger says that while pointed at.
 */
export function Popover({ trigger, children, open, onOpenChange, side = 'bottom', align = 'end', tooltip, className = '' }: {
  trigger: ReactElement; children: ReactNode; open?: boolean; onOpenChange?(open: boolean): void
  side?: 'top' | 'bottom' | 'left' | 'right'; align?: 'start' | 'center' | 'end'; tooltip?: ReactNode; className?: string
}) {
  const opener = <Base.Trigger render={trigger} />
  return (
    <Base.Root {...(open !== undefined ? { open } : {})} onOpenChange={(next) => onOpenChange?.(next)}>
      {tooltip === undefined ? opener : (
        <Tooltip.Root>
          <Tooltip.Trigger render={opener} />
          <Tooltip.Portal>
            <Tooltip.Positioner className="superego-layer" side={side} sideOffset={8}>
              <Tooltip.Popup className="superego-tooltip">{tooltip}</Tooltip.Popup>
            </Tooltip.Positioner>
          </Tooltip.Portal>
        </Tooltip.Root>
      )}
      <Base.Portal>
        <Base.Positioner className="superego-layer" side={side} align={align} sideOffset={6}>
          <Base.Popup className={`superego-popover ${className}`}>{children}</Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}
