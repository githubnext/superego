// Updating the released app itself: what Squirrel.Mac (Electron's autoUpdater) says, as the state the windows show
// (shared/updates.ts), and what they can ask of it. The wiring to Electron is app-updates.ts; this is the logic alone.
//
// A check finds a newer release in the feed and downloads it in the background; then it's `ready`, and Squirrel installs
// it as the app quits. Restarting for it (`install`) first makes the daemon safe (stopped, with working agents asked
// about: they resume after), since the daemon runs from inside the app that's about to be replaced. Once one is ready,
// the app stops checking. A check that fails because this computer is offline, and nobody asked for it, says nothing.
import type { UpdateState } from '../shared/updates.ts'

export type UpdaterIO = {
  /** Start a check (autoUpdater.checkForUpdates): its outcome comes as one of the events below. */
  check(): void
  /** Whether this computer is online now. */
  online(): boolean
  /** Make way for the update: the daemon stopped, asking first while agents work there. False: the user said no. */
  prepare(): Promise<boolean>
  /** Quit, install and start again (autoUpdater.quitAndInstall). */
  install(): void
  /** The install failed and the app goes on: undo what `prepare` did (link to the daemon again). */
  recover(): void
  changed(state: UpdateState): void
}

const settled = (state: UpdateState) => state.phase !== 'checking'

export class Updates {
  state: UpdateState
  #io: UpdaterIO
  #waiting: ((state: UpdateState) => void)[] = []

  constructor(version: string, io: UpdaterIO | undefined) {
    this.state = { phase: io ? 'idle' : 'off', version }
    // Without an updater the state never changes: nothing calls it.
    this.#io = io ?? { check() {}, online: () => true, prepare: async () => false, install() {}, recover() {}, changed() {} }
  }

  #publish(patch: Partial<UpdateState>, drop: (keyof UpdateState)[] = []) {
    const next: UpdateState = { ...this.state, ...patch }
    for (const key of drop) delete next[key]
    this.state = next
    this.#io.changed(next)
    if (settled(next)) for (const resolve of this.#waiting.splice(0)) resolve(next)
  }

  /**
   * Look for a newer release, unless one is being looked for, fetched or is ready already. `asked`: someone asked, so
   * the outcome is theirs to see, offline included. Resolves with where the check left it.
   */
  check(asked = false): Promise<UpdateState> {
    const { phase } = this.state
    if (phase === 'off' || phase === 'downloading' || phase === 'ready' || phase === 'installing') return Promise.resolve(this.state)
    const done = new Promise<UpdateState>((resolve) => this.#waiting.push(resolve))
    if (phase === 'checking') {
      if (asked && !this.state.asked) this.#publish({ asked })
      return done
    }
    this.#publish({ phase: 'checking', asked }, ['error', 'failed'])
    try { this.#io.check() } catch (error) { this.failed(error) }
    return done
  }

  /** Restart onto the update that's ready, once the daemon is safe. */
  async install(): Promise<void> {
    if (this.state.phase !== 'ready') return
    this.#publish({ phase: 'installing' }, ['error', 'failed'])
    try {
      if (!await this.#io.prepare()) { this.#publish({ phase: 'ready' }); return }
      this.#io.install()
    } catch (error) { this.failed(error) }
  }

  // What the updater says.
  checking() { if (this.state.phase !== 'checking') this.#publish({ phase: 'checking' }, ['error', 'failed']) }
  available() { this.#publish({ phase: 'downloading' }) }
  notAvailable() { this.#publish({ phase: 'idle', checked: Date.now() }, ['asked']) }
  downloaded(next: string) { this.#publish({ phase: 'ready', next }, ['error', 'failed']) }
  failed(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const { phase, asked } = this.state
    const failed = phase === 'installing' ? 'install' : phase === 'downloading' ? 'download' : 'check'
    console.error(`Updating the app (${failed}): ${message}`)
    // Still downloaded: Restart can be tried again.
    if (failed === 'install') { this.#io.recover(); this.#publish({ phase: 'ready', error: message, failed }); return }
    // Offline, a check the app made on its own fails as expected: it tries again at the next one.
    if (failed === 'check' && !asked && !this.#io.online()) { this.#publish({ phase: 'idle' }, ['asked']); return }
    this.#publish({ phase: 'error', error: failed === 'check' && !this.#io.online() ? `${message} (offline)` : message, failed })
  }
}
