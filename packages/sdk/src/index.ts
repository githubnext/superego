/**
 * 'superego': what a profile and an extension's daemon half import. `defineProfile` makes a profile's profile.ts;
 * `defineDaemonExtension` an extension's daemon half, whose `setup` gets the `DaemonApi`: tools for the agent
 * (`defineExtension`, `defineTool`), actions (`defineAction`), live values, methods and more. `obj`, `str` and the other
 * schema builders type the parameters of tools, actions and methods. What's here follows the extension API's semver
 * (`EXTENSION_API`).
 */
// The daemon half's stable surface. See packages/daemon/src/sdk.ts.
export * from '@superego/daemon/sdk'
