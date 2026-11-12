import type { HTMLAttributes, ReactNode } from 'react'

/** A titled surface. Extensions' panels are drawn in one. */
export function Panel({ title, actions, children, className = '', ...props }: Omit<HTMLAttributes<HTMLElement>, 'title'> & { title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={`superego-panel ${className}`} {...props}>
      {(title || actions) && <header className="superego-panel__header"><span className="superego-panel__title">{title}</span>{actions}</header>}
      <div className="superego-panel__body">{children}</div>
    </section>
  )
}
