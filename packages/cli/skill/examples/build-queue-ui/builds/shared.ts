// What builds is, and the names its parts share.
export const about = { name: 'builds', version: '1.0.0', api: '^2', title: 'Build queue' }

/** Each thread's queue (`Build[]`): a scoped value, one scope per thread. */
export const QUEUE = 'builds.queue'
/** The queue beside the thread: the UI half's view. */
export const VIEW = 'builds.list'

export type Build = { id: string; command: string; state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; at: number }
