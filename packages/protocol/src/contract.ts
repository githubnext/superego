// The extension contract: what an extension is at (its own version), what it needs of the host (a range of the
// extension API), and how a client asks a machine about both. Three versions, kept apart:
//
// - the release: the code a machine runs, by its git commit (`MachineVersion`); the packages themselves are 0.0.0;
// - the extension API (`EXTENSION_API`): what `defineDaemonExtension` and `defineUiExtension` give an extension, semver;
// - the protocol (`PROTOCOL_VERSION`): the wire's generation, and within it the features added since it began.
import type { ExtensionAbout } from './app.ts'

/**
 * The extension API this build gives extensions, both halves alike. 2.0 starts the count over: all of 1.x, renamed
 * (projects, `ThreadInfo.facts`, `starting`/`started`, `beforeSend`, …), without protocol generation 1's old names.
 * 2.1: a rail view's `action` (its tab, which ⌘1–⌘9 go to) and `useRailShortcut`. Two went from 2.1 without a
 * major: the daemon half's unstable `harness` (pi-durable's own, never part of the stable API), and an extension's
 * `capabilities` with the `ext:<name>#<capability>` it answered in `has` (no extension declared any; ask for a
 * version instead).
 * 2.2: the daemon half's `quiet` (a thread whose runs someone else hears: `ThreadInfo.quiet`).
 * 2.3: daemon seams so extensions stop reaching into internals: `threads.send`'s `from` (and `OutgoingMessage.from`),
 * `threads.answering`, `threads.noteRead`/`parentRead`, `machines.add`/`update`/`remove`, `state({ publish })`,
 * `profileKey` (`ProfileInfo.brings`), and a settings section's `value`. Gone with it, without a major (generation 2
 * wasn't released before v0.1.0): the profile's `worktree` and `mcp`, `NewThread.worktree`, the `ProfileMcpServer` type
 * (now the mcp-servers extension's, whose `mcpServers` is one list), and `ProfileInfo.mcp`.
 * 2.4: `threads.idle` (wait until a thread isn't working). Gone by v0.1.0, without a major and unrecorded then: the
 * daemon half's `pane(kind, about)` (an extension describes its pane kinds in `about.panes`); the UI half's
 * `app.notify`, and `threadNotification`, `signInNotification` and `unreadCount` from 'superego/unstable' (the app
 * notifies by itself); the protocol's `reportsToParent` (`ThreadInfo.quiet` instead).
 * 2.5: `state({ publish })` takes `{ key, empty }`: a published scope reads null only until it's read, then `empty`
 * for a thread without state (its `publish: key` went without a major: agent-ui was its only user); `threads.answering`
 * passes over a user message nobody sent (a compaction's summary, a reset's handoff, a continuation); `threads.of`
 * finds a subagent's thread; `ProfileSpec` is closed (the bundled extensions' keys come with 'superego''s
 * `defineProfile`; `LoadedSpec` is a profile as loaded, extensions' keys and all), and `ProfileInfo.problems`;
 * `threads.noteRead(reader, read)` takes the thread as it was read (its `ThreadInfo`), not its id (thread-tools was its
 * only user); `superego.extensions()`, `about.secrets`, `AgentChoice.setup` and `AgentPartsThread.setup` (an agent
 * that sets the machine up, offered setup tools by capability rather than by its extension's name). 'superego/testing''s window draws a tool call's row (`render({ tool })`) and answers `toolRow`,
 * `describeRun`, `mainKind`, `linkHandler` and `urlKind`.
 * 3.0: a data view's content is blocks (`Block[]`, the schema agents draw with, from 'superego'), with `list` and
 * buttons that run the extension's actions. `ViewContent`, `ViewItem` and `ViewAction` are gone.
 * 3.1: 'superego/ui''s `Glyph` (every mark, a status's and a board's or machine's), `StatusWord`, `statusShape`, `statusWord`
 * and `STATUS_WORDS` (the words: Question, Permission, Sign in, Failed, Done, Working); `StatusGlyph` and `statusLabel` take
 * `quiet`.
 * 4.0: a tool call's `result.images` (`ToolCallProps`) are `ImageItem`s: where each image is in the transcript, its type
 * and size, not its pixels (a window reads those with `image.read` as it shows one: `ImageFrame`, `Lightbox`). A
 * transcript's images come to windows without their pixels.
 * 4.1: the thread hook `stopped(thread, { withdrawn })`: a stop withdrew messages others had queued for it.
 * 4.2: the UI half's `style(css)`: CSS owned by the extension, a profile's scoped to what that profile draws.
 * 5.0: the composer completes in the New thread dialog too, before there's a thread: a completion provider's `where`
 * (`ComposerWhere`) has the folder it writes for (`cwd`), and its `thread` only once there is one. A `sentWith`
 * component gets `{ machine, thread, items }`, as before.
 * 5.1: the UI half's `useTabGlyph` (a pane's own glyph on its tab, a spinner say); a `WebView`'s `stop()`, its state's
 * `progress` while it loads, and a framed one's `onEvent` telling whether it's loading.
 * 5.2: the daemon half's `call(id, params)`: another extension's read method on this machine.
 * 5.3: the daemon half's `agentKind({ name, runner })`: a kind of agent whose threads (a profile's `agent`) have their
 * turns run by a task of the extension's instead of a model.
 * 5.4: the UI half's `addToComposer(where, item)` (a chip in a thread's composer, its files sent with the next message);
 * a `WebView`'s `run(fn, ...args)` (a function run in its page) and `capture(rect)` (a part of it, as an image).
 * 5.5: the UI half's `theme(theme)`: a theme for code and the terminal, offered in Settings → Appearance.
 * 5.6: an agent kind's `menu` and `profile` (its group in the model menus, `ModelCatalog.agents`, and the profile a
 * thread picked there starts with); `AgentPartsThread`'s `model` and `thinking` (the thread's own); a status
 * contribution's `{ working }` (what a working thread waits on, `Status.msg`).
 * 5.7: an agent kind's `describe` (what a thread of it runs on, where its model shows: `ThreadInfo.agent`, its
 * `model`, `provider` and `thinking`), and `ThreadInfo.context` (how full a thread's context is).
 * 5.8: the daemon half's `secrets` (`get`, `onChange`: the values of its `secret` settings, a setting type that keeps
 * them in the machine's secret store, which only the user sets) and `dir` (its own folder in the data folder);
 * 'superego/testing''s `setSecret`.
 * Minor: something added (an extension that uses it asks for `^3.<minor>`); major: something an extension could rely
 * on changed or went, from 2.5 on without exception. An extension whose `api` range this doesn't satisfy is refused
 * when it's set up.
 */
export const EXTENSION_API = '5.8.0'

/** What a machine says of an extension set up there: `hello.extensions` and `features.changed` carry one each. */
export type ExtensionManifest = Pick<ExtensionAbout, 'name' | 'version' | 'api'>

/** The version an extension counts as when it says none (a profile's may not). */
export const UNVERSIONED = '0.0.0'

type Triple = [number, number, number]
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const PARTIAL = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?$/

/** `major.minor.patch`, or nothing when `text` isn't one (no prereleases, no build metadata). */
export function parseVersion(text: string): Triple | undefined {
  const m = VERSION.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

const compare = (a: Triple, b: Triple) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
/** `a` against `b`: negative when older, positive when newer. Versions that don't parse count as 0.0.0. */
export const compareVersion = (a: string, b: string) => compare(parseVersion(a) ?? [0, 0, 0], parseVersion(b) ?? [0, 0, 0])

type Test = (v: Triple) => boolean
/** The tests one comparator stands for: `^1.2`, `~1.2.3`, `>=1.2`, `<2`, `1.2` (1.2.x), `*`. */
function comparator(text: string): Test | undefined {
  if (text === '*' || text === 'x') return () => true
  const [, op = '', rest = ''] = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(text)!
  const m = PARTIAL.exec(rest)
  if (!m) return undefined
  const parts = [m[1], m[2], m[3]].filter((p) => p !== undefined).map(Number)
  const low: Triple = [parts[0]!, parts[1] ?? 0, parts[2] ?? 0]
  const at = (v: Triple) => compare(v, low)
  // The version after the last part given: `1` → 2.0.0, `1.2` → 1.3.0, `1.2.3` → 1.2.4.
  const next = (n: number): Triple => n === 1 ? [low[0] + 1, 0, 0] : n === 2 ? [low[0], low[1] + 1, 0] : [low[0], low[1], low[2] + 1]
  const below = (high: Triple) => (v: Triple) => at(v) >= 0 && compare(v, high) < 0
  switch (op) {
    case '>=': return (v) => at(v) >= 0
    case '>': return parts.length === 3 ? (v) => at(v) > 0 : (v) => compare(v, next(parts.length)) >= 0
    case '<': return (v) => at(v) < 0
    case '<=': return parts.length === 3 ? (v) => at(v) <= 0 : (v) => compare(v, next(parts.length)) < 0
    // The leftmost part that isn't zero stays: ^1.2 is 1.x from 1.2, ^0.2 is 0.2.x, ^0.0.3 is 0.0.3 only.
    case '^': return below(low[0] > 0 || parts.length === 1 ? next(1) : low[1] > 0 || parts.length === 2 ? next(2) : next(3))
    case '~': return below(parts.length === 1 ? next(1) : next(2))
    default: return parts.length === 3 ? (v) => at(v) === 0 : below(next(parts.length))
  }
}

/** A range as a test, or nothing when it isn't one: comparators joined by spaces (all hold), sets by `||` (any). */
function compileRange(range: string): Test | undefined {
  const sets = range.trim().split('||').map((set) => set.trim().split(/\s+/).filter(Boolean).map(comparator))
  if (!sets.length || sets.some((set) => !set.length || set.some((test) => !test))) return undefined
  return (v) => sets.some((set) => set.every((test) => test!(v)))
}

/** Whether `range` is one `satisfies` understands. */
export const validRange = (range: string) => compileRange(range) !== undefined

/** Whether `version` is in `range` (`^1.2`, `>=1 <3`, `~1.4 || ^2`); false when either doesn't parse. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version)
  const test = compileRange(range)
  return Boolean(v && test?.(v))
}

/**
 * What's wrong with how an extension says its versions, for this host: a version that isn't one, a range that isn't
 * one, or an API range `host` isn't in. Nothing when it can be set up.
 */
export function contractProblem(about: Pick<ExtensionAbout, 'name' | 'version' | 'api'>, host = EXTENSION_API): string | undefined {
  if (about.version !== undefined && !parseVersion(about.version)) return `Extension ${about.name}'s version "${about.version}" isn't major.minor.patch`
  if (about.api === undefined) return undefined
  if (!validRange(about.api)) return `Extension ${about.name}'s api "${about.api}" isn't a version range (^1, ^1.2, >=1 <3)`
  if (!satisfies(host, about.api)) return `Extension ${about.name} needs extension API ${about.api}, and this Superego has ${host}: update ${newerSatisfies(host, about.api) ? 'Superego' : 'the extension'}`
  return undefined
}

/** Whether a host newer than `host` could be in `range`: then it's the host that's behind, not the extension. */
function newerSatisfies(host: string, range: string) {
  const [major, minor] = parseVersion(host) ?? [0, 0, 0]
  const later = [
    ...Array.from({ length: 50 }, (_, k) => `${major}.${minor + k + 1}.0`),
    ...Array.from({ length: 10 }, (_, k) => [`${major + k + 1}.0.0`, `${major + k + 1}.99.0`]).flat(),
  ]
  return later.some((v) => satisfies(v, range))
}

/** An extension's manifest, from how it declares itself: only what it says. */
export const manifestOf = ({ name, version, api }: ExtensionAbout): ExtensionManifest => ({
  name, ...(version ? { version } : {}), ...(api ? { api } : {}),
})

/** What a machine offers, as a client keeps it from `hello` and `features.changed`: nothing before it has said. */
export type Offer = { features?: string[]; extensions?: ExtensionManifest[] }

/** The version a machine's `name` extension is at: `UNVERSIONED` when it says none, nothing when it isn't there (or is off). */
export function extensionVersion(offer: Offer | undefined, name: string): string | undefined {
  const extension = offer?.extensions?.find((e) => e.name === name)
  return extension && (extension.version ?? UNVERSIONED)
}

/**
 * Whether a machine offers `feature`: a protocol feature (one in `FEATURES`), an extension set up and on there
 * (`ext:git`), or one at a version in a range (`ext:git@^1.2`; an extension that says no version counts as 0.0.0).
 */
export function offers(offer: Offer | undefined, feature: string): boolean {
  const m = /^ext:([a-z][a-z0-9-]*)(?:@(.+))?$/.exec(feature)
  if (!m) return offer?.features?.includes(feature) ?? false
  const [, name, range] = m
  const version = extensionVersion(offer, name!)
  return version !== undefined && (range === undefined || satisfies(version, range))
}
