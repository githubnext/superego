// The build queue with its own UI: the agent queues two builds, the window draws this thread's queue beside it (and
// no other's), Cancel stops the running one so the next runs, and ⌘⇧B takes it out from beside the thread and puts it back. A
// cancelled build stops with everything its command started.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { callTools, daemonMachine, isRunning, mountUi, say, testDaemon, type TestDaemon } from 'superego/testing'
import ui from './ui.tsx'
import { QUEUE, VIEW, type Build } from './shared.ts'

const profile = new URL('..', import.meta.url).pathname
let daemon: TestDaemon | undefined
afterEach(async () => { await daemon?.close() })

it("draws this thread's queue beside it, cancels from it, and ⌘⇧B shows or hides it", async () => {
  daemon = await testDaemon({
    profile,
    model: [callTools({ name: 'enqueue_build', args: { command: 'sleep 30' } }, { name: 'enqueue_build', args: { command: 'true' } }), say('Queued both.')],
  })
  const thread = await daemon.thread('Build it')
  const other = await daemon.thread()
  const queue = await daemon.watch<Build[]>(QUEUE, { scope: thread.id })
  await queue.until((builds) => builds.map((b) => b.state).join() === 'running,queued')
  const window = await mountUi({ machines: [daemonMachine(daemon)], profile: { ref: thread.profile!, extensions: [ui] }, select: { thread: thread.id } })
  try {
    const beside = await window.render({ place: 'beside', thread: thread.id })
    await window.until(() => beside.text().includes('sleep 30'))
    expect(beside.text()).toContain('running')
    const empty = await window.render({ place: 'beside', thread: other.id })
    await window.until(() => empty.text().includes('No builds queued.'))
    await beside.click('Cancel')
    await queue.until((builds) => builds.map((b) => b.state).join() === 'cancelled,done')
    await window.until(() => beside.text().includes('cancelled') && beside.text().includes('done'))
    // ⌘⇧B, in this profile's thread: out from beside the thread, and back.
    expect(window.placed('beside', { thread: thread.id })).toContain(VIEW)
    expect(await window.press('mod+shift+b')).toBe('builds.toggle')
    expect(window.placed('beside', { thread: thread.id })).not.toContain(VIEW)
    await window.press('mod+shift+b')
    expect(window.placed('beside', { thread: thread.id })).toContain(VIEW)
  } finally {
    await window.unmount()
  }
})

it('cancels all of a build from its button: nothing its command started outlives it', async () => {
  // The command starts a process of its own (a `sleep`, as a compiler starts workers), and says its id.
  const command = "sh -c 'sleep 30 & echo $! > sleeper.pid; wait'"
  daemon = await testDaemon({ profile, model: [callTools({ name: 'enqueue_build', args: { command } }), say('Queued.')] })
  const thread = await daemon.thread('Build it')
  const queue = await daemon.watch<Build[]>(QUEUE, { scope: thread.id })
  const file = join(thread.cwd, 'sleeper.pid')
  await daemon.until(async () => (await readFile(file, 'utf8').catch(() => '')).endsWith('\n'), 'the build to start its sleep')
  const sleeper = Number(await readFile(file, 'utf8'))
  const window = await mountUi({ machines: [daemonMachine(daemon)], profile: { ref: thread.profile!, extensions: [ui] }, select: { thread: thread.id } })
  try {
    const beside = await window.render({ place: 'beside', thread: thread.id })
    await window.until(() => beside.text().includes('running'))
    await beside.click('Cancel')
    await queue.until((builds) => builds[0]?.state === 'cancelled')
    expect(isRunning(sleeper)).toBe(false)
  } finally {
    await window.unmount()
  }
})
