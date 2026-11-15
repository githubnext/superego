// worktrees, UI half: the mark on a thread's row in the sidebar (the `thread.badge` slot): a branch icon named by its
// branch while the thread has a worktree, nothing without one or once archiving removed it.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { defineApp, type ThreadInfo } from '@superego/protocol'
// The registry isn't part of the UI API (the window builds it), so it's taken from where it's made.
import { createRegistry, seenIn } from '../../../packages/app/src/renderer/extension.tsx'
import worktrees from '../src/ui.tsx'
import type { Worktree } from '../src/shared.ts'

const app = defineApp({ name: 'superego', id: 'superego' })
const machine = { id: 'local', label: 'This Mac', state: 'connected' } as never
const thread = (tree?: Worktree): ThreadInfo => ({
  id: '1', title: 't', cwd: '/', createdAt: 0, activeAt: 0, session: { root: '/', name: '/' }, status: { state: 'idle' },
  ...(tree ? { ext: { worktrees: tree } } : {}),
})

it("marks a thread's row with its branch while it has a worktree of its own", () => {
  const registry = createRegistry(app, [worktrees], () => {})
  // What the slot draws for a thread: each of its components, as Slot does.
  const badge = (t: ThreadInfo) => seenIn(registry.slots['thread.badge'], { machine: 'local', thread: t })
    .map(({ component }) => renderToStaticMarkup(createElement(component, { machine, thread: t }))).join('')
  expect(registry.slots['thread.badge']).toHaveLength(1)
  const tree = { path: '/w/fix-it', branch: 'superego/fix-it', root: '/repo' }
  const marked = badge(thread(tree))
  expect(marked).toContain('class="thread-badge"')
  expect(marked).toContain('title="superego/fix-it"')
  expect(marked).toContain('<svg')
  expect(badge(thread())).toBe('')
  expect(badge(thread({ ...tree, removed: true }))).toBe('')
})
