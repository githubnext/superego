// What an extension draws, drawn apart: a component that throws shows a line saying so, with its error and a retry, in
// its own place, and the rest of the window carries on.
import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  /** Whose it is: "<name> failed to draw". */
  name: string
  children: ReactNode
  /** In running text (a chip, a link): a span rather than a block. */
  inline?: boolean
}

export class Contained extends Component<Props, { error: unknown }> {
  override state: { error: unknown } = { error: undefined }
  static getDerivedStateFromError(error: unknown) { return { error: error ?? new Error('Something was thrown') } }
  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`${this.props.name} failed to draw`, error, info.componentStack)
  }
  override render() {
    const { error } = this.state
    if (error === undefined) return this.props.children
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
