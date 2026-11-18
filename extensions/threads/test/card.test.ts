// @vitest-environment happy-dom
// A thread's card in the sidebar: what it says of threads of a few shapes (one in a worktree under another, a quiet one,
// one on another machine, one waiting on you, a folded parent), shown on the keyboard's focus as on the pointer's rest,
// and never in the way of a click or a right-click.
import { afterEach, expect, it } from 'vitest'
import { defineUiExtension, h, ThreadBadge } from '@superego/app/ui'
import { GitBranchIcon } from '@superego/ui'
import { fakeMachine, mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import threads from '../src/ui.tsx'
import { when } from '../src/card.tsx'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const rowOf = (title: string) => $$('.threads-project .superego-list-item').find((li) => li.querySelector('.threads__title')?.textContent === title)
const card = () => $('.superego-hover-card .thread-card')
const lines = () => [...card()?.children ?? []].map((line) => (line as HTMLElement).textContent)
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A mark on a thread's row, as worktrees draws its branch. */
const marks = defineUiExtension({
  name: 'marks', version: '1.0.0', api: '^4', title: 'Marks', description: 'A branch mark.', required: true,
  setup(superego) {
    superego.slot('thread.badge', ({ thread }) => {
      const branch = (thread.facts?.marks as { branch?: string } | undefined)?.branch
      return branch ? h(ThreadBadge, { label: `on branch ${branch}`, title: branch, children: h(GitBranchIcon, { size: 12 }) }) : null
    })
  },
})

const now = Date.now()
const plan = testThread({ id: 'plan', title: 'Plan the release', activeAt: now - 4 * 60_000, cost: 1.234, model: 'claude-opus-4-5', provider: 'anthropic', profile: { scope: 'user', name: 'reviewer', dir: '/profiles/reviewer' } })
const fix = testThread({ id: 'fix', title: 'Fix the flaky smoke test', parent: 'plan', activeAt: now - 2 * 60_000, status: { state: 'working' }, facts: { marks: { branch: 'agent/fix-smoke' } }, profile: null })
const quiet = testThread({ id: 'quiet', title: 'Quiet helper', parent: 'plan', quiet: true, activeAt: now - 60_000, status: { state: 'done', msg: 'Merged it' }, profile: null })
const asks = testThread({ id: 'asks', title: 'Needs you', activeAt: now, status: { state: 'blocked', kind: 'question', msg: 'Push to origin?' }, model: 'gpt-5', provider: 'openai-codex', profile: null })
const remote = testThread({ id: 'far', title: 'Remote build', project: { root: '/srv/app', name: 'app' }, cwd: '/srv/app', activeAt: now - 3 * 3_600_000, profile: null })

let ui: TestWindow
afterEach(async () => { await ui?.unmount() })

async function mount() {
  ui = await mountUi({
    window: true, extensions: [threads, marks],
    machines: [fakeMachine({ threads: [plan, fix, quiet, asks] }), fakeMachine({ id: 'workbox', label: 'workbox', threads: [remote] })],
  })
  await ui.until(() => Boolean(rowOf('Remote build')) && Boolean(rowOf('Quiet helper')), 'the threads listed')
}

/** Focus a row from the keyboard, and wait out the card's delay. */
async function focus(title: string) {
  rowOf(title)!.focus()
  await ui.until(() => card()?.querySelector('.thread-card__title')?.textContent === title, `${title}'s card`)
}

it('says what a thread is, each line only when it has something to say', async () => {
  await mount()
  await focus('Fix the flaky smoke test')
  expect(lines()).toEqual(['Fix the flaky smoke test', 'Working', 'work · localagent/fix-smoke', 'Started by Plan the release', '2m ago'])
  expect(card()!.querySelector('.thread-badge.is-spelled')?.textContent).toBe('agent/fix-smoke')

  await focus('Quiet helper')
  // Quiet and finished: nothing to say of its state, as its row says nothing.
  expect(lines()).toEqual(['Quiet helper', 'work · local', 'Started by Plan the release', '1m ago'])

  await focus('Needs you')
  expect(lines()).toEqual(['Needs you', 'Question: Push to origin?', 'work · local', 'gpt-5', 'just now'])
  expect(card()!.querySelector('.superego-provider')?.getAttribute('aria-label')).toBe('OpenAI')

  await focus('Plan the release')
  expect(lines()).toEqual(['Plan the release', 'work · local', 'claude-opus-4-5reviewer', '2 sub-threads', '$1.23 · 4m ago'])
  expect(card()!.querySelector('.superego-provider')?.getAttribute('aria-label')).toBe('Anthropic')

  await focus('Remote build')
  expect(lines()).toEqual(['Remote build', 'app · workbox', '3h ago'])
})

it('sums up the threads a folded row hides', async () => {
  await mount()
  rowOf('Plan the release')!.querySelector<HTMLElement>('.threads-caret')!.click()
  await ui.until(() => !rowOf('Quiet helper'), 'folded')
  await focus('Plan the release')
  // The quiet one's finish counts for nothing; the one working does.
  expect(lines()).toContain('2 sub-threadsWorking')
})

it('shows on focus only after a moment, goes on a drag or a scroll, and never takes a click or a right-click from the row', async () => {
  await mount()
  rowOf('Needs you')!.focus()
  await wait(100)
  expect(card()).toBeNull()
  await ui.until(() => Boolean(card()), 'the card, a moment later')
  rowOf('Needs you')!.click()
  await ui.until(() => $('.thread__title')?.textContent === 'Needs you', 'the click still selects')
  await ui.until(() => !card(), 'and puts the card away')

  await focus('Plan the release')
  rowOf('Plan the release')!.dispatchEvent(Object.assign(new Event('dragstart', { bubbles: true }), { dataTransfer: { setData() {}, effectAllowed: '' } }))
  await ui.until(() => !card(), 'a drag puts it away')
  rowOf('Plan the release')!.dispatchEvent(new Event('dragend', { bubbles: true }))
  await focus('Needs you')
  $('.threads')!.dispatchEvent(new Event('scroll'))
  await ui.until(() => !card(), 'so does a scroll')

  rowOf('Plan the release')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 }))
  await ui.until(() => $$('.superego-menu .superego-menu__item').some((i) => i.textContent?.includes('Archive')), 'the right-click still opens its menu')
})

it('says when, briefly', () => {
  const at = Date.UTC(2026, 0, 10, 12)
  expect(when(at, at + 20_000)).toBe('just now')
  expect(when(at, at + 4 * 60_000)).toBe('4m ago')
  expect(when(at, at + 2 * 3_600_000)).toBe('2h ago')
  expect(when(at, at + 30 * 24 * 3_600_000)).not.toMatch(/ago/)
})
