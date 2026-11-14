// The build queue, as it runs: the agent queues two builds, the first runs while the second waits, the thread's view
// shows only its own queue, Cancel stops the running one and the next runs, and ⌘⇧B opens the queue as a pane.
import { afterEach, expect, it } from 'vitest'
import { callTools, daemonMachine, mountUi, say, testDaemon, type TestDaemon } from 'superego/testing'
import type { ViewContent } from 'superego'
import { QUEUE, VIEW, type Build } from './shared.ts'

const profile = new URL('..', import.meta.url).pathname
let daemon: TestDaemon | undefined
afterEach(async () => { await daemon?.close() })

const queueTwo = () => [
  callTools({ name: 'enqueue_build', args: { command: 'sleep 30' } }, { name: 'enqueue_build', args: { command: 'echo ok > built.txt' } }),
  say('Queued both.'),
]

it("queues builds, runs them one at a time, and shows each thread only its own queue", async () => {
  daemon = await testDaemon({ profile, model: queueTwo() })
  const thread = await daemon.thread('Build it')
  const other = await daemon.thread()
  const queue = await daemon.watch<Build[]>(QUEUE, { scope: thread.id })
  await queue.until((builds) => builds.map((b) => b.state).join() === 'running,queued')
  const view = await daemon.watch<ViewContent>(VIEW, { scope: thread.id })
  expect(view.value.items?.map((i) => [i.title, i.subtitle])).toEqual([['sleep 30', 'running'], ['echo ok > built.txt', 'queued']])
  expect((await daemon.watch<Build[]>(QUEUE, { scope: other.id })).value).toEqual([])
  // Its Cancel button runs builds.cancel: the running one stops, and the next runs, and is done.
  const cancel = view.value.items![0]!.actions![0]!
  await daemon.dispatch(cancel.action, cancel.params as Record<string, unknown>)
  await queue.until((builds) => builds.map((b) => b.state).join() === 'cancelled,done')
})

it('draws the queue beside the thread, cancels from its button, and opens it as a pane with ⌘⇧B', async () => {
  daemon = await testDaemon({ profile, model: queueTwo() })
  const thread = await daemon.thread('Build it')
  const window = await mountUi({ machines: [daemonMachine(daemon)], select: { thread: thread.id } })
  try {
    expect(window.placed('aside', { thread: thread.id })).toContain(VIEW)
    const aside = await window.render({ place: 'aside', thread: thread.id })
    await window.until(() => aside.text().includes('sleep 30') && aside.text().includes('running'))
    await aside.click('Cancel')
    await window.until(() => aside.text().includes('cancelled'))
    expect(await window.press('mod+shift+b')).toBe('builds.open')
    await daemon.until(async () => (await daemon!.call<{ id: string; panes?: { kind: string }[] }[]>('thread.list')).find((t) => t.id === thread.id)?.panes?.some((p) => p.kind === VIEW) ?? false, 'the queue to open as a pane')
  } finally {
    await window.unmount()
  }
})
