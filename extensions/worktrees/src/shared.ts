// What both halves of worktrees agree on: what it is, and what it keeps with a thread (its fact, `ext.worktrees`).
import type { ExtensionAbout } from '@superego/protocol'

/** A thread's worktree: where, on which branch, the main checkout it belongs to, and whether archiving removed it (its branch stays). */
export type Worktree = { path: string; branch: string; root: string; removed?: boolean }

/**
 * Required: archiving removes a folder and unarchiving puts it back, so it's never switched off between the two. Its
 * threads are asked for with `worktree: true` (`options.worktrees`), or by their profile (`worktree: true`, or
 * `options: { worktrees: true }`).
 */
export const about = { name: 'worktrees', version: '1.0.0', api: '^2', title: 'Worktrees', description: 'Give a thread a git worktree of its own.', required: true } satisfies ExtensionAbout
