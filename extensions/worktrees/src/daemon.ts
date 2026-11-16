// worktrees, daemon half: a thread in a git repository can work in a worktree of its own, on a branch of its own, when
// it's started with `worktree: true` (`options.worktrees`) or its profile says so. Archiving removes the worktree when
// nothing in it is uncommitted, and its branch too once that's merged into the main branch (its tip kept with the
// thread); unarchiving puts both back. Built on thread hooks, state with each thread, and a fact clients see
// (`facts.worktrees`).
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, realpath, rename, stat } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { defineDaemonExtension, slugOf, titleOf } from '@superego/daemon'
import { RpcError } from '@superego/protocol'
import { about, type Worktree } from './shared.ts'

/** What a worktree being deleted is renamed with, between its name and a random suffix (see removeWorktree). */
const REMOVING = '.removing-'

/**
 * Deleting a folder, as plain Node does. The daemon runs in Electron, whose `fs` takes an `.asar` file for a folder: it
 * reads into it rather than deleting it, so a worktree with Electron in its node_modules (`default_app.asar`) was never
 * deleted (ENOTEMPTY). Electron's `original-fs` is `fs` without that; in plain Node there's none, and `fs` is plain.
 */
const { rm } = ((process.getBuiltinModule('original-fs') ?? process.getBuiltinModule('node:fs')) as typeof import('node:fs')).promises

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
  void sweepRemoved(dirname(path))
  return true
}

/** The folders being deleted now, so a sweep while one is doesn't start on it again. */
const deleting = new Set<string>()

/**
 * The worktrees moved aside in a repository's folder (see removeWorktree), deleted: the one just moved, and any an
 * earlier try didn't finish (the daemon ended mid-way, or it failed), so each removal tries those again too. A failure
 * is logged, and left for the next.
 */
async function sweepRemoved(folder: string) {
  for (const name of await readdir(folder).catch(() => [])) {
    const path = join(folder, name)
    if (!name.startsWith('.') || !name.includes(REMOVING) || deleting.has(path)) continue
    deleting.add(path)
    await rm(path, { recursive: true, force: true, maxRetries: 3 })
      .catch((error: unknown) => console.error(`worktrees: deleting ${path} failed:`, error))
      .finally(() => deleting.delete(path))
  }
}

/** Every repository's leftovers (see sweepRemoved), as the daemon starts. */
async function sweepAll(root: string) {
  for (const repo of await readdir(root).catch(() => [])) await sweepRemoved(join(root, repo))
}

/** A branch's tip, or undefined when there's no such branch. */
const tipOf = (root: string, branch: string) => git(root, ['rev-parse', '-q', '--verify', `refs/heads/${branch}^{commit}`]).catch(() => undefined)

/**
 * Whether `commit` is merged: reachable from the repository's main branch (the branch its main checkout is on), or
 * from that branch's upstream. Not when the main checkout is on no branch.
 */
async function merged(root: string, commit: string) {
  const main = await git(root, ['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => '')
  if (!main) return false
  const upstream = await git(root, ['rev-parse', '-q', '--verify', `${main}@{upstream}`]).catch(() => '')
  for (const into of [main, upstream].filter(Boolean)) {
    if (await git(root, ['merge-base', '--is-ancestor', commit, into]).then(() => true, () => false)) return true
  }
  return false
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
      async starting(draft) {
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
      // Gone with the thread when nothing in it is uncommitted; its branch too once merged, its tip kept to come back to.
      async archived(thread) {
        const tree = await state.get(thread.id)
        if (!tree || tree.removed) return
        const exists = await stat(tree.path).then(() => true, () => false)
        const clean = exists && (await git(tree.path, ['status', '--porcelain']).catch(() => 'unknown')) === ''
        // Said, in a line, in what archiving answers (thread_archive tells the agent).
        if (exists && !(clean && await removeWorktree(tree.path, tree.root))) {
          return { note: clean ? `Kept the worktree ${tree.path}: it couldn't be removed.` : `Kept the worktree ${tree.path}: it has uncommitted changes.` }
        }
        // Deleted by hand, it's still git's until pruned, and so is its branch.
        if (!exists) await git(tree.root, ['worktree', 'prune']).catch(() => {})
        const branch = await settleBranch(thread.id, { ...tree, removed: true })
        return { note: `${exists ? `Removed the worktree ${tree.path}` : `Its worktree ${tree.path} was already gone`}; ${branch}.` }
      },
      // Back, on the branch it left: made again at the tip it had, if archiving deleted it.
      async unarchiving(thread) {
        const tree = await state.get(thread.id)
        if (!tree?.removed) return
        // Its main checkout gone, there's nothing to put it back from: it comes back without.
        const { root } = tree
        if (!await git(root, ['rev-parse', '--git-dir']).then(() => true, () => false)) return
        await mkdir(dirname(tree.path), { recursive: true })
        // Pruned first, in case a process ended before letting go of it (see removeWorktree).
        await git(root, ['worktree', 'prune']).catch(() => {})
        const restore = (error: Error) => { throw new RpcError('invalid', `Couldn't restore its worktree: ${error.message}`) }
        if (tree.commit && !await tipOf(root, tree.branch)) await git(root, ['branch', tree.branch, tree.commit]).catch(restore)
        await git(root, ['worktree', 'add', '-q', tree.path, tree.branch]).catch(restore)
        await state.set(thread.id, { path: tree.path, branch: tree.branch, root })
      },
    })

    /**
     * The branch of a thread whose worktree archiving removed: its tip kept with the thread first, then deleted if
     * merged, kept if not (someone's unfinished work). What became of it, as archiving's note says it.
     */
    async function settleBranch(id: string, tree: Worktree) {
      const tip = await tipOf(tree.root, tree.branch)
      const next = tip ? { ...tree, commit: tip } : tree
      // Written only when changed: the sweep comes here for every archived thread with its branch, each start.
      if (JSON.stringify(next) !== JSON.stringify(await state.get(id))) await state.set(id, next)
      if (!tip) return `branch ${tree.branch} already gone`
      if (!await merged(tree.root, tip)) return `branch ${tree.branch} kept: not merged`
      // git refuses one checked out in another worktree.
      const gone = await git(tree.root, ['branch', '-D', tree.branch]).then(() => true, (error: Error) => {
        console.error(`worktrees: deleting branch ${tree.branch} failed:`, error.message)
        return false
      })
      return gone ? `branch ${tree.branch} deleted (merged)` : `branch ${tree.branch} kept: it couldn't be deleted`
    }

    /**
     * As the daemon starts: what archiving left half done, finished. Leftover folders deleted, and the merged branches
     * of archived threads whose worktree is removed deleted (archived before branches were, or the daemon ended between).
     */
    async function sweep() {
      await sweepAll(folder)
      for (const thread of await superego.threads.list({ archived: true })) {
        const tree = await state.get(thread.id)
        if (!tree?.removed || !await git(tree.root, ['rev-parse', '--git-dir']).then(() => true, () => false)) continue
        if (await tipOf(tree.root, tree.branch)) await settleBranch(thread.id, tree)
      }
    }
    void sweep().catch((error: unknown) => console.error('worktrees: sweeping up after archived threads failed:', error))
  },
})
