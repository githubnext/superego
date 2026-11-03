// Which build of the daemon's code something is, as a short hash of that code on disk. The daemon records it when it
// starts; a client hashes what is on disk now; when they differ, the running daemon is out of date and wants a restart.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
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
