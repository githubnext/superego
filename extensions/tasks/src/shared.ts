// What both halves agree on: the tools' names and how a task can end.
import type { ExtensionAbout } from '@superego/protocol'

export const START = 'task_start'
export const FINISH = 'task_finish'

/** success: the goal was reached; failure: it wasn't; inconclusive: plans changed, it was dropped, or there's no proof. */
export const ENDINGS = ['success', 'failure', 'inconclusive'] as const
export type Ending = (typeof ENDINGS)[number]

/** What this extension is, for both halves: optional, so a machine can turn it off and a profile can do without it. */
export const about = { name: 'tasks', version: '1.0.0', api: '^1', title: 'Task reporting', description: 'Report work as a few titled tasks, each with how it went.' } satisfies ExtensionAbout
