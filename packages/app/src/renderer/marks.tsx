// What an extension draws in the window's own places, in the window's look: a chip among a thread's header chips, a mark
// on its row in the sidebar, a chip under a sent message, a button in the rail. And what extensions say of a thread (its
// facts), read typed.
import type { ComponentProps, ReactNode } from 'react'
import { IconButton } from '@superego/ui'
import type { Json, ThreadInfo } from '@superego/protocol'

/** In `header.chips`: a chip among those that say where a thread works (its branch, say), cut short to fit. */
export const HeaderChip = ({ children, title }: { children: ReactNode; title?: string }) => <span className="header__chip" title={title}>{children}</span>

/**
 * In `thread.badge`: a mark on a thread's row in the sidebar, an icon about 12px (`size={12}`). `label` says what it
 * means, to a screen reader and in its tooltip (`title` for a tooltip of its own).
 */
export const ThreadBadge = ({ children, label, title }: { children: ReactNode; label: string; title?: string }) => (
  <span className="thread-badge" title={title ?? label} role="img" aria-label={label}>{children}</span>
)

/** A chip like a file's under a message (a `sentWith` item, say): an icon, a name, and a tooltip. */
export const Chip = ({ icon, children, title }: { icon: ReactNode; children: ReactNode; title?: string }) => (
  <span className="attachment attachment--chip" title={title}>
    <span className="attachment__icon">{icon}</span>
    <span className="attachment__name">{children}</span>
  </span>
)

/**
 * In the rail (a space's own `railButton`, a `rail` view): a button as the rail draws its own, lit while `on`. On a
 * phone's drawer too. Its other props are an `IconButton`'s; `className` adds the extension's own.
 */
export const RailButton = ({ on = false, className = '', ...props }: ComponentProps<typeof IconButton> & { on?: boolean }) => (
  <IconButton className={`app__rail-button ${on ? 'is-on' : ''} ${className}`} {...props} />
)

/** What an extension says of a thread (its `facts`), by the extension's name or its `about`: `factsOf<Worktree>(thread, about)`. */
export const factsOf = <T = Json>(thread: ThreadInfo, extension: string | { name: string }): T | undefined =>
  thread.facts?.[typeof extension === 'string' ? extension : extension.name] as T | undefined
