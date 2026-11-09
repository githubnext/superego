import type { HTMLAttributes, KeyboardEvent, ReactNode } from 'react'

export function List({ className = '', ...props }: HTMLAttributes<HTMLUListElement>) {
  return <ul role="listbox" className={`mu-list ${className}`} {...props} />
}

export function ListItem({ selected, leading, trailing, children, className = '', onClick, onKeyDown, ...props }:
  HTMLAttributes<HTMLLIElement> & { selected?: boolean; leading?: ReactNode; trailing?: ReactNode }) {
  // A row that does something is a stop for the keyboard: Enter or Space does it, ↑↓ go to the rows around it (in the
  // nearest [data-focus-scope], else its own list).
  const keys = (event: KeyboardEvent<HTMLLIElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    if ((event.key === 'Enter' || event.key === ' ') && onClick) { event.preventDefault(); event.currentTarget.click(); return }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const scope = event.currentTarget.closest('[data-focus-scope]') ?? event.currentTarget.parentElement
    const rows = [...(scope?.querySelectorAll<HTMLElement>('.mu-list-item[tabindex]') ?? [])]
    const next = rows[rows.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)]
    if (next) { event.preventDefault(); next.focus() }
  }
  return (
    <li role="option" aria-selected={selected} className={`mu-list-item ${selected ? 'is-selected' : ''} ${className}`}
      tabIndex={onClick ? (selected ? 0 : -1) : undefined} onClick={onClick} onKeyDown={keys} {...props}>
      {leading && <span className="mu-list-item__leading">{leading}</span>}
      <span className="mu-list-item__body">{children}</span>
      {trailing && <span className="mu-list-item__trailing">{trailing}</span>}
    </li>
  )
}
