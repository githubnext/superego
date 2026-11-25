// A thread's actions as extensions add them (the `thread.menu` slot): one `ThreadMenuItem` takes the shape of where it's
// drawn, an item of the row's menu in the sidebar (Base UI's) or, on a phone, a row of the thread's sheet.
import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import { Menu } from '@superego/ui'
import { useShortcut } from './keys.ts'

type Icon = ComponentType<{ size?: number; 'aria-hidden'?: boolean }>

/** Where `thread.menu` is drawn: the row's menu (the default), or the phone's sheet, which closes once a row is chosen. */
const Shape = createContext<{ sheet: true; close(): void } | undefined>(undefined)
export const SheetMenu = ({ close, children }: { close(): void; children: ReactNode }) => <Shape.Provider value={{ sheet: true, close }}>{children}</Shape.Provider>

/**
 * An action on a thread, in its row's menu or its sheet: what it says, its icon (the sheet's), and the action whose keys
 * it shows (`keys`, an action's id).
 */
export function ThreadMenuItem({ icon, keys, onClick, children }: { icon?: Icon; keys?: string; onClick(): void; children: ReactNode }) {
  const shape = useContext(Shape)
  const hint = useShortcut(keys ?? '')
  if (shape) return <SheetItem id={keys ?? String(children)} icon={icon} onClick={() => { shape.close(); onClick() }}>{children}</SheetItem>
  return <Menu.Item onClick={onClick} hint={keys ? hint : undefined}>{children}</Menu.Item>
}

/** A row of the phone's sheet: its icon (a blank as wide, without), what it says, and a detail at its end. */
export function SheetItem({ id, icon: Icon, hint, checked, disabled, onClick, children }: {
  id: string; icon?: Icon | undefined; hint?: ReactNode; checked?: boolean; disabled?: boolean; onClick(): void; children: ReactNode
}) {
  return (
    <button type="button" className="superego-menu__item thread-sheet__item" data-item={id} disabled={disabled}
      aria-pressed={checked} onClick={onClick}>
      <span className="superego-menu__text thread-sheet__label">
        {Icon ? <Icon size={18} aria-hidden /> : <span className="thread-sheet__blank" />}
        <span className="thread-sheet__words">{children}</span>
      </span>
      {(hint || checked) && <span className="superego-menu__hint thread-sheet__hint">{hint && <span className="thread-sheet__detail">{hint}</span>}{checked && <span className="superego-menu__check">✓</span>}</span>}
    </button>
  )
}
