// files, daemon half: the files in a thread's folder (or one a thread is about to start in), for the file tree, quick
// open and mentions. In a git repository, git's own list (tracked, and new files not ignored), so .gitignore holds;
// elsewhere a walk that skips what's never wanted. And one folder as it is on disk, ignored files too, for a folder
// pane: one asked for by its path is shown whole, in the thread's folder or anywhere else on its machine.
import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { obj, opt, str } from '@earendil-works/pi-schema'
import { defineDaemonExtension } from '@superego/daemon'
import { RpcError } from '@superego/protocol'
import { about, ENTRIES, LIST, type FileList, type FolderEntries } from './shared.ts'

/** Past this many, the list stops: a folder that big (a home directory) isn't browsed file by file. */
export const LIMIT = 20_000
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', '.Trash', 'Library', '.cache'])

function gitFiles(dir: string): Promise<string[] | undefined> {
  return new Promise((done) => execFile('git', ['-C', dir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { maxBuffer: 64 * 1024 * 1024 },
    (error, out) => done(error ? undefined : String(out).split('\0').filter(Boolean))))
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (files.length >= LIMIT) return
      if (SKIP.has(entry.name) || (entry.isDirectory() && entry.name.startsWith('.'))) continue
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(join(dir, entry.name), path)
      else if (entry.isFile()) files.push(path)
    }
  }
  await visit(root, '')
  return files
}

/** The files under `dir`, relative to it, sorted; `truncated` when there were more than LIMIT. */
export async function listFiles(dir: string): Promise<FileList> {
  const all = (await gitFiles(dir)) ?? await walk(dir)
  const truncated = all.length >= LIMIT
  return { files: all.slice(0, LIMIT).sort((a, b) => a.localeCompare(b)), truncated }
}

/** What a folder pane leaves out: git's own folder, and the Finder's notes. */
const UNLISTED = new Set(['.git', '.DS_Store'])

/**
 * What's in the folder `path` (relative to `root`, `''` for root itself; absolute; or `~/…`), as it is on disk: folders
 * first, then files, each by name. One that isn't a readable folder throws, saying why.
 */
export async function folderEntries(root: string, path: string): Promise<FolderEntries> {
  const dir = resolve(root, home(path))
  const shown = path || root
  let found
  try {
    found = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new RpcError('not_found', `${shown} isn't there`)
    if (code === 'ENOTDIR') throw new RpcError('invalid', `${shown} is a file, not a folder`)
    if (code === 'EACCES' || code === 'EPERM') throw new RpcError('forbidden', `No permission to read ${shown}`)
    throw error
  }
  const entries = await Promise.all(found.filter((entry) => !UNLISTED.has(entry.name)).map(async (entry) => ({
    name: entry.name,
    // A link is what it points at; one to nothing, a file.
    folder: entry.isDirectory() || (entry.isSymbolicLink() && await stat(join(dir, entry.name)).then((s) => s.isDirectory(), () => false)),
  })))
  return { entries: entries.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name)) }
}

/** `path` with a `~` at its start as the home folder. */
const home = (path: string) => path.replace(/^~(?=\/|$)/, homedir())

/** A folder as typed for a thread yet to start (`~/dev/x`), as a path; asked for none, refused. */
function folder(cwd: string | undefined): string {
  if (!cwd?.trim()) throw new Error('files.list needs a thread or a folder (cwd)')
  return resolve(home(cwd.trim()))
}

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    // A short cache: the tree and quick open ask often, and a folder changes slowly.
    const cache = new Map<string, { at: number; list: Promise<FileList> }>()
    superego.method(LIST, async ({ thread, cwd: asked }) => {
      const cwd = thread ? (await superego.threads.get(thread)).cwd : folder(asked)
      const hit = cache.get(cwd)
      if (hit && Date.now() - hit.at < 3_000) return hit.list
      const list = listFiles(cwd)
      cache.set(cwd, { at: Date.now(), list })
      return list
    }, { params: obj({ thread: opt(str()), cwd: opt(str()) }) })
    superego.method(ENTRIES, async ({ thread, path }) => folderEntries((await superego.threads.get(thread)).cwd, path ?? ''),
      { params: obj({ thread: str(), path: opt(str()) }) })
  },
})
