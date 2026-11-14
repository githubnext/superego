// `pnpm release <version>`: build, sign and notarize Superego <version>, then publish it as a GitHub release.
//
// From a clean main only. The version goes into app/package.json; if anything fails before publishing, that's undone and
// nothing has left this computer. After the app is notarized: a "Release v<version>" commit and an annotated tag,
// main and the tag pushed to origin, and a GitHub release (gh) with the zip and notes generated from the commits.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { packageApp } from '@superego/app/package'
import app from '../superego.config.ts'
import { developerId, notaryAuth } from './notary.ts'

const root = new URL('..', import.meta.url).pathname
const run = (command: string, args: string[]) => execFileSync(command, args, { cwd: root, stdio: 'inherit' })
const read = (command: string, args: string[]) => execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim()
const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

const version = process.argv[2]?.replace(/^v/, '')
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) fail('usage: pnpm release <version>   (e.g. 0.1.0)')
const tag = `v${version}`

// Everything that could stop it, before the minutes of building and notarizing.
if (read('git', ['branch', '--show-current']) !== 'main') fail('Release from main.')
if (read('git', ['status', '--porcelain'])) fail('Commit or put away your changes first: the release is made from a clean tree.')
if (read('git', ['tag', '--list', tag])) fail(`${tag} is already tagged.`)
run('git', ['fetch', 'origin', 'main', '--tags'])
if (read('git', ['rev-list', '--count', 'HEAD..origin/main']) !== '0') fail('origin/main has commits main doesn\'t: pull first.')
run('gh', ['auth', 'status'])
const identity = developerId()
const notarize = notaryAuth()

const manifest = `${root}package.json`
const original = readFileSync(manifest, 'utf8')
writeFileSync(manifest, original.replace(/"version": "[^"]*"/, `"version": "${version}"`))
let zip: string
try {
  run('pnpm', ['build'])
  ;[, zip] = (await packageApp(root, app, { identity, notarize })) as [string, string]
} catch (error) {
  writeFileSync(manifest, original)
  throw error
}

run('git', ['commit', '--quiet', '-m', `Release ${tag}`, manifest])
run('git', ['tag', '--annotate', tag, '-m', `Superego ${version}`])
run('git', ['push', 'origin', 'main', tag])
run('gh', ['release', 'create', tag, zip, '--verify-tag', '--title', `Superego ${version}`, '--generate-notes'])
