/// <reference path="./env.d.ts" />
// worktrees, UI half: a thread's branch among the title bar's chips, and the New thread dialog's "in a worktree of its
// own" checkbox (sent as `options.worktrees`; a thread started beside one in a worktree starts in one too).
import { defineUiExtension, type NewThreadFieldProps, type SlotProps } from '@superego/app/ui'
import type { ThreadInfo } from '@superego/protocol'
import { about, type Worktree } from './shared.ts'

const treeOf = (thread: ThreadInfo) => thread.ext?.worktrees as Worktree | undefined

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.slot('thread.crumb', Branch)
    superego.newThreadField({ component: InWorktree, from: (thread) => treeOf(thread) ? true : undefined })
  },
})

/** The branch it works on, its worktree's path on hover. */
function Branch({ thread }: SlotProps['thread.crumb']) {
  const tree = treeOf(thread)
  if (!tree) return null
  return <span className="titlebar__chip thread__branch" title={`${tree.branch}\n${tree.path}`}>{tree.branch}</span>
}

/** In a repository: the checkout itself, or a worktree of its own. */
function InWorktree({ value, onChange }: NewThreadFieldProps) {
  return (
    <label className="new-thread__check">
      <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked ? true : undefined)} />
      <span>In a worktree of its own <em>(in a git repository: a new branch, apart from the checkout)</em></span>
    </label>
  )
}
