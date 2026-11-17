// What web-panes is, and its two kinds of pane. All its work is in the window, so it has a UI half only: the app's
// daemon lists this `about` among its extensions, which tells the agent of its panes (`panes`) from the start. An artifact's files are served by the core
// (the app's artifact origin, or Web access's /artifact/).
import type { ExtensionAbout } from '@superego/protocol'

/** A web page, given `{ url }`: a dev server on the thread's machine (forwarded to the window when it's elsewhere), docs. */
export const PREVIEW = 'preview'
/** An HTML file in the thread's folder, given `{ path }`, shown as a page: sandboxed, from an origin of its own. */
export const ARTIFACT = 'artifact'

export const about = {
  name: 'web-panes', version: '1.0.0', api: '^3', title: 'Web panes', description: 'Web pages and HTML files the agent wrote, shown beside a thread.',
  panes: {
    [PREVIEW]: '{ url }: a web page, such as a dev server running here, at its localhost address',
    [ARTIFACT]: '{ path }: an HTML file in the working folder, shown as a page; write it first',
  },
} satisfies ExtensionAbout
