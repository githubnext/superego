// @vitest-environment happy-dom
// `/compact` in a thread's composer, in the window drawn whole over a real daemon: what came before the newest stretch
// summarized (a "Compacted conversation" row), what follows the command saying what to keep; refused, and said so,
// while there's nothing old enough to compact. And both commands in ⌘K, under This thread.
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ThreadInfo } from '@superego/protocol'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '../../sdk/src/testing.ts'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const box = () => $('.composer textarea') as HTMLTextAreaElement
const offered = () => $$('.completions__item .completions__label').map((item) => item.textContent)

let daemon: TestDaemon
let ui: TestWindow | undefined
beforeEach(async () => { daemon = await testDaemon({ model: 'echo' }) })
afterEach(async () => { await ui?.unmount(); ui = undefined; await daemon.close() })

const shown = async (thread: ThreadInfo) => {
  ui = await mountUi({ window: true, machines: [daemon], select: { thread: thread.id } })
  await ui.until(() => $('.thread__title')?.textContent === thread.title, 'the thread shown')
}

// First: a window keeps what it watched of a thread by its id, which the next test's daemon gives another thread.
it('says there is nothing to compact yet in a short conversation, the command back in the box', async () => {
  const thread = await daemon.thread('hello', { title: 'Short' })
  await shown(thread)
  await ui!.type('.composer textarea', '/compact')
  await ui!.key('enter')
  await ui!.until(() => Boolean($('.composer__error')?.textContent?.includes('Nothing to compact yet')), 'said')
  expect(box().value).toBe('/compact')
  expect($$('.row__label').some((label) => label.textContent === 'Compacted conversation')).toBe(false)
})

it('summarizes what came before, keeping what it says to, with one ⏎', async () => {
  // Its echo alone more than the newest stretch compacting keeps whole (20k tokens), short of compacting by itself:
  // the first message goes into the summary.
  const thread = await daemon.thread(`Remember the ledger: ${'entry '.repeat(15_000)}`, { title: 'Long' })
  await daemon.call('thread.send', { thread: thread.id, text: 'And now?' })
  await daemon.idle(thread.id)
  await shown(thread)

  await ui!.type('.composer textarea', '/comp')
  await ui!.until(() => offered().join() === '/compact', '/compact offered')
  await ui!.type('.composer textarea', '/compact keep the ledger')
  await ui!.key('enter')
  await ui!.until(() => $$('.row__label').some((label) => label.textContent === 'Compacted conversation'), 'the summary in the transcript')
  expect(box().value).toBe('')
  expect($('.composer__error')).toBeNull()
  const compacting = ui!.calls.find((c) => c.method === 'action.run' && c.params.id === 'thread.compact')
  expect(compacting?.params.params).toEqual({ thread: thread.id, instructions: 'keep the ledger' })
  // The summary was asked to keep it.
  expect(await daemon.transcript(thread.id)).toContain('keep the ledger')
})

it('offers Clear thread and Compact conversation in ⌘K, under This thread', async () => {
  const thread = await daemon.thread(undefined, { title: 'Here' })
  await shown(thread)
  await ui!.key('mod+k')
  await ui!.until(() => $$('.palette__title').some((t) => t.textContent === 'Compact conversation'), 'the palette, with Compact conversation')
  const titles = $$('.palette__list li').map((li) => li.classList.contains('palette__group') ? `# ${li.textContent}` : li.querySelector('.palette__title')?.textContent)
  const group = titles.indexOf('# This thread')
  expect(group).toBeGreaterThanOrEqual(0)
  expect(titles.indexOf('Clear thread')).toBeGreaterThan(group)
  expect(titles.indexOf('Compact conversation')).toBeGreaterThan(group)
})
