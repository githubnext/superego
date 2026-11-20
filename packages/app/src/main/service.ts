// This computer's daemon as a service of the app's: restarted onto newer code (the ServiceRestart state machine,
// restart.ts, wired to the local link here), and stopped with its agents when quitting asks for it, or for an update of
// the app it runs from.
import { readFileSync } from 'node:fs'
import { app } from 'electron'
import { pidPath, readBuild } from '@superego/daemon/client'
import type { AppConfig } from '@superego/protocol'
import type { ServiceState } from '../shared/service.ts'
import { agentsAre, confirm } from './dialogs.ts'
import type { Machines } from './machines.ts'
import { ServiceRestart } from './restart.ts'
import { waitUntil } from './wait.ts'

/** Its callbacks are never called while it's being made: what they reach may be made after it. */
export type ServiceOptions = {
  app: AppConfig
  dataDir: string
  headless: boolean
  /**
   * A packaged app's daemon runs from inside the app, so finding it out of date as the app starts means the app was
   * replaced under it (updated as it quit, say): then it restarts on its own, as soon as no agent is working.
   */
  restartsAfterUpdate: boolean
  machines: Pick<Machines, 'local' | 'working' | 'restartLocal' | 'allLinks'>
  changed(state: ServiceState): void
}

export type Service = ReturnType<typeof createService>

export function createService({ app: appConfig, dataDir, headless, restartsAfterUpdate, machines, changed }: ServiceOptions) {
  /** The local link once it is connected with a new daemon (not `pid`), or a timeout. */
  const reconnected = (pid: number | undefined) => waitUntil(() => {
    const link = machines.local()
    return link?.state === 'connected' && link.hello && link.hello.machine.pid !== pid ? link.hello : undefined
  }, 30_000, 'The daemon did not come back. See daemon.log in the data dir.')

  /**
   * Whether this computer's daemon refused the link for speaking another protocol generation. The link gives up on it
   * for good, and it says nothing of itself (its build, its pid, whether agents are working), but it's restarted the
   * same as any daemon out of date.
   */
  const refused = () => machines.local()?.error?.kind === 'version_mismatch'
  /** The daemon's pid, as it names itself beside its data (and names its successor as it hands over). */
  function daemonPid() {
    try { return Number(readFileSync(pidPath(dataDir), 'utf8')) || undefined } catch { return undefined }
  }
  const exited = (pid: number) => waitUntil(() => {
    try { process.kill(pid, 0) } catch { return true }
    return undefined
  }, 10_000, 'The daemon did not stop. See daemon.log in the data dir.', 100)

  const restart = new ServiceRestart({
    async inspect() {
      const link = machines.local()
      const hello = link?.state === 'connected' ? link.hello : undefined
      if (!hello && !refused()) throw new Error('The daemon is not connected.')
      return {
        // The daemon the app would start now is the code next to it on disk.
        installedBuild: readBuild(import.meta.dirname),
        ...(hello ? { runningBuild: hello.machine.build } : {}),
        refused: !hello,
        // One that refused can't say whether agents are working: they're taken to be, so stopping it asks first.
        busy: !hello || machines.working('local').length > 0,
      }
    },
    async restart(snapshot, interrupt) {
      const local = machines.local()
      if (!snapshot.refused) {
        const pid = local?.hello?.machine.pid
        const result = await local!.call('daemon.restart', { build: snapshot.runningBuild, interrupt }) as { restarted: boolean }
        if (!result.restarted) return 'busy'
        return (await reconnected(pid)).machine.build
      }
      // One of another generation can't be asked to restart itself: stop it, consented to, and link again,
      // which starts the one installed here.
      const pid = daemonPid()
      if (!pid) throw new Error('Could not find the daemon. See daemon.pid in the data dir.')
      try { process.kill(pid, 'SIGTERM') } catch {}
      await exited(pid)
      machines.restartLocal()
      return (await reconnected(pid)).machine.build
    },
    async confirmInterruption(snapshot) {
      if (headless) return true
      return confirm({
        type: 'warning', buttons: ['Restart Now', 'Cancel'], defaultId: 1, cancelId: 1,
        message: snapshot.refused ? 'Restart the daemon?' : 'Interrupt working agents?',
        detail: 'Agents stop mid-turn and pick up again after the restart. Threads and their history are kept.',
      })
    },
    changed,
  })
  /** Whether the first look since the app started was had (see `restartsAfterUpdate`). */
  let looked = !restartsAfterUpdate
  const afterUpdate = () => {
    // Not before it was had: a poll while another runs looks at nothing.
    if (looked || restart.state.installedBuild === undefined || restart.state.phase === 'error') return
    looked = true
    // One of another generation is left to the notice: stopping it can't wait for its agents, and asks.
    if (restart.state.phase === 'required' && !restart.state.refused) void restart.act('restart')
  }
  /** Look again whether the daemon runs the code installed: every few seconds, and as the local link connects. */
  const poll = () => { if (machines.local()?.state === 'connected' || refused()) void restart.poll().then(afterUpdate) }
  setInterval(poll, 3000).unref()

  /** Quit, and stop this computer's daemon and its agents too, asking first while any are working. */
  async function quitAndStop() {
    const working = machines.working('local').length
    if (working && !headless && !await confirm({
      type: 'warning', buttons: ['Stop Agents and Quit', 'Cancel'], defaultId: 0, cancelId: 1,
      message: `${agentsAre(working)} still working`,
      detail: `Stopping the daemon ends their work. Quitting ${appConfig.name} alone leaves them running.`,
    })) return
    const pid = daemonPid()
    for (const link of machines.allLinks()) link.stop()
    if (pid) try { process.kill(pid, 'SIGTERM') } catch {}
    app.quit()
  }

  /**
   * Make way for an update of the app: stop this computer's daemon, which runs from inside it, asking first while
   * agents work (they resume after). False: the user said no. The new app starts it again.
   */
  async function stopForUpdate(): Promise<boolean> {
    const working = machines.working('local').length
    if (working && !headless && !await confirm({
      type: 'warning', buttons: ['Update and Restart', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `${agentsAre(working)} still working`,
      detail: `Updating restarts ${appConfig.name}: agents stop mid-turn and pick up again after. Threads and their history are kept.`,
    })) return false
    const pid = daemonPid()
    // Not linked, so nothing starts it again meanwhile.
    machines.local()?.stop()
    if (pid) {
      try { process.kill(pid, 'SIGTERM') } catch { /* gone already: nothing to stop */ }
      await exited(pid)
    }
    return true
  }

  return {
    get state() { return restart.state },
    stopForUpdate,
    /** Link to this computer's daemon again (starting it), after `stopForUpdate` when the update didn't go ahead. */
    relink: () => machines.restartLocal(),
    act: (action: Parameters<ServiceRestart['act']>[0]) => restart.act(action),
    poll,
    quitAndStop,
  }
}
