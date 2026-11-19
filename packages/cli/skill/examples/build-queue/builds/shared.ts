// What builds is, and the names its parts share.
export const about = { name: 'builds', version: '1.0.0', api: '^5', title: 'Build queue' }

/** Each thread's queue (`Build[]`), and what its view shows (`Block[]`): scoped values, one scope per thread. */
export const QUEUE = 'builds.queue'
export const VIEW = 'builds.view'

export type Build = { id: string; command: string; state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; at: number }
