import { describe, expect, it, vi } from 'vitest'
import { Updates, type UpdaterIO } from '../src/main/updates.ts'
import { updateFeedJson } from '../src/package.ts'
import type { UpdateState } from '../src/shared/updates.ts'

function updater(overrides: Partial<UpdaterIO> = {}) {
  const changes: UpdateState[] = []
  const io: UpdaterIO = {
    check: vi.fn(), online: () => true, prepare: vi.fn(async () => true), install: vi.fn(), recover: vi.fn(),
    changed: (state) => changes.push(state), ...overrides,
  }
  return { updates: new Updates('0.1.8', io), io, changes }
}

describe('Updates', () => {
  it('is off without an updater, and checking does nothing', async () => {
    const updates = new Updates('0.0.0', undefined)
    expect(await updates.check(true)).toEqual({ phase: 'off', version: '0.0.0' })
  })

  it('is translocated, not checking, in a released app run from a temporary folder', async () => {
    const updates = new Updates('0.1.8', undefined, true)
    expect(await updates.check(true)).toEqual({ phase: 'translocated', version: '0.1.8' })
  })

  it('checks, finds nothing newer, and says when', async () => {
    const { updates, io } = updater()
    const done = updates.check()
    expect(updates.state.phase).toBe('checking')
    expect(io.check).toHaveBeenCalledOnce()
    updates.notAvailable()
    const state = await done
    expect(state.phase).toBe('idle')
    expect(state.checked).toBeTypeOf('number')
  })

  it('downloads what it finds, is ready with its version, and checks no more', async () => {
    const { updates, io } = updater()
    const done = updates.check(true)
    updates.checking()
    updates.available()
    expect((await done).phase).toBe('downloading')
    updates.downloaded('0.1.9')
    expect(updates.state).toMatchObject({ phase: 'ready', next: '0.1.9' })
    await updates.check()
    expect(io.check).toHaveBeenCalledOnce()
  })

  it('a second check while one runs joins it', async () => {
    const { updates, io } = updater()
    const first = updates.check()
    const second = updates.check(true)
    expect(updates.state.asked).toBe(true)
    updates.notAvailable()
    expect((await first).phase).toBe('idle')
    expect((await second).phase).toBe('idle')
    expect(io.check).toHaveBeenCalledOnce()
  })

  it('says nothing of a check of its own that failed offline', async () => {
    const { updates } = updater({ online: () => false })
    const done = updates.check()
    updates.failed(new Error('The Internet connection appears to be offline.'))
    expect(await done).toMatchObject({ phase: 'idle' })
    expect(updates.state.error).toBeUndefined()
  })

  it('tells of a check someone asked for that failed offline', async () => {
    const { updates } = updater({ online: () => false })
    const done = updates.check(true)
    updates.failed(new Error('The Internet connection appears to be offline.'))
    expect(await done).toMatchObject({ phase: 'error', failed: 'check', error: 'The Internet connection appears to be offline. (offline)' })
  })

  it('tells of a failed download, and which step it was', async () => {
    const { updates } = updater()
    void updates.check()
    updates.available()
    updates.failed(new Error('Code signature did not match'))
    expect(updates.state).toMatchObject({ phase: 'error', failed: 'download', error: 'Code signature did not match' })
  })

  it('restarts onto the update once the daemon is safe', async () => {
    const { updates, io } = updater()
    void updates.check()
    updates.downloaded('0.1.9')
    await updates.install()
    expect(io.prepare).toHaveBeenCalledOnce()
    expect(io.install).toHaveBeenCalledOnce()
    expect(updates.state.phase).toBe('installing')
  })

  it('stays ready when the user keeps the agents working', async () => {
    const { updates, io } = updater({ prepare: vi.fn(async () => false) })
    void updates.check()
    updates.downloaded('0.1.9')
    await updates.install()
    expect(io.install).not.toHaveBeenCalled()
    expect(updates.state.phase).toBe('ready')
  })

  it('links to the daemon again when the install fails, and can try again', async () => {
    const { updates, io } = updater({ install: vi.fn(() => { throw new Error('No update ready') }) })
    void updates.check()
    updates.downloaded('0.1.9')
    await updates.install()
    expect(io.recover).toHaveBeenCalledOnce()
    expect(updates.state).toMatchObject({ phase: 'ready', failed: 'install', error: 'No update ready' })
  })
})

describe('updateFeedJson', () => {
  it('names the release as current, with its zip', () => {
    const feed = JSON.parse(updateFeedJson({ version: '0.1.9', zipUrl: 'https://example.com/Superego-0.1.9-arm64.zip', notes: '- New', date: new Date(0) }))
    expect(feed).toEqual({
      currentRelease: '0.1.9',
      releases: [{ version: '0.1.9', updateTo: { version: '0.1.9', pub_date: '1970-01-01T00:00:00.000Z', notes: '- New', name: '0.1.9', url: 'https://example.com/Superego-0.1.9-arm64.zip' } }],
    })
  })
})
