import type { HTMLAttributes, ReactNode } from 'react'

export function List({ className = '', ...props }: HTMLAttributes<HTMLUListElement>) {
  return <ul role="listbox" className={`mu-list ${className}`} {...props} />
}

export function ListItem({ selected, leading, trailing, children, className = '', ...props }:
  HTMLAttributes<HTMLLIElement> & { selected?: boolean; leading?: ReactNode; trailing?: ReactNode }) {
  return (
    <li role="option" aria-selected={selected} className={`mu-list-item ${selected ? 'is-selected' : ''} ${className}`} {...props}>
      {leading && <span className="mu-list-item__leading">{leading}</span>}
      <span className="mu-list-item__body">{children}</span>
      {trailing && <span className="mu-list-item__trailing">{trailing}</span>}
    </li>
  )
}
