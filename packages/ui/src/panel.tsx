import type { HTMLAttributes, ReactNode } from 'react'

/** A titled surface. Extensions' panels are drawn in one. */
export function Panel({ title, actions, children, className = '', ...props }: Omit<HTMLAttributes<HTMLElement>, 'title'> & { title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={`mu-panel ${className}`} {...props}>
      {(title || actions) && <header className="mu-panel__header"><span className="mu-panel__title">{title}</span>{actions}</header>}
      <div className="mu-panel__body">{children}</div>
    </section>
  )
}
