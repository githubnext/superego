// Menus (Base UI): portalled and positioned, so a menu opened from a scrolling sidebar is never cut off; arrow keys,
// type-ahead, Escape and focus return work as in any native menu. Styled through Base UI's data attributes.
import type { ComponentProps, ReactNode } from 'react'
import { Menu as Base } from '@base-ui/react/menu'

/** The menu's surface: portal, positioner and popup in one. */
function Popup({ children, side = 'bottom', align = 'start', className = '' }: {
  children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; align?: 'start' | 'center' | 'end'; className?: string
}) {
  return (
    <Base.Portal>
      <Base.Positioner className="mu-layer" side={side} align={align} sideOffset={6}>
        <Base.Popup className={`mu-menu ${className}`}>{children}</Base.Popup>
      </Base.Positioner>
    </Base.Portal>
  )
}

/** A choice of one: a check marks the current. */
function RadioItem({ children, hint, ...props }: ComponentProps<typeof Base.RadioItem> & { hint?: ReactNode }) {
  return (
    <Base.RadioItem className="mu-menu__item" {...props}>
      <span>{children as ReactNode}</span>
      <span className="mu-menu__hint">{hint}<Base.RadioItemIndicator className="mu-menu__check">✓</Base.RadioItemIndicator></span>
    </Base.RadioItem>
  )
}

function CheckboxItem({ children, hint, ...props }: ComponentProps<typeof Base.CheckboxItem> & { hint?: ReactNode }) {
  return (
    <Base.CheckboxItem className="mu-menu__item" {...props}>
      <span>{children as ReactNode}</span>
      <span className="mu-menu__hint">{hint}<Base.CheckboxItemIndicator className="mu-menu__check">✓</Base.CheckboxItemIndicator></span>
    </Base.CheckboxItem>
  )
}

function Item({ children, hint, ...props }: ComponentProps<typeof Base.Item> & { hint?: ReactNode }) {
  return <Base.Item className="mu-menu__item" {...props}><span>{children as ReactNode}</span>{hint && <span className="mu-menu__hint">{hint}</span>}</Base.Item>
}

const GroupLabel = (props: ComponentProps<typeof Base.GroupLabel>) => <Base.GroupLabel className="mu-menu__label" {...props} />
const Separator = () => <Base.Separator className="mu-menu__separator" />

export const Menu = {
  Root: Base.Root, Trigger: Base.Trigger, Popup, Item, Group: Base.Group, GroupLabel, RadioGroup: Base.RadioGroup, RadioItem, CheckboxItem, Separator,
}
