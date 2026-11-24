// `pnpm release <version>`: build, sign and notarize Superego <version> from main, then publish it as a GitHub release.
//
// By hand, on a Mac that can sign and notarize (see notary.ts), from any checkout or worktree of the repository. What
// it releases is the local main as it is now: built in a worktree of its own (a fresh `pnpm install`, `pnpm typecheck`,
// which stops it on a commit that doesn't type-check, then the bundle), so the main checkout, which other work
// fast-forwards all the time, is never touched. The version isn't committed: it goes into the bundle and onto the tag.
// Nothing leaves this Mac until the app is notarized; then main and an annotated tag v<version> on the commit built are
// pushed, and a GitHub release (gh) gets the zip and, as its notes, the version's section of CHANGELOG.md (Unreleased's
// notes, moved under the version and tightened first: the release stops early without it). Beside the zip goes
// update.json, the feed the released app updates from (the app config's `updateFeed` is the newest release's): it names
// this version and its zip, with the same notes. `--no-publish` stops before the tag: the notarized zip, to try out;
// nothing is uploaded, the feed included.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { updateFeedJson } from '@superego/app/package'
import app from '../superego.config.ts'
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
const repo = read('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
if (!app.updateFeed) fail('superego.config.ts has no updateFeed: the release would never update itself.')
const releaseFeed = `https://github.com/${repo}/releases/latest/download/update.json`
if (app.updateFeed !== releaseFeed) console.warn(`The app updates from ${app.updateFeed}; update.json goes on the GitHub release (${releaseFeed}): put it there too.`)
// The release's notes: the version's section of main's CHANGELOG.md, written as Unreleased and moved under its version.
const changelog = read('git', ['show', 'main:CHANGELOG.md'])
const section = changelog.split(/^## /m).find((part) => part.split('\n')[0]!.trim() === version)
const notes = section?.slice(section.indexOf('\n') + 1).trim()
if (!notes) fail(`CHANGELOG.md on main has no "## ${version}" section: move Unreleased's notes under it (and tighten them) first.`)
const identity = developerId()
notaryAuth()

const commit = read('git', ['rev-parse', 'main'])
console.log(`Releasing ${tag}: main at ${read('git', ['log', '-1', '--format=%h %s', commit])}`)
const tree = mkdtempSync(join(tmpdir(), `superego-release-${tag}-`))
run('git', ['worktree', 'add', '--detach', tree, commit])
const appDir = join(tree, 'app')
let zip = ''
try {
  run('pnpm', ['install', '--frozen-lockfile'], tree)
  // The commit released type-checks, as built here (electron-vite's build doesn't check types).
  try {
    run('pnpm', ['typecheck'], tree)
  } catch {
    throw new Error(`pnpm typecheck fails on ${commit.slice(0, 8)}: fix it on main, then release again.`)
  }
  run('pnpm', ['exec', 'electron-vite', 'build'], appDir)
  // The environment carries what notary.ts read from this checkout's .env, which the worktree doesn't have.
  execFileSync('node', ['scripts/package.ts', '--notarize', '--version', version, '--update-feed', app.updateFeed!], {
    cwd: appDir, stdio: 'inherit', env: { ...process.env, SUPEREGO_SIGN_IDENTITY: identity },
  })
  const dist = join(appDir, 'dist')
  const name = readdirSync(dist).find((file) => file.startsWith(`Superego-${version}-`) && file.endsWith('.zip'))
  if (!name) throw new Error(`No Superego-${version}-*.zip in ${dist}`)
  zip = join(dist, name)
} catch (error) {
  console.error(`\nThe release stopped before anything left this Mac: ${(error as Error).message}\nIts worktree is kept to look at: ${tree}`)
  console.error(`(remove it with: git worktree remove --force ${tree})`)
  throw error
}

if (!publish) {
  console.log(`\nBuilt and notarized, not published: ${zip}\n(remove it with: git worktree remove --force ${tree})`)
  process.exit(0)
}

run('git', ['tag', '--annotate', tag, '-m', `Superego ${version}`, commit])
const notesFile = join(tree, 'release-notes.md')
writeFileSync(notesFile, `${notes}\n`)
// The feed, as the newest release's asset: the zip it names is this release's.
const feed = join(tree, 'update.json')
writeFileSync(feed, updateFeedJson({ version, notes: notes!, zipUrl: `https://github.com/${repo}/releases/download/${tag}/${basename(zip)}` }))
try {
  run('git', ['push', 'origin', `${commit}:refs/heads/main`, `refs/tags/${tag}`])
  run('gh', ['release', 'create', tag, zip, feed, '--verify-tag', '--latest', '--title', `Superego ${version}`, '--notes-file', notesFile])
} catch (error) {
  console.error(`\nPublishing failed. The notarized zip is kept: ${zip}`)
  console.error(`Fix what's wrong above, then by hand (the tag is made${succeeds('git', ['ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`]) ? ' and pushed' : ', not pushed'}):`)
  console.error(`  git push origin ${commit}:refs/heads/main refs/tags/${tag}`)
  console.error(`  gh release create ${tag} ${zip} ${feed} --verify-tag --latest --title "Superego ${version}" --notes-file ${notesFile}`)
  console.error(`  git worktree remove --force ${tree}`)
  throw error
}
run('git', ['worktree', 'remove', '--force', tree])
console.log(`\nReleased ${tag}: ${read('gh', ['release', 'view', tag, '--json', 'url', '--jq', '.url'])}`)
