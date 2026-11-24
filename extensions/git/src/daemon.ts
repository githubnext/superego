// git, daemon half: what changed in a thread's folder, by git, for the Changes pane.
import { execFile } from 'node:child_process'
import { obj, oneOf, opt, str } from '@earendil-works/pi-schema'
import { defineDaemonExtension } from '@superego/daemon'
import { about, BASES, DIFF, type Base, type BaseChoice, type Changes } from './shared.ts'

/**
 * The changes in `cwd` from `asked`, or from the folder's default base when it doesn't offer that one (or none is
 * asked): since the branch left the default branch, on any other branch; uncommitted, on the default branch.
 */
export async function changesIn(cwd: string, asked?: Base): Promise<Changes> {
  const git = (args: string[]) => new Promise<string>((done, fail) => execFile('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, out) => error ? fail(error) : done(out)))
  // For what git may rightly not have (a HEAD before the first commit, an upstream, a merge base): undefined.
  const maybe = (args: string[]) => git(args).then((out) => out.trim() || undefined, () => undefined)
  if (await maybe(['rev-parse', '--is-inside-work-tree']) !== 'true') return { repo: false }
  // Before the first commit, HEAD is nothing: the empty tree stands in for it, and there's no default branch to be off.
  const [head, current, upstream, found] = await Promise.all([
    maybe(['rev-parse', '--verify', '-q', 'HEAD']),
    maybe(['symbolic-ref', '--short', '-q', 'HEAD']),
    maybe(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    defaultBranch(maybe),
  ])
  const start = head ?? (await git(['hash-object', '-t', 'tree', '/dev/null'])).trim()
  const main = head ? found : undefined
  // Each base offered, with the commit it measures from.
  const since = async (base: Base, branch: string | undefined) => {
    const ref = head && branch && await maybe(['merge-base', 'HEAD', branch])
    return ref ? [{ base, branch: branch!, ref }] : []
  }
  const offered: (BaseChoice & { ref: string })[] = [{ base: 'uncommitted', ref: start }, { base: 'staged', ref: start }, ...(await Promise.all([
    main && current !== main.name ? since('branch', main.ref) : [],
    upstream !== main?.ref ? since('upstream', upstream) : [],
  ])).flat()]
  const fallback = offered.find((o) => o.base === 'branch') ?? offered[0]!
  const { base, ref } = offered.find((o) => o.base === asked) ?? fallback
  const [diff, untracked] = await Promise.all([
    git(['diff', ...(base === 'staged' ? ['--cached'] : []), '--no-color', '--no-ext-diff', ref]),
    base === 'staged' ? [] : git(['ls-files', '--others', '--exclude-standard']).then((out) => out.split('\n').filter(Boolean)),
  ])
  return { repo: true, base, ref, diff, untracked, bases: offered.map(({ ref: _ref, ...choice }) => choice) }
}

/**
 * The repository's default branch: the one origin's HEAD names, else main or master; by its name, and the ref to measure
 * from (the local branch, or origin's when there's none here).
 */
async function defaultBranch(maybe: (args: string[]) => Promise<string | undefined>) {
  const origin = await maybe(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])
  for (const name of origin ? [origin.replace(/^origin\//, '')] : ['main', 'master']) {
    if (await maybe(['rev-parse', '--verify', '-q', `refs/heads/${name}`])) return { name, ref: name }
    if (await maybe(['rev-parse', '--verify', '-q', `refs/remotes/origin/${name}`])) return { name, ref: `origin/${name}` }
  }
  return undefined
}

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    superego.method(DIFF, async ({ thread, base }) => changesIn((await superego.threads.get(thread)).cwd, base), {
      params: obj({ thread: str(), base: opt(oneOf(BASES)) }),
    })
  },
})
