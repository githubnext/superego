// Where a project's own files may come from: its `AGENTS.md`, its profiles (`.superego/profiles`), a folder's Claude
// Code settings. Only from the project a thread works in, its folder up to the repository's top (the nearest folder
// with a `.git`; the folder alone when it's in none), and only from what no one but the user could have put there:
// each folder on the way, and each file, is the user's or root's and writable by no one else. On a shared machine
// another user can write /tmp, /var/tmp or a group's folder, and a thread started under one mustn't take its
// instructions or its code from there. The user's own (`~/.agents`, `~/.superego/profiles`) aren't looked for here.
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'

let ownGroup: number | null | undefined

/**
 * The user's own group, when it's theirs alone: the one named after them that most Linux systems make for each user
 * (where a umask of 002 leaves their folders group-writable). Null when their group is shared (macOS's `staff`).
 */
export function privateGroup(): number | null {
  if (ownGroup !== undefined) return ownGroup
  const gid = process.getgid?.()
  let name: string | undefined
  try { name = execFileSync('id', ['-gn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch (error) {
    // Without `id`, the group can't be told apart from a shared one: group-writable counts as others' (the stricter way).
    console.error('Project files: telling the user\'s group by `id -gn`:', (error as Error).message)
  }
  return ownGroup = gid !== undefined && name !== undefined && name === userInfo().username ? gid : null
}

/**
 * Whether only the user could have put what's at `path` there: it's theirs or root's, and no one else can write it
 * (not world-writable; group-writable only by `group`, the user's private one). Symlinks followed. False when it isn't
 * there. Without owners to check (Windows), whether it's there.
 */
export function trusted(path: string, group: number | null = privateGroup()): boolean {
  const uid = process.getuid?.()
  let stat
  try { stat = statSync(path) } catch { return false }
  if (uid === undefined) return true
  if (stat.uid !== uid && stat.uid !== 0) return false
  if (stat.mode & 0o002) return false
  return !(stat.mode & 0o020) || stat.gid === group
}

/**
 * The folders a thread in `cwd` takes a project's files from, nearest first: `cwd` up to the repository's top, through
 * `trusted` folders only. Just `cwd` when no repository's top is in reach that way, and none when `cwd` isn't trusted.
 */
export function projectFolders(cwd: string, group: number | null = privateGroup()): string[] {
  const chain: string[] = []
  for (let dir = resolve(cwd); trusted(dir, group); dir = dirname(dir)) {
    chain.push(dir)
    if (existsSync(join(dir, '.git'))) return chain
    if (dirname(dir) === dir) break
  }
  return chain.slice(0, 1)
}
