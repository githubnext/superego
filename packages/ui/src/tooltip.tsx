import type { ReactElement, ReactNode } from 'react'
import { Tooltip as Base } from '@base-ui/react/tooltip'
import { usePortalAttributes } from './portal.tsx'

/** A tooltip (Base UI) on `children`, which must be one element that takes a ref (a button, say). */
export function Tooltip({ content, children, side = 'right' }: { content: ReactNode; children: ReactElement; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  const marked = usePortalAttributes()
  return (
    <Base.Root>
      <Base.Trigger render={children} />
      <Base.Portal>
        <Base.Positioner {...marked} className="superego-layer" side={side} sideOffset={8}>
          <Base.Popup className="superego-tooltip">{content}</Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}

/** Shares hover delays across tooltips: moving from one to the next shows it at once. */
export const TooltipProvider = Base.Provider
