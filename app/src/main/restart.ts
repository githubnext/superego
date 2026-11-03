// Restarting this computer's daemon onto newer code, after tremolo's: the app notices the code on disk differs from the
// running daemon's, and offers a restart. One intention for every window: restart now, when idle, or later. A restart
// never cuts off work unasked: the daemon refuses while sessions work, unless interrupting was confirmed.

export type ServicePhase = 'current' | 'required' | 'waiting' | 'restarting' | 'error'
export type ServiceState = {
  phase: ServicePhase
  installedBuild?: string
  runningBuild?: string
  /** Whether the daemon can refuse a restart while busy; an older one can only be stopped. */
  canRestartWhenIdle?: boolean
  busy: boolean
  /** "Later": the notice shrinks to a quiet reminder until reviewed. */
  deferred: boolean
  error?: string
}
export type ServiceAction = 'restart' | 'interrupt' | 'later' | 'review'
export type ServiceSnapshot = { installedBuild: string; runningBuild: string; busy: boolean; canRestartWhenIdle: boolean }

export type RestartIO = {
  inspect(): Promise<ServiceSnapshot>
  /** Restart, refusing ('busy') if work started since `inspect`, unless interrupting; resolves with the new build. */
  restart(snapshot: ServiceSnapshot, interrupt: boolean): Promise<'busy' | string>
  confirmInterruption(snapshot: ServiceSnapshot): Promise<boolean>
  changed(state: ServiceState): void
}

export class ServiceRestart {
  state: ServiceState = { phase: 'current', busy: false, deferred: false }
  #io: RestartIO
  /** Restart as soon as the daemon is idle. */
  #waiting = false
  #working = false
  #settled: Promise<void> = Promise.resolve()
  #release: (() => void) | undefined

  constructor(io: RestartIO) { this.#io = io }

  #publish(patch: Partial<ServiceState>) {
    this.state = { ...this.state, ...patch }
    this.#io.changed(this.state)
  }
  #begin() {
    this.#working = true
    this.#settled = new Promise((resolve) => { this.#release = resolve })
  }
  #end() { this.#working = false; this.#release?.() }

  /** Look again: is a restart needed, and if one waits for idle, is it idle now? */
  async poll() {
    if (this.#working) return
    this.#begin()
    try {
      const snapshot = await this.#io.inspect()
      const mismatch = snapshot.installedBuild !== snapshot.runningBuild
      const phase = !mismatch ? 'current' : this.#waiting ? 'waiting' : this.state.phase === 'error' ? 'error' : 'required'
      this.#publish({ ...snapshot, phase })
      if (!mismatch) { this.#waiting = false; this.#publish({ error: undefined, deferred: false }) }
      else if (this.#waiting && !snapshot.busy) await this.#perform(snapshot, false)
    } catch (error) { this.fail(error) } finally { this.#end() }
  }

  async act(action: ServiceAction): Promise<void> {
    if (action === 'later' && this.state.phase !== 'restarting') {
      this.#waiting = false
      this.#publish({ deferred: true, phase: this.state.phase === 'waiting' ? 'required' : this.state.phase })
      return
    }
    if (action === 'review') { this.#publish({ deferred: false }); return }
    if (this.#working) { await this.#settled; return this.act(action) }
    if (action === 'later') return
    this.#begin()
    try {
      let snapshot = await this.#io.inspect()
      if (snapshot.installedBuild === snapshot.runningBuild) {
        this.#waiting = false
        this.#publish({ ...snapshot, phase: 'current', error: undefined, deferred: false })
        return
      }
      // An older daemon can't refuse while busy: stopping it needs consent, as interrupting does.
      const interrupt = action === 'interrupt' || !snapshot.canRestartWhenIdle
      if (interrupt && snapshot.busy) {
        if (!await this.#io.confirmInterruption(snapshot)) return
        snapshot = await this.#io.inspect()
        if (snapshot.installedBuild === snapshot.runningBuild) { this.#waiting = false; this.#publish({ ...snapshot, phase: 'current', error: undefined }); return }
      }
      this.#waiting = !interrupt
      this.#publish({ ...snapshot, phase: 'waiting', deferred: false, error: undefined })
      if (interrupt || !snapshot.busy) await this.#perform(snapshot, interrupt)
    } catch (error) { this.fail(error) } finally { this.#end() }
  }

  async #perform(snapshot: ServiceSnapshot, interrupt: boolean) {
    this.#publish({ phase: 'restarting', error: undefined, deferred: false })
    const running = await this.#io.restart(snapshot, interrupt)
    if (running === 'busy') { this.#waiting = true; this.#publish({ phase: 'waiting', busy: true }); return }
    const verified = await this.#io.inspect()
    if (verified.runningBuild !== running) throw new Error('Could not verify the restarted background process. Try again.')
    this.#waiting = false
    this.#publish({ ...verified, phase: verified.installedBuild === running ? 'current' : 'required', error: undefined })
  }

  fail(error: unknown) {
    this.#waiting = false
    this.#publish({ phase: 'error', deferred: false, error: error instanceof Error ? error.message : String(error) })
  }
}
