// A bundled daemon runs from a snapshot of its build, not from the build itself. The build (an app's out/) is emptied and
// rewritten whenever the app is built again, its chunks under new hashed names, while a daemon outlives any one build:
// what it loads after starting (a lazy chunk, a provider on its first use, the image worker, the terminal's native
// module, the window's build it serves) would be gone from under it. So the app's daemon.js only launches: it copies the
// build into the data dir, `<dataDir>/builds/<build>`, and runs the daemon from there. The copy is the daemon's alone
// until it exits; a rebuild writes elsewhere. The build on disk moving on is what says a restart is due (see build.ts),
// and a restart runs daemon.js again, onto the new build. The daemon removes the other snapshots once it listens (one
// daemon per data dir), see `sweepSnapshots`.
//
// A packaged app's build is in its app.asar, which nothing rewrites: it runs where it is.
import { constants, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AppConfig } from '@superego/protocol'
import { readBuild } from './build.ts'
import { defaultDataDir } from './paths.ts'

/** Where a data dir's daemon keeps the snapshots of its build. */
export const snapshotsDir = (dataDir: string) => join(dataDir, 'builds')

/**
 * Run the daemon whose launcher is `launcher` (daemon.js's `import.meta.url`): `entry`, the module beside it that serves,
 * from a snapshot of the build in the data dir, or in place when packaged.
 */
export async function launchDaemon(app: AppConfig, launcher: string, entry: string) {
  const main = dirname(fileURLToPath(launcher))
  const from = /\.asar([/\\]|$)/.test(main) ? main : snapshotBuild(dirname(main), snapshotsDir(defaultDataDir(app)), main)
  await import(pathToFileURL(join(from, entry)).href)
}

/**
 * Copy the build `out` into `into`, as `<into>/<build>`; `main` (in `out`) is the daemon's code, whose build names the
 * snapshot. Returns where `main` is in it. A snapshot of the same build is there already when the daemon restarts
 * without a new build: it runs from that one. Copied whole first and only then named, so a build moving on during the copy can't
 * give a snapshot the wrong name, and a snapshot by a build's name is always complete. Clones where the file system can
 * (APFS), so it costs no space and little time.
 */
export function snapshotBuild(out: string, into: string, main: string): string {
  const inside = relative(out, main)
  // A snapshot is named by what was copied, so one by the name of the build on disk is that build.
  const made = join(into, readBuild(main))
  if (existsSync(made)) return join(made, inside)
  mkdirSync(into, { recursive: true })
  const copying = join(into, `.copying-${process.pid}`)
  rmSync(copying, { recursive: true, force: true })
  // Not the profile authors' types: the app's and the command line's, and the largest part of the build by far.
  for (const name of readdirSync(out)) {
    if (name !== 'types') cpSync(join(out, name), join(copying, name), { recursive: true, mode: constants.COPYFILE_FICLONE })
  }
  const snapshot = join(into, readBuild(join(copying, inside)))
  if (existsSync(snapshot)) rmSync(copying, { recursive: true, force: true })
  else {
    try { renameSync(copying, snapshot) } catch (error) {
      // Made meanwhile by another daemon starting for this data dir, of the same build.
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      rmSync(copying, { recursive: true, force: true })
    }
  }
  return join(snapshot, inside)
}

/**
 * Remove every snapshot in the data dir but the one the daemon whose code is in `running` runs from (none, when it runs
 * from source or a packaged app): only once it listens, as the data dir's one daemon, so none of them is in use.
 */
export function sweepSnapshots(dataDir: string, running: string) {
  const dir = snapshotsDir(dataDir)
  if (!existsSync(dir)) return
  // As the daemon's code knows where it is: by its real path (the data dir's may go through a symlink).
  const own = relative(realpathSync(dir), running).split(sep)[0]
  for (const name of readdirSync(dir)) {
    if (name !== own) rmSync(join(dir, name), { recursive: true, force: true })
  }
}
