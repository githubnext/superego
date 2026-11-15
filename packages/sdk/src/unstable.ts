/**
 * 'superego/unstable': the window's own workings, which the bundled extensions build on. They change whenever the window
 * does, with no notice in the extension API's version: reach for one only when 'superego/ui' has nothing for it.
 */
// See packages/app/src/renderer/sdk-unstable.ts.
export * from '@superego/app/sdk-unstable'
