// What both halves of git agree on: what it is, the read the Changes pane makes, and its kind.
import type { ExtensionAbout } from '@superego/protocol'

/** What changed in a thread's folder: the unified diff against HEAD, and files git doesn't track yet. */
export const DIFF = 'git.diff'
export type Changes = { diff: string; untracked: string[]; repo: boolean }
/** The kind of pane that shows them (Changes). */
export const CHANGES = 'diff'

/** What this extension is, for both halves: optional, so a machine can turn it off and a profile can do without it. */
export const about = { name: 'git', title: 'Git', description: 'Changes (⌘⇧D): what changed in a thread\'s folder, beside it.' } satisfies ExtensionAbout
