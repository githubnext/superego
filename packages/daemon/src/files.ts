// The files of a thread clients may read, find, watch and save: in its folder, or among those it keeps (attachments,
// images it showed). A path that leaves them is refused.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { RpcError } from '@superego/protocol'
import { attachmentsDir } from './attachments.ts'
import { watchFiles } from './watch-files.ts'

/** `path` in `folder`, refusing anything that resolves outside it. */
export function inFolder(folder: string, path: string) {
  const file = resolvePath(folder, path)
  if (file !== folder && !file.startsWith(folder.endsWith('/') ? folder : `${folder}/`)) throw new RpcError('invalid', `${path} is outside ${folder}`)
  return file
}

/** Folders a file search never enters: tools' and dependencies' own. */
const UNSEARCHED = new Set(['node_modules', '.git', '.obsidian', '.trash', '.superego', 'dist', 'out', 'build'])

/**
 * A file in `root` by the name a link gives it, as Obsidian resolves [[links]]: a path if it is one (with or without
 * `.md`), else the file of that name, a note's without its `.md`, the shortest path first. Relative to `root`.
 */
async function findFile(root: string, name: string): Promise<string | undefined> {
  const wanted = name.trim().replace(/^\/+/, '').toLowerCase()
  if (!wanted) return undefined
  const given = name.trim().replace(/^\/+/, '')
  for (const candidate of [given, `${given}.md`]) {
    const file = (() => { try { return inFolder(root, candidate) } catch { return undefined } })()
    if (file && await stat(file).then((s) => s.isFile(), () => false)) return candidate
  }
  const base = wanted.split('/').at(-1)!
  let best: string | undefined
  let seen = 0
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (++seen > 50_000) return
      if (entry.name.startsWith('.') || UNSEARCHED.has(entry.name)) continue
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(dir, entry.name), path)
      else {
        const lower = entry.name.toLowerCase()
        if ((lower === base || lower === `${base}.md`) && (!best || path.length < best.length)) best = path
      }
    }
  }
  await walk(root, '')
  return best
}
/**
 * What a path in a message points at, in a thread's folder `root`: a file (by `findFile`), a folder, and a line when it
 * names one (`src/a.ts:12`, `src/a.ts#L12`). Absolute and `~` paths count when they're in the folder; `outside` when not.
 */
async function locate(root: string, name: string): Promise<{ path: string | null; folder?: boolean; line?: number; outside?: boolean }> {
  let given = name.trim()
  let line: number | undefined
  const at = /^(.+?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(given)
  if (at) { given = at[1]!; line = Number(at[2] ?? at[3]) }
  if (given === '~' || given.startsWith('~/')) given = join(homedir(), given.slice(1))
  if (isAbsolute(given)) {
    const inside = relative(root, given)
    if (inside.startsWith('..') || isAbsolute(inside)) return { path: null, outside: true }
    given = inside
  }
  const folder = await (async () => { try { return (await stat(inFolder(root, given || '.'))).isDirectory() } catch { return false } })()
  if (folder) return { path: given.replace(/\/+$/, ''), folder: true }
  const path = await findFile(root, given)
  return path ? { path, ...(line ? { line } : {}) } : { path: null }
}

/** How large a file clients read whole (`file.read`, `file.watch`) may be. */
const READ_LIMIT = 16 * 1024 * 1024

/** A thread's files, as its methods reach them: `cwdOf` its folder (throwing `not_found` for no such thread). */
export function threadFiles({ dataDir, cwdOf }: { dataDir: string; cwdOf(thread: string): Promise<string> }) {
  /**
   * A file of a thread's that clients may edit: in its folder, or the app's layout (`layout.json` in the data folder,
   * which the desktop app on this computer keeps: Edit layout… opens it beside any thread here).
   */
  function editable(cwd: string, path: string) {
    const layout = join(dataDir, 'layout.json')
    return isAbsolute(path) && resolvePath(path) === layout ? layout : inFolder(cwd, path)
  }
  /** A file of a thread's that clients may read: an editable one, or among the files it keeps. */
  function readable(cwd: string, thread: string, path: string) {
    const kept = isAbsolute(path) && resolvePath(path).startsWith(`${attachmentsDir(dataDir, thread)}/`)
    return kept ? resolvePath(path) : editable(cwd, path)
  }
  return {
    async read(thread: string, path: string, base64 = false) {
      const file = readable(await cwdOf(thread), thread, path)
      const info = await stat(file).catch(() => undefined)
      if (!info?.isFile()) throw new RpcError('not_found', `No file ${path}`)
      if (info.size > READ_LIMIT) throw new RpcError('too_large', `${path} is larger than ${READ_LIMIT / 1024 / 1024} MB`)
      return { path: file, content: await readFile(file, base64 ? 'base64' : 'utf8'), mtimeMs: info.mtimeMs, size: info.size }
    },
    /** Which version of each file there is, without its bytes: a path `read` wouldn't read, or no file, is null. */
    async stat(thread: string, paths: string[]) {
      const cwd = await cwdOf(thread)
      return Promise.all(paths.map(async (path) => {
        const info = await Promise.resolve().then(() => stat(readable(cwd, thread, path))).catch(() => undefined)
        return info?.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : null
      }))
    },
    find: async (thread: string, name: string) => locate(await cwdOf(thread), name),
    async write(thread: string, path: string, content: string) {
      const file = editable(await cwdOf(thread), path)
      await writeFile(file, content)
      return file
    },
    /** An editable file's content now (null: none, or too large to read), then `changed` with each new one until `stop`. */
    async watch(thread: string, path: string, changed: (content: string | null) => void) {
      const file = editable(await cwdOf(thread), path)
      const read = () => stat(file).then((info) => info.isFile() && info.size <= READ_LIMIT ? readFile(file, 'utf8') : null, () => null)
      let last = await read()
      // The folder, not the file: an editor that saves by renaming a new file over it would end a watch on the file.
      let timer: ReturnType<typeof setTimeout> | undefined
      const watcher = watchFiles(dirname(file), [basename(file)], () => {
        clearTimeout(timer)
        timer = setTimeout(async () => {
          const now = await read()
          if (now !== last) { last = now; changed(now) }
        }, 60)
      })
      return { content: last, stop: () => { clearTimeout(timer); watcher.close() } }
    },
  }
}
