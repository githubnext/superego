// Types for a profile's author, outside this repo. The declarations of 'superego', 'superego/ui', React and the rest are
// built from the SDK's sources (@superego/sdk/types.ts) into the app (out/types), or into the checkout's cache. Each
// computer keeps one copy, `<dataDir>/types`, refreshed whenever the app (or the command line) that starts has others;
// a profile's folder links its node_modules there and has a tsconfig.json with nothing of this computer in it, so a
// project's profile can be committed as it is.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withLock } from './lock.ts'

/** The types folder's stamp: a hash of its declarations. */
const stampOf = (dir: string): string | undefined => {
  try { return (JSON.parse(readFileSync(join(dir, 'stamp.json'), 'utf8')) as { hash: string }).hash } catch { return undefined }
}

/** A folder copied file by file: in a packaged app, `from` is inside its app.asar, which only Electron's patched fs reads. */
function copy(from: string, to: string) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const path = join(from, entry)
    if (statSync(path).isDirectory()) copy(path, join(to, entry))
    else writeFileSync(join(to, entry), readFileSync(path))
  }
}

/**
 * `<dataDir>/types`, made the same as `from` (built types) unless it is already. Returns its path. One process copies
 * at a time (the app as it starts, a command line, another): the others wait, then find it done.
 */
export async function installTypes(from: string, dataDir: string): Promise<string> {
  const dir = join(dataDir, 'types')
  const want = stampOf(from)
  if (!want) throw new Error(`No types in ${from}`)
  if (stampOf(dir) === want) return dir
  return withLock(`${dir}.lock`, () => {
    if (stampOf(dir) === want) return dir
    // Beside it, then swapped in: an editor reading it never sees half a copy.
    const temp = `${dir}.${process.pid}.tmp`
    rmSync(temp, { recursive: true, force: true })
    copy(from, temp)
    const old = `${dir}.${process.pid}.old`
    if (existsSync(dir)) renameSync(dir, old)
    renameSync(temp, dir)
    rmSync(old, { recursive: true, force: true })
    return dir
  })
}

/** A profile's tsconfig.json: its files checked as the daemon and the window run them, against node_modules' types. */
export const PROFILE_TSCONFIG = `{
  // Types for this profile's files. 'superego', 'superego/ui', React and Node come from node_modules: a link to this
  // computer's Superego types, made by \`superego profile types\` (again after a fresh clone).
  "compilerOptions": {
    "target": "es2023",
    "module": "preserve",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "lib": ["es2023", "dom", "dom.iterable"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "exclude": ["node_modules"]
}
`

export type ProfileTypes = {
  /** Files written or replaced. */
  written: string[]
  /** What's left as it was, and why. */
  notes: string[]
}

/** Link the profile's node_modules to `typesDir`'s (again, if it's linked elsewhere); a folder of its own stays. */
export function linkProfileTypes(dir: string, typesDir: string): { written?: string; note?: string } {
  const link = join(dir, 'node_modules')
  const target = join(typesDir, 'node_modules')
  let stat
  try { stat = lstatSync(link) } catch {}
  if (stat?.isSymbolicLink() && readlinkSync(link) !== target) { rmSync(link); stat = undefined }
  if (!stat) { symlinkSync(target, link, 'dir'); return { written: link } }
  if (!stat.isSymbolicLink()) return { note: `${link} is a folder of its own, so it's left as it is: its types come from it, not Superego's` }
  return {}
}

/**
 * Give the profile at `dir` types: link its node_modules to `typesDir`'s, write its tsconfig.json (or replace one an
 * older Superego wrote, which named this computer's checkout), and keep node_modules out of git.
 */
export function setUpProfileTypes(dir: string, typesDir: string): ProfileTypes {
  const written: string[] = []
  const notes: string[] = []
  mkdirSync(dir, { recursive: true })

  const linked = linkProfileTypes(dir, typesDir)
  if (linked.written) written.push(linked.written)
  if (linked.note) notes.push(linked.note)

  const tsconfig = join(dir, 'tsconfig.json')
  const had = existsSync(tsconfig) ? readFileSync(tsconfig, 'utf8') : undefined
  // One `superego extension new` wrote before: 'superego' mapped to this computer's checkout.
  const older = had !== undefined && /"superego": \[\s*"\//.test(had)
  if (had === undefined || older) { writeFileSync(tsconfig, PROFILE_TSCONFIG); written.push(tsconfig) }
  else if (had !== PROFILE_TSCONFIG) notes.push(`${tsconfig} is there already, so it's left as it is (what Superego would write: \`superego --skill profiles\`)`)

  const ignore = join(dir, '.gitignore')
  const ignored = existsSync(ignore) ? readFileSync(ignore, 'utf8') : ''
  if (!/^\/?node_modules\/?$/m.test(ignored)) {
    writeFileSync(ignore, `${ignored}${ignored && !ignored.endsWith('\n') ? '\n' : ''}node_modules\n`)
    written.push(ignore)
  }
  return { written, notes }
}
