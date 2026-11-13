// What both halves of web-panes agree on: what it is, and its two kinds of pane.
import type { ExtensionAbout } from '@superego/protocol'

/** A web page, given `{ url }`: a local dev server, docs. */
export const PREVIEW = 'preview'
/** An HTML file in the thread's folder, given `{ path }`, shown as a page: sandboxed, from an origin of its own. */
export const ARTIFACT = 'artifact'

/** What this extension is, for both halves: optional, so a machine can turn it off and a profile can do without it. */
export const about = { name: 'web-panes', title: 'Web panes', description: 'Web pages and HTML files the agent wrote, shown beside a thread.' } satisfies ExtensionAbout
