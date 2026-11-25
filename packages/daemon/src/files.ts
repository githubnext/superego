// The files of a thread clients may read, find, watch and save: any on its machine, by a path relative to its folder,
// absolute or from home (`~/…`). No fence: the thread's agent reads and writes whatever the daemon's user can, and so
// does anyone who can drive it (a window, a paired browser, the command line), so one here would keep out only them.
// What an artifact's page asks for is another matter (artifacts.ts).
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { RpcError } from '@superego/protocol'
import { readArtifact } from './artifacts.ts'
import { watchFiles } from './watch-files.ts'

/** Where `path` is for a thread in `folder`: relative to the folder, absolute, or from home (`~`, `~/…`). */
export function fileIn(folder: string, path: string) {
  return resolvePath(folder, path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path)
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
    const file = fileIn(root, candidate)
    if (await stat(file).then((s) => s.isFile(), () => false)) return candidate
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
 * Where a path a message names points: a file or folder, with the line it names. In the thread's folder, relative to
 * it; elsewhere, absolute.
 */
export type Located = { path: string; folder?: boolean; line?: number }

/**
 * What a path in a message points at, for a thread in the folder `root`: a file, a folder, and a line when it names one
 * (`src/a.ts:12`, `src/a.ts#L12`). Absolute and `~` paths are taken as they are. A link is looked up as Obsidian
 * resolves [[links]] (`findFile`: by name too, in the folder); `exact`, only the path as it's given, as code in a
 * message is (`file.locate`).
 */
async function locate(root: string, name: string, exact = false): Promise<{ path: string | null; folder?: boolean; line?: number }> {
  let given = name.trim()
  let line: number | undefined
  const at = /^(.+?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(given)
  if (at) { given = at[1]!; line = Number(at[2] ?? at[3]) }
  const file = fileIn(root, given || '.')
  const inside = relative(root, file)
  const elsewhere = inside === '..' || inside.startsWith('../') || isAbsolute(inside)
  // Relative to the folder when it's in it, so a link to a file there opens the same pane as one by its relative path.
  const shown = elsewhere ? file : inside
  const info = await stat(file).catch(() => undefined)
  if (info?.isDirectory()) return { path: shown, folder: true }
  const path = info?.isFile() ? shown : exact || elsewhere ? undefined : await findFile(root, inside)
  return path ? { path, ...(line ? { line } : {}) } : { path: null }
}

/** Why a file there couldn't be read, in words, or the error itself when it's none of the usual. */
function unreadable(path: string, error: NodeJS.ErrnoException) {
  if (error.code === 'EACCES' || error.code === 'EPERM') return new RpcError('forbidden', `No permission to read ${path}`)
  return error
}

/** How large a file clients read whole (`file.read`, `file.watch`) may be. */
const READ_LIMIT = 16 * 1024 * 1024

/** A thread's files, as its methods reach them: `cwdOf` its folder (throwing `not_found` for no such thread). */
export function threadFiles({ cwdOf }: { cwdOf(thread: string): Promise<string> }) {
  const fileOf = async (thread: string, path: string) => fileIn(await cwdOf(thread), path)
  return {
    /** Where a path of a thread's is on its machine. */
    resolve: fileOf,
    /** A file whole: as text, or as base64 (any file, an image or an artifact's). Why not, when it can't be read. */
    async read(thread: string, path: string, base64 = false) {
      const file = await fileOf(thread, path)
      const info = await stat(file).catch((error: NodeJS.ErrnoException) => {
        throw error.code === 'ENOENT' || error.code === 'ENOTDIR' ? new RpcError('not_found', `${path} isn't there`) : unreadable(path, error)
      })
      if (info.isDirectory()) throw new RpcError('invalid', `${path} is a folder, not a file`)
      if (!info.isFile()) throw new RpcError('invalid', `${path} isn't a file`)
      if (info.size > READ_LIMIT) throw new RpcError('too_large', `${path} is larger than ${READ_LIMIT / 1024 / 1024} MB`)
      const bytes = await readFile(file).catch((error: NodeJS.ErrnoException) => { throw unreadable(path, error) })
      // As text, a file with a NUL in its start is binary: shown, it would be noise, and saved back, broken.
      if (!base64 && bytes.subarray(0, 8192).includes(0)) throw new RpcError('invalid', `${path} is a binary file, not text`)
      return { path: file, content: bytes.toString(base64 ? 'base64' : 'utf8'), mtimeMs: info.mtimeMs, size: info.size }
    },
    /** A file an artifact asks for: only one really in the thread's folder (see artifacts.ts). */
    artifact: async (thread: string, path: string) => readArtifact(await cwdOf(thread), path),
    /** Which version of each file there is, without its bytes: no file (or one that can't be looked at) is null. */
    async stat(thread: string, paths: string[]) {
      const cwd = await cwdOf(thread)
      return Promise.all(paths.map(async (path) => {
        const info = await stat(fileIn(cwd, path)).catch(() => undefined)
        return info?.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : null
      }))
    },
    find: async (thread: string, name: string) => locate(await cwdOf(thread), name),
    /** The file or folder each path names, exactly as given (no search by name); null for none. */
    async locate(thread: string, names: string[]): Promise<(Located | null)[]> {
      const cwd = await cwdOf(thread)
      return Promise.all(names.map(async (name) => {
        const { path, folder, line } = await locate(cwd, name, true)
        return path === null ? null : { path, ...(folder ? { folder } : {}), ...(line ? { line } : {}) }
      }))
    },
    async write(thread: string, path: string, content: string) {
      const file = await fileOf(thread, path)
      await writeFile(file, content).catch((error: NodeJS.ErrnoException) => {
        throw error.code === 'ENOENT' ? new RpcError('not_found', `${dirname(path)} isn't there`)
          : error.code === 'EACCES' || error.code === 'EPERM' ? new RpcError('forbidden', `No permission to write ${path}`)
            : error.code === 'EISDIR' ? new RpcError('invalid', `${path} is a folder, not a file`) : error
      })
      return file
    },
    /**
     * A new, empty file (or a `folder`) at `path`, with the folders on the way made as needed. Never over anything:
     * something already there is refused, and so is a file in the way of the folders.
     */
    async create(thread: string, path: string, folder = false) {
      const file = await fileOf(thread, path)
      const forbidden = (error: NodeJS.ErrnoException) => error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EROFS'
      // A file where a folder on the way should be: mkdir says EEXIST (or ENOTDIR, past it).
      await mkdir(dirname(file), { recursive: true }).catch((error: NodeJS.ErrnoException) => {
        throw error.code === 'EEXIST' || error.code === 'ENOTDIR' ? new RpcError('invalid', `A file is in the way of ${path}`)
          : forbidden(error) ? new RpcError('forbidden', `No permission to create ${path}`) : error
      })
      await (folder ? mkdir(file) : writeFile(file, '', { flag: 'wx' })).catch((error: NodeJS.ErrnoException) => {
        throw error.code === 'EEXIST' ? new RpcError('exists', `${path} is already there`)
          : forbidden(error) ? new RpcError('forbidden', `No permission to create ${path}`) : error
      })
      return file
    },
    /** A file's content now (null: none, or too large to read), then `changed` with each new one until `stop`. */
    async watch(thread: string, path: string, changed: (content: string | null) => void) {
      const file = await fileOf(thread, path)
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
