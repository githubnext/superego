// @vitest-environment happy-dom
// Machines named in the sidebar in their colours, on a project's heading and a pinned thread's row; this computer too,
// where there are several to tell apart.
import { afterEach, expect, it } from 'vitest'
import { fakeMachine, mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import threads from '../src/ui.tsx'

const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const named = (within: string) => $$(`${within} .superego-machine`).map((el) => [el.textContent, el.style.color])
const rowOf = (title: string) => $$('.superego-list-item').find((li) => li.querySelector('.threads__title')?.textContent === title)

let ui: TestWindow
afterEach(async () => { await ui?.unmount() })

it('draws each machine’s name in its colour, wherever the sidebar names it', async () => {
  const here = testThread({ id: 'here', title: 'Here', project: { root: '/me/ledger', name: 'ledger' }, cwd: '/me/ledger' })
  const far = testThread({ id: 'far', title: 'Far', project: { root: '/srv/app', name: 'app' }, cwd: '/srv/app' })
  const gone = testThread({ id: 'gone', title: 'Gone', project: { root: '/srv/site', name: 'site' }, cwd: '/srv/site' })
  ui = await mountUi({
    window: true, extensions: [threads],
    machines: [
      fakeMachine({ threads: [here], colour: 1, label: 'This computer' }),
      fakeMachine({ id: 'workbox', label: 'workbox', threads: [far], colour: 4 }),
      // One from an older Superego's list says no colour: its name as any other words there.
      fakeMachine({ id: 'old', label: 'old box', threads: [gone] }),
    ],
  })
  await ui.until(() => Boolean(rowOf('Here') && rowOf('Far') && rowOf('Gone')), 'the threads listed')
  expect(named('.threads-project__head').sort()).toEqual([
    ['This computer', 'var(--superego-machine-1)'], ['old box', ''], ['workbox', 'var(--superego-machine-4)'],
  ])
  await ui.dispatch('thread.pin', { machine: 'workbox', thread: 'far' })
  await ui.until(() => named('.threads-pinned .superego-list-item').length === 1, 'pinned')
  expect(named('.threads-pinned .superego-list-item')).toEqual([['workbox', 'var(--superego-machine-4)']])
  expect($$('.threads-pinned .threads-pinned__where').map((el) => el.textContent)).toEqual(['app · workbox'])
})
