// worktrees, UI half, in a window: the mark on a thread's row in the sidebar (the `thread.badge` slot), a branch icon
// named by its branch while the thread has a worktree, nothing without one or once archiving removed it.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import worktrees from '../src/ui.tsx'
import type { Worktree } from '../src/shared.ts'

let ui: TestWindow
beforeEach(async () => { ui = await mountUi({ extensions: [worktrees] }) })
afterEach(async () => { await ui.unmount() })

const thread = (tree?: Worktree) => testThread(tree ? { facts: { worktrees: tree } } : {})
/** What the slot draws for a thread, as markup. */
const badge = async (tree?: Worktree) => {
  const drawn = await ui.render({ slot: 'thread.badge', thread: thread(tree) })
  const html = drawn.container.innerHTML
  await drawn.unmount()
  return html
}

it("marks a thread's row with its branch while it has a worktree of its own", async () => {
  const tree = { path: '/w/fix-it', branch: 'superego/fix-it', root: '/repo' }
  const marked = await badge(tree)
  expect(marked).toContain('class="thread-badge"')
  expect(marked).toContain('title="superego/fix-it"')
  expect(marked).toContain('aria-label="on branch superego/fix-it"')
  expect(marked).toContain('<svg')
  expect(await badge()).toBe('')
  expect(await badge({ ...tree, removed: true })).toBe('')
})
