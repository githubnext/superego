// Compatibility, in two tables: aliases on the wire, for a client and daemon of different releases; and migrations of
// data, for what an older release stored. They end differently. An alias goes at its milestone (or with the protocol's
// generation, whichever comes first), and a test fails once one is past it, so it's taken out rather than forgotten.
// A migration stays as long as data from before it may still be opened, whatever the protocol does.
//
// The skew policy they serve is in the guide (packages/cli/skill/guide.md), "Versions and compatibility".

/**
 * A name kept on the wire after it moved, by the side that keeps it: a daemon answering an older client by the old
 * name, or a window coping with an older daemon's shape. `until`: the milestone, a date (`YYYY-MM-DD`) after which
 * it's removed; and it goes with `PROTOCOL_VERSION` 2 regardless.
 */
export type Alias = { side: 'daemon' | 'window'; since: string; until: string; note: string } & (
  | { kind: 'method'; old: string; now: string }
  | { kind: 'watch'; old: string; now: string; event: string }
  | { kind: 'feature'; old: string; now: string }
  | { kind: 'fact'; old: string; now: string }
  | { kind: 'shape'; where: string }
  /** An author's API kept under its old name: an extension written against it still sets up, with a warning. */
  | { kind: 'api'; old: string; now: string; where: string }
)

/** How long a moved name is kept on the wire: windows and daemons this far apart keep working together. */
const KEPT = '2027-03-01'

export const ALIASES = {
  'thread.diff': { side: 'daemon', kind: 'method', old: 'thread.diff', now: 'git.diff', since: '2026-11-13', until: KEPT, note: 'Changes moved into the git extension' },
  'skill.list': { side: 'daemon', kind: 'method', old: 'skill.list', now: 'skills.list', since: '2026-11-13', until: KEPT, note: 'skills moved into an extension' },
  // Actions too: answered by the extension's action of the new name.
  'thread.meta': { side: 'daemon', kind: 'method', old: 'thread.meta', now: 'ego.ask', since: '2026-11-13', until: KEPT, note: 'Ego moved into an extension' },
  'thread.meta.clear': { side: 'daemon', kind: 'method', old: 'thread.meta.clear', now: 'ego.clear', since: '2026-11-13', until: KEPT, note: 'Ego moved into an extension' },
  'meta.watch': { side: 'daemon', kind: 'watch', old: 'meta.watch', now: 'ego.thread', event: 'meta.changed', since: '2026-11-13', until: KEPT, note: "Ego's thread is the ego extension's live value" },
  'feature:ego': { side: 'daemon', kind: 'feature', old: 'ego', now: 'ext:ego', since: '2026-11-13', until: KEPT, note: 'announced while the ego extension is' },
  'fact:worktree': { side: 'daemon', kind: 'fact', old: 'worktree', now: 'worktrees', since: '2026-11-13', until: KEPT, note: "ThreadInfo.worktree: the worktrees extension's facts (the branch chip)" },
  'fact:meta': { side: 'daemon', kind: 'fact', old: 'meta', now: 'ego', since: '2026-11-12', until: KEPT, note: "ThreadInfo.meta: the ego extension's facts (Ego's Clear)" },
  'thread.archive:worktree': { side: 'daemon', kind: 'shape', where: 'daemon.ts, thread.archive', since: '2026-11-13', until: KEPT, note: "thread.archive's `worktree`, for windows older than its `notes`" },
  'ui:view-slots': {
    side: 'window', kind: 'api', old: "slot('sidebar' | 'rail' | 'footer' | 'thread.header' | 'thread.aside', …)", now: "view('<extension>.<name>', { fits, default, … })",
    where: 'packages/app/src/renderer/extension.tsx (VIEW_SLOTS)', since: '2026-11-14', until: KEPT, note: 'slots that became places: each declares a view, with a warning',
  },
  'superego/ui:unstable': {
    side: 'window', kind: 'api', old: "the window's workings from 'superego/ui'", now: "'superego/unstable'",
    where: 'packages/app/src/renderer/profile-ui.ts (sharedModules)', since: '2026-11-14', until: KEPT, note: "a profile's UI still finds them in 'superego/ui', without types",
  },
  'ask-user:pending': { side: 'daemon', kind: 'shape', where: 'extensions/ask-user/src/daemon.ts', since: '2026-11-14', until: KEPT, note: "every thread's questions in one list (ask-user.pending), for windows older than its scoped ask-user.asking" },
  'ask-user:labels': { side: 'window', kind: 'shape', where: 'extensions/ask-user/src/ui.tsx', since: '2026-11-12', until: KEPT, note: 'options as plain labels, from a daemon whose ask-user says no version' },
} as const satisfies Record<string, Alias>
export type AliasId = keyof typeof ALIASES

/** The aliases of one kind, as the side that keeps them reads them. */
export const aliasesOf = <K extends Alias['kind']>(kind: K) =>
  (Object.values(ALIASES) as Alias[]).filter((a): a is Extract<Alias, { kind: K }> => a.kind === kind)

/**
 * A read-through of something an older release stored, under an old name or in an old place, until it's written
 * anew. `before`: data written before this date may need it. Kept while such data may still be opened: a
 * database, a settings file or a profile from then. Not tied to the protocol: a bump doesn't remove one.
 */
export type Migration = { where: string; before: string; note: string; renames?: Record<string, string> }

export const MIGRATIONS = {
  /** `LEGACY` in daemon.ts: `ThreadMeta.worktree` and `meta` read as the worktrees and ego extensions' state. */
  'thread-state': { where: 'packages/daemon/src/daemon.ts (LEGACY)', before: '2026-11-13', note: 'extension state the core kept with a thread, read as the extension\'s own until it writes it' },
  /** `migrateHidden` in daemon.ts: Ego's thread kept apart in the catalog, or marked `meta`, made a hidden ego thread. */
  'hidden-threads': { where: 'packages/daemon/src/daemon.ts (migrateHidden)', before: '2026-11-13', note: "Ego's thread from before hidden threads, made one" },
  /** Extensions known by another name now: a profile's `without`, and the switch stored in settings. */
  'extension-names': {
    where: 'packages/daemon/src/profiles.ts (RENAMED)', before: '2026-11-13', note: 'the thread tools were "threads", the sidebar\'s name',
    renames: { threads: 'thread-tools' },
  },
  /** The app's settings kept under another key now. */
  'app-settings': {
    where: 'packages/app/src/shared.ts (APP_MOVED)', before: '2026-11-13', note: "settings that became the window's or an extension's",
    renames: { 'threads.sort': 'app.sort', 'app.unread': 'unread.scope', 'app.notifications': 'notifications.enabled' },
  },
  /** A shortcut (`app.keys`) set for an action known by another id now. */
  'action-keys': {
    where: 'packages/app/src/shared.ts (ACTIONS_MOVED)', before: '2026-11-14', note: 'actions that moved into an extension',
    renames: { 'panes.changes': 'git.changes', 'thread.unread': 'unread.next', 'app.meta': 'ego.open' },
  },
  /** `threads.details` on, from before views were placed by `app.layout`: the details in the aside. */
  layout: { where: 'packages/app/src/shared.ts (withMovedLayout)', before: '2026-11-14', note: 'placement settings from before the layout' },
} as const satisfies Record<string, Migration>
export type MigrationId = keyof typeof MIGRATIONS
