// What both halves agree on: the tools' names and how a task can end.

export const START = 'task_start'
export const FINISH = 'task_finish'

/** success: the goal was reached; failure: it wasn't; inconclusive: plans changed, it was dropped, or there's no proof. */
export const ENDINGS = ['success', 'failure', 'inconclusive'] as const
export type Ending = (typeof ENDINGS)[number]
