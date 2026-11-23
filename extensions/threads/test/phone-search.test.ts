// @vitest-environment happy-dom
// The phone's drawer has a search field under its title (the wide sidebar doesn't): typed in, the list is the threads
// that match, archived ones after the rest; × empties it, Cancel puts it away, and nothing found says so. A match picked
// shows its thread and closes the drawer.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '@superego/sdk/testing'
import threads from '../src/ui.tsx'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const drawer = () => $('.app__drawer .app__sidebar')
const field = () => $('.app__drawer .threads-search__input') as HTMLInputElement | null
const titles = () => $$('.app__drawer .superego-list-item').map((li) => li.querySelector('.threads__title, .threads-archived__title')?.textContent)
const type = (text: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), text)
  field()!.dispatchEvent(new Event('input', { bubbles: true }))
}

let daemon: TestDaemon
let ui: TestWindow
beforeEach(async () => { daemon = await testDaemon({ model: 'echo' }) })
afterEach(async () => { await ui?.unmount(); await daemon.close() })

it('narrows the drawer to the threads that match, the archived after, and opens the one picked', async () => {
  const first = await daemon.thread(undefined, { title: 'Fix the login form' })
  await daemon.thread(undefined, { title: 'Bank sync retries' })
  const old = await daemon.thread(undefined, { title: 'Login with passkeys' })
  await daemon.call('thread.archive', { thread: old.id })
  ui = await mountUi({ window: true, extensions: [threads], machines: [daemon], select: { thread: first.id }, narrow: true })
  await ui.until(() => Boolean($('.app.is-narrow .app__mobilebar')), 'the narrow layout')
  $('.app__mobilebar button')!.click()
  await ui.until(() => Boolean(field()) && titles().includes('Bank sync retries'), 'the drawer, its search field')
  expect(field()!.placeholder).toBe('Search')
  expect($('.threads-search__cancel')).toBeNull()

  field()!.focus()
  await ui.until(() => Boolean($('.threads-search__cancel')), 'Cancel while it’s in use')
  type('login')
  await ui.until(() => titles().join('|') === 'Fix the login form|Login with passkeys', 'the matches, the archived after')
  expect($('.threads-found .threads-found__head')?.textContent).toBe('Archived')
  expect($('.threads-search__clear')).not.toBeNull()

  $('.threads-search__clear')!.click()
  await ui.until(() => field()!.value === '' && titles().includes('Bank sync retries'), 'emptied: the whole list again')
  type('zebra')
  await ui.until(() => $('.threads-found__none')?.textContent?.includes('No Results for “zebra”') === true, 'nothing found, said')

  $('.threads-search__cancel')!.click()
  await ui.until(() => field()!.value === '' && !$('.threads-search__cancel') && titles().includes('Bank sync retries'), 'Cancel: put away')

  type('bank')
  await ui.until(() => titles().join('|') === 'Bank sync retries', 'one match')
  $$('.app__drawer .superego-list-item')[0]!.click()
  await ui.until(() => !drawer() && $('.app__mobiletitle-text')?.textContent === 'Bank sync retries', 'its thread shown, the drawer shut')
})

it('isn’t in the wide sidebar', async () => {
  await daemon.thread(undefined, { title: 'Fix the login form' })
  ui = await mountUi({ window: true, extensions: [threads], machines: [daemon] })
  await ui.until(() => $$('.app__sidebar .superego-list-item').length > 0, 'the sidebar')
  expect($('.threads-search')).toBeNull()
})
