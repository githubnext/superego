// `pnpm release <version>`: build, sign and notarize Superego <version> from main, then publish it as a GitHub release.
//
// By hand, on a Mac that can sign and notarize (see notary.ts), from any checkout or worktree of the repository. What
// it releases is the local main as it is now: built in a worktree of its own (a fresh `pnpm install`, then the bundle),
// so the main checkout, which other work fast-forwards all the time, is never touched. The version isn't committed: it
// goes into the bundle and onto the tag. Nothing leaves this Mac until the app is notarized; then main and an annotated
// tag v<version> on the commit built are pushed, and a GitHub release (gh) gets the zip and notes from the commits.
// `--no-publish` stops before the tag: the notarized zip, to try out.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { developerId, notaryAuth } from './notary.ts'

const here = new URL('..', import.meta.url).pathname
const run = (command: string, args: string[], cwd = here) => execFileSync(command, args, { cwd, stdio: 'inherit' })
const read = (command: string, args: string[], cwd = here) => execFileSync(command, args, { cwd, encoding: 'utf8' }).trim()
const succeeds = (command: string, args: string[]) => {
  try {
    execFileSync(command, args, { cwd: here, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

const latest = read('git', ['tag', '--list', 'v*', '--sort=-v:refname']).split('\n')[0] || 'none yet'
const args = process.argv.slice(2)
const publish = !args.includes('--no-publish')
const version = args.find((arg) => !arg.startsWith('--'))?.replace(/^v/, '') ?? ''
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) fail(`usage: pnpm release <version> [--no-publish]   (e.g. 0.1.0; the latest is ${latest})`)
const tag = `v${version}`

// Everything that could stop it, before the minutes of installing, building and notarizing.
run('git', ['fetch', '--quiet', 'origin', 'main', '--tags'])
if (succeeds('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`])) fail(`${tag} is already tagged.`)
if (!succeeds('git', ['merge-base', '--is-ancestor', 'origin/main', 'main'])) fail('origin/main has commits main doesn\'t: bring them into main first.')
run('gh', ['auth', 'status'])
const identity = developerId()
notaryAuth()

const commit = read('git', ['rev-parse', 'main'])
console.log(`Releasing ${tag}: main at ${read('git', ['log', '-1', '--format=%h %s', commit])}`)
const tree = mkdtempSync(join(tmpdir(), `superego-release-${tag}-`))
run('git', ['worktree', 'add', '--detach', tree, commit])
const app = join(tree, 'app')
let zip = ''
try {
  run('pnpm', ['install', '--frozen-lockfile'], tree)
  run('pnpm', ['exec', 'electron-vite', 'build'], app)
  // The environment carries what notary.ts read from this checkout's .env, which the worktree doesn't have.
  execFileSync('node', ['scripts/package.ts', '--notarize', '--version', version], {
    cwd: app, stdio: 'inherit', env: { ...process.env, SUPEREGO_SIGN_IDENTITY: identity },
  })
  const dist = join(app, 'dist')
  const name = readdirSync(dist).find((file) => file.startsWith(`Superego-${version}-`) && file.endsWith('.zip'))
  if (!name) throw new Error(`No Superego-${version}-*.zip in ${dist}`)
  zip = join(dist, name)
} catch (error) {
  console.error(`\nThe build failed; nothing left this Mac. Its worktree is kept to look at: ${tree}`)
  console.error(`(remove it with: git worktree remove --force ${tree})`)
  throw error
}

if (!publish) {
  console.log(`\nBuilt and notarized, not published: ${zip}\n(remove it with: git worktree remove --force ${tree})`)
  process.exit(0)
}

run('git', ['tag', '--annotate', tag, '-m', `Superego ${version}`, commit])
try {
  run('git', ['push', 'origin', `${commit}:refs/heads/main`, `refs/tags/${tag}`])
  run('gh', ['release', 'create', tag, zip, '--verify-tag', '--title', `Superego ${version}`, '--generate-notes'])
} catch (error) {
  console.error(`\nPublishing failed. The notarized zip is kept: ${zip}`)
  console.error(`Fix what's wrong above, then by hand (the tag is made${succeeds('git', ['ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`]) ? ' and pushed' : ', not pushed'}):`)
  console.error(`  git push origin ${commit}:refs/heads/main refs/tags/${tag}`)
  console.error(`  gh release create ${tag} ${zip} --verify-tag --title "Superego ${version}" --generate-notes`)
  console.error(`  git worktree remove --force ${tree}`)
  throw error
}
run('git', ['worktree', 'remove', '--force', tree])
console.log(`\nReleased ${tag}: ${read('gh', ['release', 'view', tag, '--json', 'url', '--jq', '.url'])}`)
