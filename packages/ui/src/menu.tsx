// Menus (Base UI): portalled and positioned, so a menu opened from a scrolling sidebar is never cut off; arrow keys,
// type-ahead, Escape and focus return work as in any native menu. Styled through Base UI's data attributes.
import type { ComponentProps, ReactNode } from 'react'
import { Menu as Base } from '@base-ui/react/menu'
import { ContextMenu as BaseContext } from '@base-ui/react/context-menu'
import { CaretRightIcon } from '@phosphor-icons/react'

/** The menu's surface: portal, positioner and popup in one. */
function Popup({ children, side = 'bottom', align = 'start', className = '' }: {
  children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; align?: 'start' | 'center' | 'end'; className?: string
}) {
  return (
    <Base.Portal>
      <Base.Positioner className="superego-layer" side={side} align={align} sideOffset={6}>
        <Base.Popup className={`superego-menu ${className}`}>{children}</Base.Popup>
      </Base.Positioner>
    </Base.Portal>
  )
}

/** A choice of one: a check marks the current. */
function RadioItem({ children, hint, ...props }: ComponentProps<typeof Base.RadioItem> & { hint?: ReactNode }) {
  return (
    <Base.RadioItem className="superego-menu__item" {...props}>
      <span>{children as ReactNode}</span>
      <span className="superego-menu__hint">{hint}<Base.RadioItemIndicator className="superego-menu__check">✓</Base.RadioItemIndicator></span>
    </Base.RadioItem>
  )
}

function CheckboxItem({ children, hint, ...props }: ComponentProps<typeof Base.CheckboxItem> & { hint?: ReactNode }) {
  return (
    <Base.CheckboxItem className="superego-menu__item" {...props}>
      <span>{children as ReactNode}</span>
      <span className="superego-menu__hint">{hint}<Base.CheckboxItemIndicator className="superego-menu__check">✓</Base.CheckboxItemIndicator></span>
    </Base.CheckboxItem>
  )
}

function Item({ children, hint, ...props }: ComponentProps<typeof Base.Item> & { hint?: ReactNode }) {
  return <Base.Item className="superego-menu__item" {...props}><span>{children as ReactNode}</span>{hint && <span className="superego-menu__hint">{hint}</span>}</Base.Item>
}

/** An item that opens a menu of its own beside it (in a `SubmenuRoot`, with its `Popup` after). */
function SubmenuTrigger({ children, ...props }: ComponentProps<typeof Base.SubmenuTrigger>) {
  return (
    <Base.SubmenuTrigger className="superego-menu__item" {...props}>
      <span>{children as ReactNode}</span>
      <CaretRightIcon className="superego-menu__hint" size={11} aria-hidden />
    </Base.SubmenuTrigger>
  )
}

/** A submenu's surface: beside the item that opens it. */
function SubmenuPopup({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <Base.Portal>
      <Base.Positioner className="superego-layer" side="right" align="start" sideOffset={2} alignOffset={-5}>
        <Base.Popup className={`superego-menu ${className}`}>{children}</Base.Popup>
      </Base.Positioner>
    </Base.Portal>
  )
}

const GroupLabel = (props: ComponentProps<typeof Base.GroupLabel>) => <Base.GroupLabel className="superego-menu__label" {...props} />
const Separator = () => <Base.Separator className="superego-menu__separator" />

export const Menu = {
  Root: Base.Root, Trigger: Base.Trigger, Popup, Item, Group: Base.Group, GroupLabel, RadioGroup: Base.RadioGroup, RadioItem, CheckboxItem, Separator,
  SubmenuRoot: Base.SubmenuRoot, SubmenuTrigger, SubmenuPopup,
}

/** A context menu's surface: where the pointer was (or the long press). */
function ContextPopup({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <BaseContext.Portal>
      <BaseContext.Positioner className="superego-layer">
        <BaseContext.Popup className={`superego-menu ${className}`}>{children}</BaseContext.Popup>
      </BaseContext.Positioner>
    </BaseContext.Portal>
  )
}

/**
 * A menu opened by a right-click or a long press on what's inside its `Trigger`: the same items as `Menu`'s. The trigger
 * adds no box of its own (`display: contents`), so wrapping a button keeps the layout it's in.
 */
export const ContextMenu = {
  Root: BaseContext.Root,
  Trigger: (props: Omit<ComponentProps<typeof BaseContext.Trigger>, 'render'>) => <BaseContext.Trigger render={<span className="superego-context" />} {...props} />,
  Popup: ContextPopup,
}
