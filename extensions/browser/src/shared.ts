// What browser is, and its one kind of pane. All its work is in the window, so it has a UI half only: the app's daemon
// lists this `about` among its extensions, which tells the agent of its pane (`panes`) from the start. An HTML file's
// page is served by the core (the app's artifact origin, or Web access's /artifact/).
import type { ExtensionAbout } from '@superego/protocol'

/**
 * A web page, given `{ url }` (a dev server on the thread's machine, forwarded to the window when it's elsewhere; any
 * site), or an HTML file in the thread's folder, given `{ path }`, shown sandboxed from an origin of its own. Given
 * neither, a blank page with its address bar to type in.
 */
export const BROWSER = 'browser'

export type BrowserParams = { url?: string; path?: string }

export const about = {
  name: 'browser', version: '1.1.0', api: '^5.1', title: 'Browser', description: 'Web pages and HTML files the agent wrote, shown beside a thread.',
  panes: {
    [BROWSER]: '{ url } (a web page: a dev server running here at its localhost address, or any site) or { path } (an HTML file in the working folder; write it first)',
  },
} satisfies ExtensionAbout
