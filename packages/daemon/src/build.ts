// Which build of the daemon's code something is, as a short hash of that code on disk. The daemon records it when it
// starts; a client hashes what is on disk now; when they differ, the running daemon is out of date and wants a restart.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The build of the daemon code in `dir`. Bundled (the app's `out/main`): its JavaScript, without the app's own
 * `main.js`. From source (`packages/daemon/src`): the TypeScript of the packages the daemon is made of.
 */
export function readBuild(dir: string): string {
  const hash = createHash('sha256')
  const bundled = readdirSync(dir).filter((name) => name.endsWith('.js') && name !== 'main.js').sort()
  if (bundled.length) {
    for (const name of bundled) hash.update(name).update(readFileSync(join(dir, name)))
    return hash.digest('hex').slice(0, 12)
  }
  for (const pkg of ['protocol', 'settings', 'daemon']) {
    const root = join(dir, '..', '..', pkg, 'src')
    for (const file of walk(root)) hash.update(file.slice(root.length)).update(readFileSync(file))
  }
  return hash.digest('hex').slice(0, 12)
}

function walk(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : name.endsWith('.ts') ? [path] : []
  })
}

/**
 * The git commit the code in `dir` was checked out at, and when it was made (ms): what tells one machine's Superego
 * from another's. A build has it written in (`commit.json`, see writeCommit), so a packaged app knows it too; from
 * source, it's the checkout's. Undefined outside a git checkout without one.
 */
export function readCommit(dir: string): { commit: string; committedAt: number } | undefined {
  try {
    const written = JSON.parse(readFileSync(join(dir, COMMIT_FILE), 'utf8')) as { commit?: unknown; committedAt?: unknown }
    if (typeof written.commit === 'string' && typeof written.committedAt === 'number') return { commit: written.commit, committedAt: written.committedAt }
  } catch {}
  try {
    const [commit, seconds] = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%H %ct'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(' ')
    return commit && seconds ? { commit, committedAt: Number(seconds) * 1000 } : undefined
  } catch { return undefined }
}

const COMMIT_FILE = 'commit.json'

/** Write the commit of the checkout `source` is in next to a build's code in `dir`, for readCommit there. */
export function writeCommit(source: string, dir: string) {
  const commit = readCommit(source)
  if (commit) writeFileSync(join(dir, COMMIT_FILE), `${JSON.stringify(commit)}\n`)
}
