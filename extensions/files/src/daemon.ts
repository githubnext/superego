// files, daemon half: the files in a thread's folder, for the file tree and quick open. In a git repository, git's
// own list (tracked, and new files not ignored), so .gitignore holds; elsewhere a walk that skips what's never wanted.
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { obj, str } from '@earendil-works/pi-schema'
import { defineDaemonExtension } from '@superego/daemon'
import { about, FOLDER, LIST, type FileList } from './shared.ts'

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

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    // A short cache: the tree and quick open ask often, and a folder changes slowly.
    const cache = new Map<string, { at: number; list: Promise<FileList> }>()
    superego.method(LIST, async ({ thread }) => {
      const { cwd } = await superego.threads.get(thread)
      const hit = cache.get(cwd)
      if (hit && Date.now() - hit.at < 3_000) return hit.list
      const list = listFiles(cwd)
      cache.set(cwd, { at: Date.now(), list })
      return list
    }, { params: obj({ thread: str() }) })
    superego.pane(FOLDER, '{ path }: a folder in the working folder ("" for the folder itself), as a tree to open its files from')
  },
})
