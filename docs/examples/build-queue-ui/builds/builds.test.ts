// The build queue with its own UI: the agent queues two builds, the window draws this thread's queue beside it (and
// no other's), Cancel stops the running one so the next runs, and ⌘⇧B takes it out of the aside and puts it back.
import { afterEach, expect, it } from 'vitest'
import { callTools, daemonMachine, mountUi, say, testDaemon, type TestDaemon } from 'superego/testing'
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
    const aside = await window.render({ place: 'aside', thread: thread.id })
    await window.until(() => aside.text().includes('sleep 30'))
    expect(aside.text()).toContain('running')
    const empty = await window.render({ place: 'aside', thread: other.id })
    await window.until(() => empty.text().includes('No builds queued.'))
    await aside.click('Cancel')
    await queue.until((builds) => builds.map((b) => b.state).join() === 'cancelled,done')
    await window.until(() => aside.text().includes('cancelled') && aside.text().includes('done'))
    // ⌘⇧B, in this profile's thread: out of the aside, and back.
    expect(window.placed('aside', { thread: thread.id })).toContain(VIEW)
    expect(await window.press('mod+shift+b')).toBe('builds.toggle')
    expect(window.placed('aside', { thread: thread.id })).not.toContain(VIEW)
    await window.press('mod+shift+b')
    expect(window.placed('aside', { thread: thread.id })).toContain(VIEW)
  } finally {
    await window.unmount()
  }
})
