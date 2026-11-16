// The window's build: the hash of the main process's sources as the window was loaded, and (in dev) word of the next.
// The app's build writes this module anew (../main-build.ts); as written here, for whatever else bundles the window's
// code (tests), it has none, and the window compares nothing.
export const build: string | undefined = undefined
export function onBuild(_listener: (build: string) => void): () => void { return () => {} }
