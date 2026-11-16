// The main process's build, against the window's (see ../main-build.ts): the hash of the sources it and its preload
// were built from, read once as it starts. A packaged app's out/ (in its app.asar) never changes under it, so it doesn't
// look. (Not by `app.isPackaged`: that's true of `pnpm dev`'s Electron too, renamed to the app's name.)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Next to the main process, written as it's built (../main-build.ts). */
export const BUILD_FILE = 'build.json'

/** The build in `dir` (out/main), or undefined: packaged, or (said on the console) not written there. */
export function readMainBuild(dir: string): string | undefined {
  if (/\.asar([/\\]|$)/.test(dir)) return undefined
  try {
    const { build } = JSON.parse(readFileSync(join(dir, BUILD_FILE), 'utf8')) as { build?: unknown }
    if (typeof build === 'string') return build
    console.error(`${BUILD_FILE}: no build in it; the window can't tell whether it runs another`)
  } catch (error) {
    console.error(`${BUILD_FILE}: ${error instanceof Error ? error.message : String(error)}; the window can't tell whether it runs another`)
  }
  return undefined
}

/** Whether a window runs another build than the main process: only when both are known. */
export const buildsDiffer = (window: string | undefined, main: string | undefined) =>
  window !== undefined && main !== undefined && window !== main
