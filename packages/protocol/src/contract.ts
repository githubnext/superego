// The extension contract: what an extension is at (its own version), what it needs of the host (a range of the
// extension API), and how a client asks a machine about both. Three versions, kept apart:
//
// - the release: the code a machine runs, by its git commit (`MachineVersion`); the packages themselves are 0.0.0;
// - the extension API (`EXTENSION_API`): what `defineDaemonExtension` and `defineUiExtension` give an extension, semver;
// - the protocol (`PROTOCOL_VERSION`): the wire's generation, and within it the features each side announces.
import type { ExtensionAbout } from './app.ts'

/**
 * The extension API this build gives extensions, both halves alike. 1.1: `superego.signal` in both halves, a UI
 * `setup`'s cleanup, and the `unarchiveAbandoned` hook. 1.2: `scopedValue` and `useValue`'s `scope`, `useMethod`,
 * window actions from a profile's UI, and the stable surface apart from `superego/unstable`. 1.3: `spawnGroup`. 1.5:
 * channels (`superego.channel` in a daemon half, `channel` in the window) and the `paneClosed` hook. 1.6: `recap`.
 * 1.7: `agentParts`, `agent()`'s handle (`replace`, `remove`), `auth.flow`, tool rows by prefix (`tool('x__*')`) and a
 * call's own verb (`ToolRow.verb`), the `thread.details` slot, and a tool result's images (`ToolCallProps.result.images`).
 * Minor: something added (an extension that uses it asks for `^1.<minor>`); major: something an extension could rely
 * on changed or went. An extension whose `api` range this doesn't satisfy is refused when it's set up.
 */
export const EXTENSION_API = '1.7.0'

/** What a machine says of an extension set up there: `hello.extensions` and `features.changed` carry one each. */
export type ExtensionManifest = Pick<ExtensionAbout, 'name' | 'version' | 'api' | 'capabilities'>

/** The version an extension counts as when it says none: a daemon from before versions, or a profile's that didn't. */
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
export const manifestOf = ({ name, version, api, capabilities }: ExtensionAbout): ExtensionManifest => ({
  name, ...(version ? { version } : {}), ...(api ? { api } : {}), ...(capabilities?.length ? { capabilities: [...capabilities] } : {}),
})

/** What a machine offers, as a client keeps it from `hello` and `features.changed`. */
export type Offer = { features?: string[]; extensions?: ExtensionManifest[] }

/** The version a machine's `name` extension is at: `UNVERSIONED` when it says none, nothing when it isn't there (or is off). */
export function extensionVersion(offer: Offer | undefined, name: string): string | undefined {
  if (!offer?.features?.includes(`ext:${name}`)) return undefined
  return offer.extensions?.find((e) => e.name === name)?.version ?? UNVERSIONED
}

/**
 * Whether a machine offers `feature`: a protocol feature (`threads`), an extension set up and on there (`ext:git`), one
 * at a version in a range (`ext:git@^1.2`; an extension that says no version counts as 0.0.0, so `@^1` leaves out a
 * daemon from before versions and `@<2` doesn't), or one with a capability it declares (`ext:git#stat`).
 */
export function offers(offer: Offer | undefined, feature: string): boolean {
  const m = /^ext:([a-z][a-z0-9-]*)(?:@(.+?))?(?:#(.+))?$/.exec(feature)
  if (!m || (m[2] === undefined && m[3] === undefined)) return offer?.features?.includes(feature) ?? false
  const [, name, range, capability] = m
  const version = extensionVersion(offer, name!)
  if (version === undefined) return false
  if (range !== undefined && !satisfies(version, range)) return false
  return capability === undefined || Boolean(offer?.extensions?.find((e) => e.name === name)?.capabilities?.includes(capability))
}
