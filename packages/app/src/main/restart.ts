// Restarting this computer's daemon onto newer code, after tremolo's: the app notices the code on disk differs from the
// running daemon's, and offers a restart. One intention for every window: restart now, when idle, or later. A restart
// never cuts off work unasked: the daemon refuses while threads work, unless interrupting was confirmed.
import type { ServiceAction, ServiceState } from '../shared/service.ts'

/** `runningBuild`: unknown of a daemon that refuses this app's protocol generation, and so never this one's. */
export type ServiceSnapshot = { installedBuild: string; runningBuild?: string; busy: boolean; refused: boolean }

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

  /** Tell watchers only of a real change: polls run every few seconds and mostly find nothing new. */
  #publish(patch: Partial<ServiceState>) {
    const next = { ...this.state, ...patch }
    for (const key of Object.keys(next) as (keyof ServiceState)[]) if (next[key] === undefined) delete next[key]
    if (JSON.stringify(next) === JSON.stringify(this.state)) return
    this.state = next
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
      // One that refused this app can't refuse a restart while busy: stopping it needs consent, as interrupting does.
      const interrupt = action === 'interrupt' || snapshot.refused
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
    if (verified.runningBuild !== running) throw new Error('Could not verify the restarted daemon. Try again.')
    this.#waiting = false
    this.#publish({ ...verified, phase: verified.installedBuild === running ? 'current' : 'required', error: undefined })
  }

  fail(error: unknown) {
    this.#waiting = false
    this.#publish({ phase: 'error', deferred: false, error: error instanceof Error ? error.message : String(error) })
  }
}
