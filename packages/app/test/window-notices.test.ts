// @vitest-environment happy-dom
// What extensions say in a thread and on its title bar, in the window drawn whole over a real daemon: a notice
// (`threads.notice`) as a card naming the extension, drawn by its entry component or as text, its buttons sending the
// agent a message or dispatching an action (one that fails says so on the card); a message an extension sent, named
// over it; and a header chip with a menu, a menu on the desktop and rows of the phone's sheet.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { obj, num, RpcError } from '@superego/protocol'
import { defineAction, defineDaemonExtension, type DaemonApi } from '@superego/daemon'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '../../sdk/src/testing.ts'
import { defineUiExtension, type EntryProps, type SlotProps } from '../src/renderer/extension-api.ts'
import { HeaderChip } from '../src/renderer/marks.tsx'
import { ThreadMenuItem } from '../src/renderer/thread-menu.tsx'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]

/** An extension of CI checks: it tells the thread when they fail, offers to rerun them, and shows them as a chip. */
const reruns: number[] = []
let api: DaemonApi
const checks = defineDaemonExtension({
  name: 'checks', title: 'Checks',
  setup(superego) {
    api = superego
    superego.action(defineAction({
      id: 'checks.rerun', title: 'Rerun checks', runs: 'machine', expose: ['ui'], params: obj({ pr: num() }),
      run({ pr }) {
        if (pr === 0) throw new RpcError('invalid', 'No such pull request')
        reruns.push(pr)
        return null
      },
    }))
  },
})
const Failed = ({ entry }: EntryProps) => createElement('div', { className: 'checks-failed' }, `PR #${(entry.data as { pr: number }).pr}: red (${entry.kind})`)
const Chip = ({ thread }: SlotProps['header.chips']) => createElement(HeaderChip, {
  title: 'Checks', children: '● 2 failing',
  menu: [
    createElement(ThreadMenuItem, { key: 'rerun', onClick: () => { void api.threads.notice(thread.id, { text: 'Rerun from the chip.' }) }, children: 'Rerun checks' }),
    createElement(ThreadMenuItem, { key: 'open', onClick: () => {}, children: 'Open on GitHub' }),
  ],
})
// No title of its own: the window has its daemon half's, from the machine.
const checksUi = defineUiExtension({
  name: 'checks',
  setup(superego) {
    superego.entry('checks.failed', Failed)
    superego.slot('header.chips', Chip)
  },
})

let daemon: TestDaemon
let ui: TestWindow | undefined
beforeEach(async () => { reruns.length = 0; daemon = await testDaemon({ model: 'echo', extensions: [checks] }) })
afterEach(async () => { await ui?.unmount(); ui = undefined; await daemon.close() })

const answers = () => $$('.msg__text').map((m) => m.textContent)

it('draws a notice as a card naming its extension, drawn by it or as text, and its buttons act', async () => {
  const thread = await daemon.thread('hello', { title: 'PR' })
  ui = await mountUi({ window: true, extensions: [checksUi], machines: [daemon], select: { thread: thread.id } })
  await ui.until(() => answers().some((a) => a?.includes('echo: hello')), 'the first answer')

  await api.threads.notice(thread.id, {
    text: 'Checks failed on #12.', kind: 'checks.failed', data: { pr: 12 },
    actions: [{ label: 'Fix it', send: 'Fix the failing checks.', style: 'primary' }, { label: 'Rerun', action: 'checks.rerun', params: { pr: 12 } }, { label: 'Broken', action: 'checks.rerun', params: { pr: 0 } }],
  })
  await ui.until(() => Boolean($('.notice .checks-failed')), 'the notice, drawn by the extension')
  const card = $('.notice')!
  expect(card.querySelector('.msg__by')!.textContent).toBe('Checks')
  expect(card.querySelector('.checks-failed')!.textContent).toBe('PR #12: red (checks.failed)')
  expect([...card.querySelectorAll('.notice__actions button')].map((b) => b.textContent)).toEqual(['Fix it', 'Rerun', 'Broken'])
  expect(card.querySelector('.notice__actions button')!.className).toContain('superego-button--primary')

  // An action: dispatched on the thread's machine.
  await ui.window!.click('Rerun')
  await ui.until(() => reruns.join() === '12', 'the checks rerun')
  // One that fails says why, on the card.
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  await ui.window!.click('Broken')
  await ui.until(() => $('.notice__problem')?.textContent === 'Broken failed: No such pull request', 'the failure said')
  expect(logged.mock.calls.some(([said]) => String(said).startsWith('Notice from checks: Broken failed'))).toBe(true)
  logged.mockRestore()
  // A message: sent as the user's, and answered.
  await ui.window!.click('Fix it')
  await ui.until(() => answers().some((a) => a?.includes('echo: Fix the failing checks.')), 'the agent asked')
  const sent = $$('.msg--user').at(-1)!
  expect(sent.querySelector('.msg__by')).toBeNull()

  // Without a component of its own for it: its text, as Markdown.
  await api.threads.notice(thread.id, { text: 'Deploy **done**.' })
  await ui.until(() => $$('.notice').length === 2, 'the second notice')
  expect($$('.notice')[1]!.querySelector('strong')!.textContent).toBe('done')
})

it("draws a message an extension sent as an outlined bubble, its name over it, so it doesn't read as the user's", async () => {
  const thread = await daemon.thread('hello', { title: 'PR' })
  ui = await mountUi({ window: true, extensions: [checksUi], machines: [daemon], select: { thread: thread.id } })
  await ui.until(() => answers().some((a) => a?.includes('echo: hello')), 'the first answer')
  await api.threads.send(thread.id, 'Checks finished: 2 failing.')
  await ui.until(() => answers().some((a) => a?.includes('echo: Checks finished')), 'the agent woken')
  const [mine, its] = $$('.msg--user')
  expect(mine!.querySelector('.msg__by')).toBeNull()
  expect(its!.querySelector('.msg__by')!.textContent).toBe('Checks')
  // Outlined, not filled: yours, but not typed by you.
  expect(mine!.classList.contains('msg--by')).toBe(false)
  expect(its!.classList.contains('msg--by')).toBe(true)
  expect(its!.querySelector('.msg__bubble')!.textContent).toBe('Checks finished: 2 failing.')
})

it('opens a header chip with a menu as a menu', async () => {
  const thread = await daemon.thread('hello', { title: 'PR' })
  ui = await mountUi({ window: true, extensions: [checksUi], machines: [daemon], select: { thread: thread.id } })
  await ui.until(() => Boolean($('.header__chip--menu')), 'the chip')
  expect($('.header__chip--menu')!.textContent).toBe('● 2 failing')
  await ui.window!.click('.header__chip--menu')
  await ui.until(() => $$('.superego-menu__item').some((i) => i.textContent === 'Rerun checks'), 'its menu')
  expect($$('.superego-menu .superego-menu__item').map((i) => i.textContent)).toEqual(['Rerun checks', 'Open on GitHub'])
  await ui.window!.click('Rerun checks')
  await ui.until(() => $$('.notice').some((n) => n.textContent?.includes('Rerun from the chip.')), 'the item chosen')
})

it("puts a header chip's menu in the phone's sheet: its rows after the chip's", async () => {
  const thread = await daemon.thread('hello', { title: 'PR' })
  ui = await mountUi({ window: true, extensions: [checksUi], machines: [daemon], select: { thread: thread.id }, narrow: true })
  await ui.until(() => $('.app.is-narrow .app__mobiletitle-text')?.textContent === 'PR', 'the narrow layout')
  $('.app__mobiletitle')!.click()
  const sheet = () => $('.app__sheet .thread-sheet')
  await ui.until(() => Boolean(sheet()?.querySelector('[data-item="Rerun checks"]')), "the chip's items in the sheet")
  const rows = [...sheet()!.querySelectorAll<HTMLElement>('[role="group"][aria-label="Thread"] .thread-sheet__item')].map((r) => r.textContent)
  const at = rows.indexOf('● 2 failing')
  expect(at).toBeGreaterThanOrEqual(0)
  expect(rows.slice(at, at + 3)).toEqual(['● 2 failing', 'Rerun checks', 'Open on GitHub'])
  sheet()!.querySelector<HTMLElement>('[data-item="Rerun checks"]')!.click()
  await ui.until(() => !sheet(), 'the sheet closed')
  await ui.until(() => $$('.notice').some((n) => n.textContent?.includes('Rerun from the chip.')), 'the item chosen')
})
