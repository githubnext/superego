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

/**
 * A clean worktree, gone at once: moved aside and let go of by git, then deleted in the background. Deleting it in
 * place (`git worktree remove`) takes as long as its files do, many seconds with a node_modules in it.
 */
async function removeWorktree(path: string, root: string) {
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
      async creating(draft) {
        const asked = draft.options.worktrees
        if (!draft.checkout || !(asked === undefined ? draft.profile?.spec.worktree : asked === true)) return
        const name = `${slugOf(draft.title || (draft.prompt ? titleOf(draft.prompt) : ''))}-${randomUUID().slice(0, 6)}`
        const path = join(folder, basename(draft.checkout.root), name)
        const branch = `${superego.app.id}/${name}`
        await mkdir(dirname(path), { recursive: true })
        // In a repository with no commit to start from, it works in the checkout.
        if (!await git(draft.checkout.top, ['worktree', 'add', '-q', '-b', branch, path, 'HEAD']).then(() => true, () => false)) return
        // git gives real paths; so must the folder be, to find where in the checkout it is.
        const below = relative(draft.checkout.top, await realpath(draft.cwd))
        return { cwd: below ? join(path, below) : path, state: { path, branch } }
      },
      // Gone with the thread when nothing in it is uncommitted; its branch stays, to come back to.
      async archived(thread) {
        const tree = await state.get(thread.id)
        if (!tree || tree.removed) return
        const exists = await stat(tree.path).then(() => true, () => false)
        const clean = exists && (await git(tree.path, ['status', '--porcelain']).catch(() => 'unknown')) === ''
        if (!exists || (clean && await removeWorktree(tree.path, thread.session.root))) await state.set(thread.id, { ...tree, removed: true })
      },
      // Back, on the branch it left.
      async unarchiving(thread) {
        const tree = await state.get(thread.id)
        if (!tree?.removed) return
        const root = thread.session.root
        await mkdir(dirname(tree.path), { recursive: true })
        // Pruned first, in case a process ended before letting go of it (see removeWorktree).
        await git(root, ['worktree', 'prune']).catch(() => {})
        await git(root, ['worktree', 'add', '-q', tree.path, tree.branch])
          .catch((error: Error) => { throw new RpcError('invalid', `Couldn't restore its worktree: ${error.message}`) })
        await state.set(thread.id, { path: tree.path, branch: tree.branch })
      },
    })
    void sweepRemoved(folder)
  },
})
