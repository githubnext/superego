// What a thread sees of what extensions registered (see `seenIn`): who draws a tool call, an entry or a settings
// section, which handler claims a link, which pane kind opens a file, folder or web page. A thread's profile's own
// first, else the app's (`preferProfile`).
import type { Pane } from '@superego/protocol'
import type { LinkHandler, LinkWhere, PaneKind, ToolRow, WorkPart, WorkRun } from './extension-api.ts'
import { drawsFor, lookUp, preferProfile, scopeIsOn, scopeOf, seenIn, type Owner, type Registry, type Where } from './registry.tsx'

/** The composer's completion providers for `where`, in the order registered. */
export const completionsIn = (registry: Registry, where: Where) => seenIn(registry.completions, where)

/**
 * What draws sent messages' blocks for `where`: those of the app's extensions (even one its thread goes without now,
 * since it went with the message then), and its own profile's.
 */
export const sentWithIn = (registry: Registry, where: Where) => {
  const scope = scopeOf(where)
  return registry.sentWith.filter(({ owner }) => !owner.profile || owner.profile === scope)
}

/**
 * Who says how calls to the tool `name` look for `where`: a registration of its own name, else the longest prefix
 * (`mcp__*`) it starts with; a profile's before the app's at each.
 */
function toolEntry(registry: Registry, name: string, where: Where) {
  const exact = lookUp(registry.tools, where, (t) => t.name === name)
  if (exact) return exact
  const prefixes = seenIn(registry.tools, where).filter((t) => t.name.endsWith('*') && name.startsWith(t.name.slice(0, -1)))
  const longest = Math.max(...prefixes.map((t) => t.name.length))
  return preferProfile(prefixes.filter((t) => t.name.length === longest))
}

/** How calls to the tool `name` are drawn for `where`, if an extension draws them whole. */
export const toolView = (registry: Registry, name: string, where: Where) => toolEntry(registry, name, where)?.component

/** Whose word it is how calls to the tool `name` look for `where`, if an extension's. */
export const toolOwner = (registry: Registry, name: string, where: Where) => toolEntry(registry, name, where)?.owner

/** How calls to the tool `name` are described for `where`: what an extension (or the core) said, else nothing (the defaults). */
export const toolRow = (registry: Registry, name: string, where: Where): ToolRow => toolEntry(registry, name, where)?.row ?? {}

/** Whether calls to the tool `name` show outside the fold of their run, for `where` (an extension said `fold: false`). */
export const unfoldedTool = (registry: Registry, name: string, where: Where) => toolEntry(registry, name, where)?.fold === false

/**
 * The handler that claims `href` (a link's, or inline code's text) for `where`: its profile's first, then the app's
 * extensions' in order, then the core's.
 */
export function linkHandler(registry: Registry, href: string, kind: 'link' | 'code', where: LinkWhere): LinkHandler | undefined {
  const seen = linksSeen(registry, where)
  const claims = ({ match }: LinkHandler) => typeof match === 'string' ? kind === 'link' && href.toLowerCase().startsWith(match.toLowerCase())
    // From the start each time: a /g or /y pattern remembers where it last matched.
    : match instanceof RegExp ? kind === 'link' && ((match.lastIndex = 0), match.test(href))
    : match(href, kind, where)
  const rank = (owner: Owner) => owner.profile ? 0 : owner.extension === 'core' ? 2 : 1
  return [...seen].sort((a, b) => rank(a.owner) - rank(b.owner)).find(claims)
}

/** The link handlers `where` has: its thread's profile's, and the app's but those of extensions the thread goes without. */
const linksSeen = (registry: Registry, where: LinkWhere) => seenIn(registry.links, where.machine && where.thread ? { machine: where.machine, thread: where.thread } : undefined)

/** The schemes `where`'s handlers claim by name (`ticket:` → `ticket`), for its HTML's links to keep. */
export const linkSchemes = (registry: Registry, where: LinkWhere) => [...new Set(linksSeen(registry, where).flatMap(({ match, scheme }) => [
  ...scheme ? [scheme.toLowerCase()] : [],
  ...typeof match === 'string' && /^[a-z][\w+.-]*:$/i.test(match) ? [match.slice(0, -1).toLowerCase()] : [],
]))]

/** How entries of `kind` are drawn for `where`, if an extension draws them. */
export const entryView = (registry: Registry, kind: string, where: Where) => lookUp(registry.entries, where, (e) => e.kind === kind)?.component

/** Who draws entries of `kind` for `where`, if an extension does. */
export const entryOwner = (registry: Registry, kind: string, where: Where) => lookUp(registry.entries, where, (e) => e.kind === kind)?.owner

/**
 * The component under the settings section that names `ui`, on `target` (a machine, or `APP`): a profile's there first,
 * as lookups take it; an app's UI half only where it speaks with the machine's half.
 */
export const settingsView = (registry: Registry, ui: string, target: string) => settingsEntry(registry, ui, target)?.component

/** The settings section's registration that `settingsView` draws, with its owner. */
export function settingsEntry(registry: Registry, ui: string, target: string) {
  const here = (s: Registry['settings'][number]) => s.owner.profile ? scopeIsOn(s.owner.profile, target) : s.owner.speaks?.(target) !== false
  return preferProfile(registry.settings.filter((s) => s.ui === ui && here(s)))
}

/** A run of work in parts, as the first extension (that `where` has) that divides it says; else whole. */
export function divideWork(registry: Registry, where: Where, run: WorkRun): WorkPart[] {
  for (const { divide } of seenIn(registry.work, where)) {
    try {
      const parts = divide(run)
      if (parts) return parts
    } catch (error) { console.error('Dividing work failed', error) }
  }
  return [{ blocks: run.blocks }]
}

/** The pane kind `kind` as `where` sees it: its profile's own first, else the app's. */
export const paneKind = (registry: Registry, kind: string, where: Where): Registry['panes'][number] | undefined => lookUp(registry.panes, where, (p) => p.kind === kind)

/** A pane's title: its own, else its kind's. */
export function paneTitle(registry: Registry, pane: Pane, where: Where): string {
  const named = paneKind(registry, pane.kind, where)?.title
  return pane.title ?? (typeof named === 'function' ? named(pane) : named) ?? pane.kind
}

/**
 * The pane kind a file opens in, for a thread: its profile's kind that takes the file, else any other that does, else
 * one that takes any file (`fallback`, its profile's first); none, if nothing here shows files.
 */
export function fileKind(registry: Registry, where: Where, path: string): string | undefined {
  return firstPaneKind(registry, where, (p) => !p.fallback && Boolean(p.opens?.(path))) ?? firstPaneKind(registry, where, (p) => Boolean(p.fallback))
}

/** The pane kind a folder opens in, for a thread: its profile's that shows folders, else any other; none, if none does. */
export const folderKind = (registry: Registry, where: Where) => firstPaneKind(registry, where, (p) => Boolean(p.folders))

/** The pane kind a web page opens in, for a thread: its profile's that shows web pages, else any other; none, if none does. */
export const urlKind = (registry: Registry, where: Where) => firstPaneKind(registry, where, (p) => Boolean(p.urls))

/** The first pane kind `where` sees that `takes` says so of: its profile's first, else the app's. */
const firstPaneKind = (registry: Registry, where: Where, takes: (kind: PaneKind) => boolean): string | undefined =>
  lookUp(registry.panes, where, takes)?.kind

/**
 * The panes a thread shows: all it has open but those of a kind only an extension that doesn't draw for it draws (it
 * goes without it, or its machine runs another major). They're kept with the thread, and show again once it draws.
 */
export function shownPanes(registry: Registry, where: Where): Pane[] {
  const gone = (kind: string) => !paneKind(registry, kind, where) && registry.panes.some((p) => p.kind === kind && !p.owner.profile && !drawsFor(p.owner, where))
  return (where.thread.panes ?? []).filter((pane) => !gone(pane.kind))
}
