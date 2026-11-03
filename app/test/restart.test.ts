import { describe, expect, it } from 'vitest'
import { ServiceRestart, type ServiceSnapshot, type ServiceState } from '../src/main/restart.ts'

function service(snapshot: ServiceSnapshot) {
  const changes: ServiceState[] = []
  const restarts: boolean[] = []
  const restart = new ServiceRestart({
    inspect: async () => ({ ...snapshot }),
    restart: async (_snapshot, interrupt) => {
      restarts.push(interrupt)
      if (snapshot.busy && !interrupt) return 'busy'
      snapshot.runningBuild = snapshot.installedBuild
      return snapshot.runningBuild
    },
    confirmInterruption: async () => true,
    changed: (state) => changes.push(state),
  })
  return { restart, changes, restarts, snapshot }
}

describe('ServiceRestart', () => {
  it('tells watchers only when something changed, however often it polls', async () => {
    const { restart, changes } = service({ installedBuild: 'a', runningBuild: 'a', busy: false, canRestartWhenIdle: true })
    for (let i = 0; i < 5; i++) await restart.poll()
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ phase: 'current' })
  })

  it('restarts now when idle', async () => {
    const { restart, restarts } = service({ installedBuild: 'b', runningBuild: 'a', busy: false, canRestartWhenIdle: true })
    await restart.poll()
    expect(restart.state.phase).toBe('required')
    await restart.act('restart')
    expect(restarts).toEqual([false])
    expect(restart.state.phase).toBe('current')
  })

  it('waits for idle while busy, then restarts on a later poll', async () => {
    const { restart, restarts, snapshot } = service({ installedBuild: 'b', runningBuild: 'a', busy: true, canRestartWhenIdle: true })
    await restart.act('restart')
    expect(restart.state.phase).toBe('waiting')
    expect(restarts).toEqual([])
    snapshot.busy = false
    await restart.poll()
    expect(restarts).toEqual([false])
    expect(restart.state.phase).toBe('current')
  })

  it('later defers, and review brings the notice back', async () => {
    const { restart } = service({ installedBuild: 'b', runningBuild: 'a', busy: false, canRestartWhenIdle: true })
    await restart.poll()
    await restart.act('later')
    expect(restart.state).toMatchObject({ phase: 'required', deferred: true })
    await restart.act('review')
    expect(restart.state.deferred).toBe(false)
  })
})
