// What browser is, and its one kind of pane. All its work is in the window, so it has a UI half only: the app's daemon
// lists this `about` among its extensions, which tells the agent of its pane (`panes`) from the start. An HTML file's
// page is served by the core (the app's artifact origin, or Web access's /artifact/).
import type { ExtensionAbout } from '@superego/protocol'

/**
 * A web page, given `{ url }` (a dev server on the thread's machine, forwarded to the window when it's elsewhere; any
 * site), or an HTML file in the thread's folder, given `{ path }`, shown sandboxed from an origin of its own. Given
 * neither, a blank page with its address bar to type in. A site the agent opened beyond this computer and its network
 * loads once the user says so (`asksFirst`).
 */
export const BROWSER = 'browser'

/** The page's viewport, set from its toolbar: laid out at that width (and height), centred in the pane. None: the pane's. */
export type Viewport = { width: number; height?: number }

export type BrowserParams = { url?: string; path?: string; viewport?: Viewport }

export const about = {
  name: 'browser', version: '1.4.0', api: '^5.4', title: 'Browser', group: 'beside', description: 'Web pages and HTML files the agent wrote, shown beside a thread.',
  panes: {
    [BROWSER]: '{ url } (a web page: a dev server running here at its localhost address, or any site, which loads once the user says so) or { path } (an HTML file in the working folder; write it first); optional viewport: { width, height? } in px, to show it at that size',
  },
} satisfies ExtensionAbout
