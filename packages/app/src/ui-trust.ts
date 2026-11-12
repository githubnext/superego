// Which remote profile UIs may run in the window. Code a daemon serves runs with the window's reach (every machine),
// so a machine's say-so isn't enough: the app's home records the decision, per machine identity and per hash of the
// exact code the window would load. Shared by the window (hash, decision) and the main process (the store).

/** One allowed profile UI: the daemon's id (from hello), the profile's directory there, and the hash of its code. */
export type UiGrant = { machine: string; dir: string; hash: string }

/** This computer's own daemon, same user: trusted as it always was. Every other machine must be allowed. */
export const LOCAL = 'local'

/** SHA-256 over the modules' paths and code, in path order, each length-prefixed so no two sets collide. */
export async function hashModules(modules: { path: string; code: string }[]): Promise<string> {
  const encoder = new TextEncoder()
  const parts = [...modules].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .flatMap((m) => [m.path, m.code].map((text) => `${encoder.encode(text).length}:${text}`))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(parts.join('\n')))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const sameGrant = (a: UiGrant, b: UiGrant) => a.machine === b.machine && a.dir === b.dir && a.hash === b.hash

/** Whether to load a profile's UI from `machine`: this computer's always; any other only for the hash it was allowed at. */
export function uiDecision(machine: string, grant: UiGrant, grants: UiGrant[]): 'load' | 'ask' {
  if (machine === LOCAL) return 'load'
  return grants.some((g) => sameGrant(g, grant)) ? 'load' : 'ask'
}
