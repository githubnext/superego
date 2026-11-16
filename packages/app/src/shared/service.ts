// Restarting this computer's daemon onto newer code, as the window sees it (see main/restart.ts): where it stands, and
// what the window can ask.

export type ServicePhase = 'current' | 'required' | 'waiting' | 'restarting' | 'error'
export type ServiceState = {
  phase: ServicePhase
  installedBuild?: string
  runningBuild?: string
  /** Whether the daemon refused this app for speaking another protocol generation: it can only be stopped. */
  refused?: boolean
  busy: boolean
  /** "Later": the notice shrinks to a quiet reminder until reviewed. */
  deferred: boolean
  error?: string
}
export type ServiceAction = 'restart' | 'interrupt' | 'later' | 'review'
