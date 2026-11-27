// github, UI half, in a window: the row's mark (none for a closed pull request), the title bar's chip with its road and
// menu, thread details, and the pull request's pane leading with what to fix, from a machine's answer.
// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { fakeMachine, mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import github from '../src/ui.tsx'
import { PANE, PR, type PrDetail, type PrFact, type PrView } from '../src/shared.ts'

let ui: TestWindow | undefined
afterEach(async () => { await ui?.unmount(); ui = undefined })

const URL = 'https://github.com/acme/app/pull/7'
const pr = (more: Partial<PrFact> = {}): PrFact => ({
  key: 'github.com/acme/app#7', url: URL, number: 7, repo: 'acme/app', title: 'Mentions', state: 'open', checks: 'failing', failing: 2,
  review: 'changes', unresolved: 1, mergeable: 'mergeable', how: 'created', at: 1, ...more,
})
const thread = (...prs: PrFact[]) => testThread({ id: 't1', title: 'Mentions from extensions', facts: prs.length ? { github: { prs } } : {} })
const drawn = async (slot: 'thread.badge' | 'header.chips' | 'details.section', ...prs: PrFact[]) => {
  ui ??= await mountUi({ extensions: [github] })
  const got = await ui.render({ slot, thread: thread(...prs) })
  const html = got.container.innerHTML
  const text = got.text()
  await got.unmount()
  return { html, text }
}

it("marks a thread's row with its pull request's state and checks, spelled out in words; nothing once it's closed", async () => {
  const marked = await drawn('thread.badge', pr())
  expect(marked.html).toContain('github-glyph is-open')
  expect(marked.html).toContain('github-mark__dot is-failing')
  expect(marked.html).toContain('aria-label="PR #7 open, checks failing (2), changes requested, 1 unresolved comment"')
  expect((await drawn('thread.badge', pr({ state: 'merged' }))).html).toContain('github-glyph is-merged')
  expect((await drawn('thread.badge', pr({ state: 'closed' }))).html).toBe('')
  expect((await drawn('thread.badge')).html).toBe('')
})

it('puts the leading pull request in the title bar: its number and road, others counted', async () => {
  const chip = await drawn('header.chips', pr({ state: 'merged', key: 'github.com/acme/app#5', number: 5, at: 2 }), pr())
  // The open one leads, though the merged one is newer.
  expect(chip.text).toBe('#7+1')
  expect(chip.html).toContain('github-road')
  expect(chip.html.match(/<i class="is-[a-z]+">/g)).toEqual(['<i class="is-fail">', '<i class="is-changes">', '<i class="is-todo">'])
  expect((await drawn('header.chips')).html).toBe('')
})

it('lists every pull request in thread details, with how each came', async () => {
  const details = await drawn('details.section', pr(), pr({ key: 'github.com/acme/app#5', number: 5, title: 'Older', state: 'merged', how: 'hand' }))
  expect(details.text).toContain('acme/app#7 Mentions')
  expect(details.text).toContain('2 checks failing · opened by this thread')
  expect(details.text).toContain('Merged · attached by you')
})

it('shows a pull request beside the thread, leading with what to fix', async () => {
  const detail: PrDetail = {
    ...pr(), branch: 'superego/mentions', base: 'main', head: 'a1f3c9e00', polledAt: Date.now() - 30_000,
    checkList: [
      { name: 'test (ubuntu-latest)', result: 'fail', url: 'https://github.com/acme/app/actions/runs/42/job/1', runId: 42, startedAt: 0, completedAt: 281_000 },
      { name: 'smoke', result: 'fail', startedAt: 0, completedAt: 475_000 },
      { name: 'lint', result: 'pass', startedAt: 0, completedAt: 38_000 },
    ],
    reviews: [{ who: 'alice', verdict: 'changes' }, { who: 'bo-lin', verdict: 'commented' }],
    comments: [{ path: 'src/mentions.tsx', line: 84, body: 'This refetches on every keystroke.', who: 'alice', outdated: false }],
  }
  const view: PrView = {
    pr: detail, threads: [{ id: 't1', title: 'Mentions from extensions', archived: false }, { id: 'old', title: 'Earlier try', archived: true }],
    conversation: { body: 'Lets an extension **mention** its things.', earlier: 3, fetchedAt: Date.now(), remarks: [
      { who: 'bo-lin', body: 'Nice, does it work on phones?', at: Date.now() - 2 * 3600_000, url: `${URL}#issuecomment-1` },
      { who: 'alice', body: 'See the comment on `mentions.tsx`.', at: Date.now() - 3600_000, url: `${URL}#pullrequestreview-2`, verdict: 'changes' },
      { who: 'spammer', body: '', at: Date.now() - 60_000, hidden: 'spam' },
    ] },
  }
  const machine = fakeMachine({ threads: [thread(pr())], extensions: ['github'], methods: { [PR]: () => view } })
  ui = await mountUi({ extensions: [github], machines: [machine] })
  const pane = await ui.render({ pane: { kind: PANE, params: { url: URL } }, thread: 't1' })
  const text = pane.text()
  expect(text).toContain('Mentions')
  expect(text).toContain('superego/mentions → main')
  expect(text).toContain('2 checks failing and alice requested changes.')
  expect(text).toMatch(/To do\s*4/)
  expect(text).toContain('test (ubuntu-latest)4m 41s')
  expect(text).toContain('gh run view 42 --log-failed')
  expect(text).toContain('src/mentions.tsx:84 · alice')
  expect(text).toContain('1 check passed')
  expect(text).toContain('bo-linCommented')
  expect(text).toContain('Earlier tryArchived')
  expect(text).toContain('On a1f3c9e · updated 30s ago')
  // Its description under its title, the conversation oldest first, each linking to it on GitHub.
  expect(text).toContain('Lets an extension mention its things.')
  expect(pane.container.querySelector('.github-pane__description strong')?.textContent).toBe('mention')
  expect(text).toMatch(/Conversation\s*3/)
  expect(pane.container.querySelector<HTMLAnchorElement>('.github-talk__earlier')?.href).toBe(URL)
  expect([...pane.container.querySelectorAll('.github-talk__head b')].map((b) => b.textContent)).toEqual(['bo-lin', 'alice', 'spammer'])
  expect(text).toContain('alicerequested changes1h ago')
  expect(text).toContain('Hidden: spam.')
  expect(pane.container.querySelector<HTMLAnchorElement>('.github-talk__when a')?.href).toBe(`${URL}#issuecomment-1`)
  expect(pane.container.querySelector<HTMLAnchorElement>('.github-talk__when a')?.target).toBe('_blank')
  expect(ui.calls.find((c) => c.method === PR)?.params).toEqual({ url: URL, conversation: true })
})

it("says when a pull request's description and conversation couldn't be fetched, and that it has none", async () => {
  const detail: PrDetail = { ...pr({ unresolved: 0 }), checkList: [], reviews: [], comments: [], error: { kind: 'failed', message: 'error connecting to api.github.com' } }
  const { error: _error, ...fine } = detail
  const views: PrView[] = [{ pr: detail, threads: [] }, { pr: fine, threads: [], conversation: { body: '', remarks: [], earlier: 0, fetchedAt: 0 } }]
  for (const [i, view] of views.entries()) {
    const machine = fakeMachine({ threads: [thread(pr())], extensions: ['github'], methods: { [PR]: () => view } })
    ui = await mountUi({ extensions: [github], machines: [machine] })
    const text = (await ui.render({ pane: { kind: PANE, params: { url: URL } }, thread: 't1' })).text()
    if (i === 0) {
      expect(text).toContain('error connecting to api.github.com')
      expect(text).toContain("Its description and conversation couldn't be fetched.")
    } else {
      expect(text).toContain('No description.')
      expect(text).not.toContain('Conversation')
    }
    await ui.unmount()
    ui = undefined
  }
})
