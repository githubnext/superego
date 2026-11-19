// What both halves of git agree on: what it is (its pane described to the agent, so pane_open can show the user the
// changes), the read the Changes pane makes, and its kind.
import type { ExtensionAbout } from '@superego/protocol'

/**
 * What the changes are measured from: `uncommitted`, the working tree against HEAD; `staged`, the index against HEAD;
 * `branch`, the working tree against where the branch left the default branch; `upstream`, the working tree against
 * where it left the branch it tracks.
 */
export const BASES = ['uncommitted', 'staged', 'branch', 'upstream'] as const
export type Base = (typeof BASES)[number]
/** A base a folder offers, with the branch it's measured from (for `branch` and `upstream`). */
export type BaseChoice = { base: Base; branch?: string }

/**
 * What changed in a thread's folder, from `base` (or the folder's own default: `branch` off the default branch,
 * `uncommitted` on it): the unified diff, the commit it's against (`ref`), the files git doesn't track yet (but for
 * `staged`), and the bases the folder offers.
 */
export const DIFF = 'git.diff'
export type Changes =
  | { repo: false }
  | { repo: true; base: Base; ref: string; diff: string; untracked: string[]; bases: BaseChoice[] }
/** A Changes pane's params: the base it shows, once one is picked. */
export type ChangesParams = { base?: Base }
/** The kind of pane that shows them (Changes). */
export const CHANGES = 'diff'

/** A base, as the pane's picker names it: "Since main". */
export const baseLabel = ({ base, branch }: BaseChoice) =>
  base === 'uncommitted' ? 'Uncommitted' : base === 'staged' ? 'Staged' : `Since ${branch}`

export const about = {
  name: 'git', version: '1.0.0', api: '^5', title: 'Git', description: 'Changes (⌘⇧D): what changed in a thread\'s folder, beside it.',
  panes: { [CHANGES]: `the changes in the working folder; optional { base: ${BASES.map((b) => `"${b}"`).join(' | ')} }` },
} satisfies ExtensionAbout
