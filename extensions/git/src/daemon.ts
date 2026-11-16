// git, daemon half: what changed in a thread's folder, by git, for the Changes pane.
import { execFile } from 'node:child_process'
import { obj, str } from '@earendil-works/pi-schema'
import { defineDaemonExtension } from '@superego/daemon'
import { about, DIFF, type Changes } from './shared.ts'

/** The changes in `cwd`: against HEAD (or the index, before a first commit), and the files not tracked yet. */
export async function changesIn(cwd: string): Promise<Changes> {
  const git = (args: string[]) => new Promise<string>((done, fail) => execFile('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, out) => error ? fail(error) : done(out)))
  const repo = await git(['rev-parse', '--is-inside-work-tree']).then(() => true, () => false)
  if (!repo) return { diff: '', untracked: [], repo: false }
  const diff = await git(['diff', 'HEAD', '--no-color', '--no-ext-diff']).catch(() => git(['diff', '--no-color']))
  const untracked = (await git(['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean)
  return { diff, untracked, repo: true }
}

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    superego.method(DIFF, async ({ thread }) => changesIn((await superego.threads.get(thread)).cwd), { params: obj({ thread: str() }) })
  },
})
