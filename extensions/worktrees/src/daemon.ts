// worktrees, daemon half: a thread in a git repository can work in a worktree of its own, on a branch of its own, when
// it's started with `worktree: true` (`options.worktrees`) or its profile says so. Archiving removes the worktree when
// nothing in it is uncommitted (the branch stays), and unarchiving puts it back. Built on thread hooks, state with
// each thread, and a fact clients see (`ext.worktrees`). Its state reads what the core kept before (`worktree`).
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { defineDaemonExtension, slugOf, titleOf } from '@superego/daemon'
import { RpcError } from '@superego/protocol'
import { about, type Worktree } from './shared.ts'

/** What a worktree being deleted is renamed with, between its name and a random suffix (see removeWorktree). */
const REMOVING = '.removing-'

/** git in `cwd`: its output, trimmed; its own message when it fails. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => execFile('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, out, err) =>
    error ? fail(new Error(String(err).trim() || error.message)) : done(String(out).trim())))
}

/** A command's output, or '' when it fails or takes longer than `ms`. */
function run(command: string, args: string[], ms = 10_000): Promise<string> {
  return new Promise((done) => execFile(command, args, { timeout: ms, maxBuffer: 16 * 1024 * 1024 }, (_error, out) => done(String(out ?? ''))))
}

/**
 * The processes still running from a worktree about to go (a dev server, a test daemon, an app started there), stopped
 * first: once its folder is gone they'd run on for good, parented to launchd. Those whose command names a file in it,
 * and those working in it (lsof, scoped to the folder). Never this daemon or its process group: an agent's own shell
 * there is the daemon's. Asked to end (SIGTERM), then made to after a few seconds (SIGKILL).
 */
async function stopProcessesIn(path: string) {
  if (process.platform === 'win32') return
  const table = (await run('ps', ['-A', '-o', 'pid=,pgid=,command='])).split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => Boolean(m))
    .map(([, pid, pgid, command]) => ({ pid: Number(pid), pgid: Number(pgid), command: command! }))
  const own = table.find((p) => p.pid === process.pid)?.pgid
  // By the path it's known by, and the real one (a temporary folder on macOS is under /private).
  const real = await realpath(path).catch(() => path)
  const pids = new Set(table.filter((p) => p.command.includes(`${path}/`) || p.command.includes(`${real}/`)).map((p) => p.pid))
  for (const line of (await run('lsof', ['-a', '-d', 'cwd', '+D', path, '-Fp'])).split('\n')) {
    if (line.startsWith('p')) pids.add(Number(line.slice(1)))
  }
  const ours = (pid: number) => pid === process.pid || (own !== undefined && table.find((p) => p.pid === pid)?.pgid === own)
  const doomed = [...pids].filter((pid) => pid > 1 && !ours(pid))
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  const signal = (pid: number, name: NodeJS.Signals) => { try { process.kill(pid, name) } catch {} }
  for (const pid of doomed) signal(pid, 'SIGTERM')
  for (let waited = 0; waited < 5000 && doomed.some(alive); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100))
  for (const pid of doomed.filter(alive)) signal(pid, 'SIGKILL')
}

/**
 * A clean worktree, gone at once: moved aside and let go of by git, then deleted in the background. Deleting it in
 * place (`git worktree remove`) takes as long as its files do, many seconds with a node_modules in it.
 */
async function removeWorktree(path: string, root: string) {
  await stopProcessesIn(path)
  const aside = join(dirname(path), `.${basename(path)}${REMOVING}${randomUUID().slice(0, 8)}`)
  if (!await rename(path, aside).then(() => true, () => false)) return false
  await git(root, ['worktree', 'prune']).catch(() => {})
  void rm(aside, { recursive: true, force: true }).catch(() => {})
  return true
}

/** The worktrees a previous process moved aside and didn't get to delete (see removeWorktree), deleted now. */
async function sweepRemoved(root: string) {
  for (const repo of await readdir(root).catch(() => [])) {
    for (const name of await readdir(join(root, repo)).catch(() => [])) {
      if (name.startsWith('.') && name.includes(REMOVING)) await rm(join(root, repo, name), { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** Worktrees for threads: kept in `<dataDir>/worktrees/<repo>/<slug>`, on branch `<appId>/<slug>`. */
export default defineDaemonExtension({
  ...about,
  setup(superego) {
    const folder = join(superego.dataDir, 'worktrees')
    const state = superego.state<Worktree>()
    superego.facts<Worktree>(({ state }) => state)
    superego.thread({
      // Asked for by the thread, or its profile (both in `options`).
      async creating(draft) {
        if (!draft.checkout || draft.options.worktrees !== true) return
        const name = `${slugOf(draft.title || (draft.prompt ? titleOf(draft.prompt) : ''))}-${randomUUID().slice(0, 6)}`
        const path = join(folder, basename(draft.checkout.root), name)
        const branch = `${superego.app.id}/${name}`
        await mkdir(dirname(path), { recursive: true })
        // In a repository with no commit to start from, it works in the checkout.
        if (!await git(draft.checkout.top, ['worktree', 'add', '-q', '-b', branch, path, 'HEAD']).then(() => true, () => false)) return
        // git gives real paths; so must the folder be, to find where in the checkout it is.
        const below = relative(draft.checkout.top, await realpath(draft.cwd))
        return { cwd: below ? join(path, below) : path, state: { path, branch, root: draft.checkout.root } }
      },
      // Not made after all (a later hook refused): the worktree and its branch go, as if never added.
      async abandoned(draft, made) {
        const tree = made as Worktree | undefined
        if (!tree || !draft.checkout) return
        await git(draft.checkout.top, ['worktree', 'remove', '--force', tree.path]).catch(() => rm(tree.path, { recursive: true, force: true }))
        await git(draft.checkout.top, ['worktree', 'prune']).catch(() => {})
        await git(draft.checkout.top, ['branch', '-D', tree.branch]).catch(() => {})
      },
      // Gone with the thread when nothing in it is uncommitted; its branch stays, to come back to.
      async archived(thread) {
        const tree = await state.get(thread.id)
        if (!tree || tree.removed) return
        const exists = await stat(tree.path).then(() => true, () => false)
        const clean = exists && (await git(tree.path, ['status', '--porcelain']).catch(() => 'unknown')) === ''
        // Said, in a line, in what archiving answers (thread_archive tells the agent).
        if (exists && !(clean && await removeWorktree(tree.path, tree.root ?? thread.session.root))) {
          return { note: clean ? `Kept the worktree ${tree.path}: it couldn't be removed.` : `Kept the worktree ${tree.path}: it has uncommitted changes.` }
        }
        await state.set(thread.id, { ...tree, removed: true })
        return { note: `Removed the worktree ${tree.path}; branch ${tree.branch} kept.` }
      },
      // Back, on the branch it left.
      async unarchiving(thread) {
        const tree = await state.get(thread.id)
        if (!tree?.removed) return
        // Its main checkout: kept with it, else (a thread from before) its session's, when that is a repository. When
        // it isn't, there's nothing to put it back from: it comes back without, as it always did.
        const root = tree.root ?? thread.session.root
        if (!await git(root, ['rev-parse', '--git-dir']).then(() => true, () => false)) return
        await mkdir(dirname(tree.path), { recursive: true })
        // Pruned first, in case a process ended before letting go of it (see removeWorktree).
        await git(root, ['worktree', 'prune']).catch(() => {})
        await git(root, ['worktree', 'add', '-q', tree.path, tree.branch])
          .catch((error: Error) => { throw new RpcError('invalid', `Couldn't restore its worktree: ${error.message}`) })
        await state.set(thread.id, { path: tree.path, branch: tree.branch, ...(tree.root ? { root: tree.root } : {}) })
      },
    })
    void sweepRemoved(folder)
  },
})
