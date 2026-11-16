/**
 * 'superego': what a profile and an extension's daemon half import. `defineProfile` makes a profile's profile.ts;
 * `defineDaemonExtension` an extension's daemon half, whose `setup` gets the `DaemonApi`: tools for the agent
 * (`defineExtension`, `defineTool`), actions (`defineAction`), live values, methods and more. `obj`, `str` and the other
 * schema builders type the parameters of tools, actions and methods. What's here follows the extension API's semver
 * (`EXTENSION_API`).
 */
// The daemon half's stable surface. See packages/daemon/src/sdk.ts.
export * from '@superego/daemon/sdk'
// Named again, to stay first in what an author reads (an entry's own exports come before what `export *` brings): the
// profile's, below, are this entry's own.
export { defineDaemonExtension, defineAction, type DaemonExtension, type DaemonApi } from '@superego/daemon/sdk'
import type { ProfileSpec as CoreProfileSpec } from '@superego/daemon/sdk'
import type { ProfileServers } from '@superego/mcp-servers/shared'

/**
 * A profile, as its profile.ts default-exports it (`defineProfile`): the core's keys, and the bundled extensions' own
 * (`superego.profileKey`). Closed: a key that's misspelt, or gone, fails the type check (and is the profile's problem
 * where it's listed, once it loads).
 */
export type ProfileSpec = CoreProfileSpec & {
  /**
   * The mcp-servers extension's: the machine's MCP servers its threads use, by name, and servers of its own, as objects
   * of servers by name: `['linear', { docs: { command: 'node', args: ['docs.js'] } }]`. With `extends`, both profiles'.
   */
  mcpServers?: ProfileServers
}

/** Identity for type inference: `export default defineProfile({ … })`. */
export const defineProfile = (spec: ProfileSpec) => spec
