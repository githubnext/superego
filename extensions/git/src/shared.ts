// What both halves of git agree on: what it is (its pane described to the agent, so pane_open can show the user the
// changes), the read the Changes pane makes, and its kind.
import type { ExtensionAbout } from '@superego/protocol'

/** What changed in a thread's folder: the unified diff against HEAD, and files git doesn't track yet. */
export const DIFF = 'git.diff'
export type Changes = { diff: string; untracked: string[]; repo: boolean }
/** The kind of pane that shows them (Changes). */
export const CHANGES = 'diff'

export const about = {
  name: 'git', version: '1.0.0', api: '^3', title: 'Git', description: 'Changes (⌘⇧D): what changed in a thread\'s folder, beside it.',
  panes: { [CHANGES]: 'the changes in the working folder; no params' },
} satisfies ExtensionAbout
