// `electron-vite build`, unless out/ already holds the build of these sources: for the tests that run the built app
// (smoke, showcase, look), which would otherwise build it every time. The build's inputs (the sources it bundles, the
// configs, the lockfile and what is installed) are hashed into out/.build-stamp, along with what the build wrote; a
// change to either (an edit, a rebase, `pnpm install`, `pnpm dev` writing its own out/main) builds again.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const app = new URL('..', import.meta.url).pathname
const root = join(app, '..')
const out = join(app, 'out')
const STAMP = join(out, '.build-stamp')

const sources = git('ls-files', '-z', '--cached', '--others', '--exclude-standard', '--',
  'app/src', 'app/electron.vite.config.ts', 'app/superego.config.ts', 'app/package.json', 'packages', 'extensions',
  ':!packages/*/test', ':!extensions/*/test', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json')
  .split('\0').filter((path) => path && existsSync(join(root, path)))
const hash = createHash('sha256')
for (const path of [...sources, 'node_modules/.pnpm/lock.yaml'].sort()) {
  hash.update(`${path}\0`)
  if (existsSync(join(root, path))) hash.update(readFileSync(join(root, path)))
}
const inputs = hash.digest('hex')

const [built, wrote] = existsSync(STAMP) ? readFileSync(STAMP, 'utf8').split('\n') : []
if (built === inputs && wrote === outputs()) {
  console.log('app: out/ is up to date, not building')
} else {
  rmSync(STAMP, { force: true })
  const build = spawnSync(join(app, 'node_modules/.bin/electron-vite'), ['build'], { cwd: app, stdio: 'inherit' })
  if (build.status !== 0) process.exit(build.status ?? 1)
  writeFileSync(STAMP, `${inputs}\n${outputs()}\n`)
}

/** What the build wrote: every file in out/ with its size and time. */
function outputs(): string {
  if (!existsSync(out)) return ''
  const hash = createHash('sha256')
  for (const entry of readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort()) {
    if (entry === STAMP) continue
    const { size, mtimeMs } = statSync(entry)
    hash.update(`${relative(out, entry)}\0${size}\0${mtimeMs}\0`)
  }
  return hash.digest('hex')
}

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}
