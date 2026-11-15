// An "installed" Superego for the evals, outside the repository: what a user of the app has, and nothing more.
//
//   <root>/install-<commit>/
//     Electron.app       the runtime, as Superego.app's own binary would be
//     out/               the app's build (app/out): main, daemon, cli.js, the skill pages (out/skill), author types
//     docs/              docs/writing-extensions.md and docs/examples, which the skill links to
//     bin/superego       the command line, as Settings → Command line installs it
//
// The skill links its docs to the GitHub repository, which is private: an installed user can't read them today. Here
// those links point at the copy in docs/ instead, as if the repository (or a docs site) were public. The report says so.
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export const REPO = join(import.meta.dirname, '..', '..')
const DOCS_URL = 'https://github.com/mikker/superego/blob/main/docs/'

export type Install = { dir: string; bin: string; electron: string; out: string; docs: string; commit: string }

export function commitOf(): string {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()
}

/** Build the app (unless built at this commit) and lay it out in `root`. */
export function install(root: string, { rebuild = false } = {}): Install {
  const commit = commitOf()
  const dir = join(root, `install-${commit}`)
  const result: Install = {
    dir, commit, bin: join(dir, 'bin', 'superego'), electron: join(dir, 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    out: join(dir, 'out'), docs: join(dir, 'docs'),
  }
  if (existsSync(join(dir, 'ready')) && !rebuild) return result
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const appDir = join(REPO, 'app')
  const built = join(appDir, 'out', 'main', 'commit.json')
  const builtAt = existsSync(built) ? (JSON.parse(readFileSync(built, 'utf8')) as { commit: string }).commit : ''
  if (rebuild || !builtAt.startsWith(commit)) {
    console.log('eval: building the app…')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    execFileSync('node', ['scripts/build.ts'], { cwd: appDir, stdio: 'inherit', env })
  }
  cpSync(join(appDir, 'out'), result.out, { recursive: true })

  // Electron, as installed for the app (its dist, downloaded on first use).
  const electronPkg = dirname(createRequire(join(appDir, 'package.json')).resolve('electron/package.json'))
  if (!existsSync(join(electronPkg, 'dist'))) execFileSync('node', ['install.js'], { cwd: electronPkg, stdio: 'inherit' })
  execFileSync('cp', ['-cR', join(electronPkg, 'dist', 'Electron.app'), join(dir, 'Electron.app')])

  // The docs the skill names, and links to them that work here.
  mkdirSync(result.docs, { recursive: true })
  cpSync(join(REPO, 'docs', 'writing-extensions.md'), join(result.docs, 'writing-extensions.md'))
  cpSync(join(REPO, 'docs', 'writing-extensions'), join(result.docs, 'writing-extensions'), { recursive: true })
  cpSync(join(REPO, 'docs', 'examples'), join(result.docs, 'examples'), { recursive: true })
  const skill = join(result.out, 'skill')
  for (const file of readdirSync(skill).filter((f) => f.endsWith('.md'))) {
    const path = join(skill, file)
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll(DOCS_URL, `${result.docs}/`))
  }

  mkdirSync(dirname(result.bin), { recursive: true })
  writeFileSync(result.bin, `#!/bin/sh\n# Superego's command line, as Settings → Command line installs it: the copy inside the app.\nELECTRON_RUN_AS_NODE=1 exec '${result.electron}' '${join(result.out, 'main', 'cli.js')}' "$@"\n`)
  chmodSync(result.bin, 0o755)
  writeFileSync(join(dir, 'ready'), commit)
  return result
}
