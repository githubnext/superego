// What an extension draws, drawn apart: a component that throws shows a line saying so, with its error and a retry, in
// its own place, and the rest of the window carries on. A profile's is drawn inside its scope's mark, which its styles
// reach (profile-style.ts), and so is what it portals out through the window's components (a menu, `PaneHeader`).
import { Component, useMemo, type ErrorInfo, type ReactNode } from 'react'
import { PortalAttributesContext } from '@superego/ui'
import { SCOPE_ATTRIBUTE, scopeMark } from './profile-style.ts'

type Props = {
  /** Whose it is: "<name> failed to draw". */
  name: string
  children: ReactNode
  /** In running text (a chip, a link): a span rather than a block. */
  inline?: boolean
  /** The profile's scope it's of (`Owner.profile`), if a profile's. */
  scope?: string | undefined
}

export class Contained extends Component<Props, { error: unknown }> {
  override state: { error: unknown } = { error: undefined }
  static getDerivedStateFromError(error: unknown) { return { error: error ?? new Error('Something was thrown') } }
  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`${this.props.name} failed to draw`, error, info.componentStack)
  }
  override render() {
    const { error } = this.state
    if (error === undefined) return this.props.scope === undefined ? this.props.children : <ProfileScope scope={this.props.scope} inline={this.props.inline}>{this.props.children}</ProfileScope>
    const message = error instanceof Error ? error.message : String(error)
    const Box = this.props.inline ? 'span' : 'div'
    return (
      <Box className={`extension-failed${this.props.inline ? ' extension-failed--inline' : ''}`} role="alert">
        <span className="extension-failed__what">{this.props.name} failed to draw</span>
        {message && <code className="extension-failed__error" title={message}>{message}</code>}
        <button type="button" className="extension-failed__retry" onClick={() => this.setState({ error: undefined })}>Retry</button>
      </Box>
    )
  }
}

/**
 * Marks what's inside as a profile's (`scope`), for its styles: an element of no box of its own (`display: contents`),
 * so the layout it's in is as without it. An empty one counts as nothing where the window hides what draws nothing.
 */
export function ProfileScope({ scope, inline, children }: { scope: string; inline?: boolean | undefined; children: ReactNode }) {
  const mark = scopeMark(scope)
  const attributes = useMemo(() => ({ [SCOPE_ATTRIBUTE]: mark }), [mark])
  const Box = inline ? 'span' : 'div'
  return (
    <PortalAttributesContext.Provider value={attributes}>
      <Box className="profile-scope" {...attributes}>{children}</Box>
    </PortalAttributesContext.Provider>
  )
}
