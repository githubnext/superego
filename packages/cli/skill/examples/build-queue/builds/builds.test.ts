// The build queue, as it runs: the agent queues two builds, the first runs while the second waits, the thread's view
// shows only its own queue, Cancel stops the running one and the next runs, and ⌘⇧B opens the queue as a pane. A
// cancelled build, or one running at teardown, stops with everything its command started.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { callTools, daemonMachine, isRunning, mountUi, say, testDaemon, type TestDaemon } from 'superego/testing'
import type { Block } from 'superego'
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
  const view = await daemon.watch<Block[]>(VIEW, { scope: thread.id })
  const list = () => view.value.find((b) => b.type === 'list')!
  expect(list().items.map((i) => [i.title, i.subtitle])).toEqual([['sleep 30', 'running'], ['echo ok > built.txt', 'queued']])
  expect((await daemon.watch<Build[]>(QUEUE, { scope: other.id })).value).toEqual([])
  // Its Cancel button runs builds.cancel: the running one stops, and the next runs, and is done.
  const cancel = list().items[0]!.buttons![0]!
  await daemon.dispatch(cancel.action!, cancel.params!)
  await queue.until((builds) => builds.map((b) => b.state).join() === 'cancelled,done')
})

it('draws the queue beside the thread, cancels from its button, and opens it as a pane with ⌘⇧B', async () => {
  daemon = await testDaemon({ profile, model: queueTwo() })
  const thread = await daemon.thread('Build it')
  const window = await mountUi({ machines: [daemonMachine(daemon)], select: { thread: thread.id } })
  try {
    expect(window.placed('beside', { thread: thread.id })).toContain(VIEW)
    const beside = await window.render({ place: 'beside', thread: thread.id })
    await window.until(() => beside.text().includes('sleep 30') && beside.text().includes('running'))
    await beside.click('Cancel')
    await window.until(() => beside.text().includes('cancelled'))
    expect(await window.press('mod+shift+b')).toBe('builds.open')
    await daemon.until(async () => (await daemon!.call<{ id: string; panes?: { kind: string }[] }[]>('thread.list')).find((t) => t.id === thread.id)?.panes?.some((p) => p.kind === VIEW) ?? false, 'the queue to open as a pane')
  } finally {
    await window.unmount()
  }
})

/** A build whose command starts a process of its own (a `sleep`, as a compiler starts workers), and that process's id. */
const SLEEPER = "sh -c 'sleep 30 & echo $! > sleeper.pid; wait'"
async function sleeper(cwd: string) {
  const file = join(cwd, 'sleeper.pid')
  await daemon!.until(async () => (await readFile(file, 'utf8').catch(() => '')).endsWith('\n'), 'the build to start its sleep')
  return Number(await readFile(file, 'utf8'))
}

it("cancels all of a build: once it says cancelled, nothing its command started is running", async () => {
  daemon = await testDaemon({ profile, model: [callTools({ name: 'enqueue_build', args: { command: SLEEPER } }), say('Queued.')] })
  const thread = await daemon.thread('Build it')
  const queue = await daemon.watch<Build[]>(QUEUE, { scope: thread.id })
  const pid = await sleeper(thread.cwd)
  await daemon.dispatch('builds.cancel', { thread: thread.id, id: queue.value[0]!.id })
  await queue.until((builds) => builds[0]?.state === 'cancelled')
  expect(isRunning(pid)).toBe(false)
})

it('stops a running build, all of it, when the extension is torn down', async () => {
  daemon = await testDaemon({ profile, model: [callTools({ name: 'enqueue_build', args: { command: SLEEPER } }), say('Queued.')] })
  const thread = await daemon.thread('Build it')
  const pid = await sleeper(thread.cwd)
  await daemon.close()
  daemon = undefined
  // Teardown sends the group SIGTERM; the sleep goes at once.
  const end = Date.now() + 5000
  while (isRunning(pid) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25))
  expect(isRunning(pid)).toBe(false)
})
