// What both halves agree on: the tools' names, the pane kind, and the live value holding each thread's panes' UI.
import type { Block } from '@superego/blocks'
import type { ExtensionAbout } from '@superego/protocol'

export const OPEN = 'open_ui'
export const UPDATE = 'update_ui'
export const KIND = 'ui'
/**
 * Each thread's panes' UI, a scoped value by thread (`ThreadSpecs`): null until read from the thread (just after the
 * daemon starts), then what the agent last drew in each of its panes.
 */
export const SPECS = 'pane-ui.specs'
/** Read a thread's panes' UI back (`{ thread }`), publishing it in its scope of `SPECS`; answers it too. */
export const LOAD = 'pane-ui.load'

/** A pane's UI, as the agent last drew it. Its pane is opened with params `{ id }`. */
export type PaneSpec = { id: string; title: string; blocks: Block[]; at: number }

/** A thread's panes' UI, by the agent's id for each. */
export type ThreadSpecs = Record<string, PaneSpec>

/** What this extension is, for both halves: optional, so a machine can turn it off and a profile can do without it. */
export const about = {
  name: 'pane-ui', version: '1.0.0', api: '^2', title: 'UI in panes',
  description: 'Let the agent open panes of its own UI beside the thread: dashboards, checklists, controls.',
} satisfies ExtensionAbout
