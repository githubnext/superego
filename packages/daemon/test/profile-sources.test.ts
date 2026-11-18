import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineApp, PROTOCOL_VERSION, type ProfileInfo, type ProfileSourceInfo, type RpcPeer, type ThreadInfo } from '@superego/protocol'
import { connectSocket, listen, openDaemon } from '../src/index.ts'
import { parseSource } from '../src/profile-sources.ts'
import { until } from './until.ts'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]

const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string
let home: string
let project: string
let remotes: string
const saved = { ...process.env }

const open = async () => {
  process.env.SUPEREGO_MODEL = 'faux'
  const daemon = await openDaemon({ app: SUPEREGO, dataDir: home, defaultCwd: dir })
  const server = await listen(daemon, join(home, 'superego.sock'))
  const { peer, socket } = await connectSocket(join(home, 'superego.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  const run = <T>(id: string, params: Record<string, unknown> = {}) => peer.call<T>('action.run', { id, params })
  return { peer, run, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
}

const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}
const profile = (prompt: string, more = '') => `import { defineProfile } from 'superego'\nexport default defineProfile({ prompt: ${JSON.stringify(prompt)}${more} })\n`

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString().trim()
/** A repo at https://example.test/<owner>/<repo>, as git is told to fetch it here (`insteadOf`). */
function remote(owner: string, repo: string, files: Record<string, string>) {
  const at = join(remotes, owner, `${repo}.git`)
  mkdirSync(at, { recursive: true })
  git(at, 'init', '--quiet', '--initial-branch=main')
  return commit(at, files)
}
function commit(at: string, files: Record<string, string>) {
  write(at, files)
  git(at, 'add', '-A')
  git(at, 'commit', '--quiet', '-m', 'change')
  return at
}

const instructions = async (peer: RpcPeer, id: string) => {
  const { value } = await peer.call<{ value: { docs: Record<string, unknown> } }>('thread.watch', { thread: id })
  return (value.docs['pi.agent'] as { instructions?: string } | undefined)?.instructions
}
const done = (peer: RpcPeer, id: string) => until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).find((s) => s.id === id)?.status.state === 'done')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-sources-'))
  home = join(dir, 'home')
  project = join(dir, 'acme')
  remotes = join(dir, 'remotes')
  mkdirSync(project, { recursive: true })
  // Git reaches https://example.test/… in the remotes folder.
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://example.test/' })
})
afterEach(async () => {
  for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]
  await rm(dir, { recursive: true, force: true })
})

describe('parseSource', () => {
  it('reads git sources and folders, and refuses anything else', () => {
    expect(parseSource('git:github.com/mikker/superego-profiles', '/data')).toEqual({ kind: 'git', spec: 'git:github.com/mikker/superego-profiles', host: 'github.com', owner: 'mikker', repo: 'superego-profiles', dir: '/data/sources/github.com/mikker/superego-profiles' })
    expect(parseSource('https://github.com/mikker/superego-profiles.git', '/data')).toMatchObject({ spec: 'git:github.com/mikker/superego-profiles' })
    expect(parseSource('git:github.com/acme/profiles@v1.2', '/data')).toMatchObject({ spec: 'git:github.com/acme/profiles@v1.2', ref: 'v1.2', dir: '/data/sources/github.com/acme/profiles' })
    expect(parseSource('~/dev/superego-profiles', '/data')).toEqual({ kind: 'local', spec: '~/dev/superego-profiles', dir: join(homedir(), 'dev/superego-profiles') })
    expect(parseSource('/opt/profiles/', '/data')).toMatchObject({ kind: 'local', dir: '/opt/profiles' })
    for (const bad of ['git:github.com/mikker', 'git:github.com/../x/y', 'git:a/b/c/d', 'git:a/b/c@', 'profiles', './profiles', '']) {
      expect(() => parseSource(bad, '/data'), bad).toThrow()
    }
  })
})

it("installs a git source: its profiles are the user's, run unasked, and installing again changes nothing", async () => {
  remote('mikker', 'superego-profiles', { 'profiles/default/profile.ts': profile('From the repo.'), 'profiles/writer/profile.ts': profile('Write.') })
  const { peer, run, close } = await open()
  const { source, changed } = await run<{ source: ProfileSourceInfo; changed: boolean }>('profile.install', { source: 'git:example.test/mikker/superego-profiles' })
  const clone = join(home, 'sources', 'example.test', 'mikker', 'superego-profiles')
  expect(changed).toBe(true)
  expect(source).toMatchObject({ source: 'git:example.test/mikker/superego-profiles', kind: 'git', dir: clone, state: 'ready', profiles: [{ name: 'default' }, { name: 'writer' }] })
  expect(source.commit).toMatch(/^[0-9a-f]+$/)
  expect(await run<{ changed: boolean }>('profile.install', { source: 'git:example.test/mikker/superego-profiles' })).toMatchObject({ changed: false })
  expect(await run<ProfileSourceInfo[]>('profile.sources')).toHaveLength(1)

  expect(await peer.call<ProfileInfo[]>('profile.list', { cwd: project })).toMatchObject([
    { name: 'default', scope: 'user', source: 'git:example.test/mikker/superego-profiles', dir: join(clone, 'profiles', 'default'), allowed: true },
    { name: 'writer', scope: 'user', source: 'git:example.test/mikker/superego-profiles' },
  ])
  const thread = await peer.call<ThreadInfo>('thread.start', { cwd: project, prompt: 'hi' })
  expect(thread.profile).toMatchObject({ name: 'default', scope: 'user', source: 'git:example.test/mikker/superego-profiles' })
  await done(peer, thread.id)
  expect(await instructions(peer, thread.id)).toBe('From the repo.')
  await close()
})

it("puts ~/.superego/profiles first, then each source in order, and tells of the one shadowed", async () => {
  remote('a', 'one', { 'profiles/default/profile.ts': profile('One.'), 'profiles/shared/profile.ts': profile('One shared.') })
  const two = join(dir, 'two')
  write(two, { 'profiles/shared/profile.ts': profile('Two shared.'), 'profiles/base/profile.ts': profile('Base.') })
  write(join(home, 'profiles', 'default'), { 'profile.ts': profile('Mine.') })
  // A project's profile extends a source's, by name like any of the user's.
  write(join(project, '.superego', 'profiles', 'support'), { 'profile.ts': profile('Support.', `, extends: 'user:base'`) })
  const { peer, run, close } = await open()
  await run('profile.install', { source: 'git:example.test/a/one' })
  await run('profile.install', { source: two })
  const list = await peer.call<ProfileInfo[]>('profile.list', { cwd: project })
  expect(list.map((p) => [p.name, p.source])).toEqual([['support', undefined], ['default', undefined], ['shared', 'git:example.test/a/one'], ['base', two]])
  expect(list.find((p) => p.name === 'default')!.problems).toEqual([expect.stringMatching(/^Shadows the default profile of git:example.test\/a\/one/)])
  expect(list.find((p) => p.name === 'shared')!.problems).toEqual([expect.stringMatching(new RegExp(`^Shadows the shared profile of ${two}`))])
  // The user's own, whatever the folder: the shadowed ones too, saying so.
  const mine = await peer.call<ProfileInfo[]>('profile.list', { cwd: project, user: true })
  expect(mine.map((p) => `${p.name}@${p.source ?? 'own'}`)).toEqual(['default@own', 'default@git:example.test/a/one', 'shared@git:example.test/a/one', 'base@' + two, 'shared@' + two])
  expect(mine[1]!.problems).toEqual([expect.stringMatching(/^Shadowed by .*home\/profiles\/default/)])
  const sources = await run<ProfileSourceInfo[]>('profile.sources')
  expect(sources.map((s) => s.profiles.map((p) => `${p.name}${p.shadowedBy ? ' (shadowed)' : ''}`))).toEqual([['default (shadowed)', 'shared'], ['base', 'shared (shadowed)']])

  await peer.call('profile.allow', { cwd: project, name: 'support' })
  const thread = await peer.call<ThreadInfo>('thread.start', { cwd: project, profile: 'support', prompt: 'hi' })
  await done(peer, thread.id)
  expect(await instructions(peer, thread.id)).toBe('Base.\n\nSupport.')
  await close()
})

it('pulls a git source on update, and its profile loads again for the next turn; pinned ones stay', async () => {
  const repo = remote('mikker', 'profiles', { 'profiles/default/profile.ts': profile('Before.') })
  git(repo, 'tag', 'v1')
  remote('acme', 'pinned', { 'profiles/pinned/profile.ts': profile('Pinned.') })
  const { peer, run, close } = await open()
  await run('profile.install', { source: 'git:example.test/mikker/profiles' })
  await run('profile.install', { source: 'git:example.test/acme/pinned@main' })
  const thread = await peer.call<ThreadInfo>('thread.start', { cwd: project, prompt: 'hi' })
  await done(peer, thread.id)
  expect(await instructions(peer, thread.id)).toBe('Before.')

  expect(await run('profile.update')).toEqual([
    { source: 'git:example.test/mikker/profiles', result: 'current', from: expect.any(String), to: expect.any(String) },
    { source: 'git:example.test/acme/pinned@main', result: 'pinned' },
  ])
  commit(repo, { 'profiles/default/profile.ts': profile('After.') })
  const [updated] = await run<{ result: string; from: string; to: string }[]>('profile.update', { source: 'git:example.test/mikker/profiles' })
  expect(updated).toMatchObject({ result: 'updated' })
  expect(updated!.from).not.toBe(updated!.to)
  await peer.call('thread.send', { thread: thread.id, text: 'again' })
  await until(async () => await instructions(peer, thread.id) === 'After.')

  // A source that no longer pulls fails on its own, and says why.
  await rm(repo, { recursive: true, force: true })
  const results = await run<{ source: string; result: string; error?: string }[]>('profile.update')
  expect(results[0]).toMatchObject({ result: 'failed', error: expect.any(String) })
  expect(results[1]).toMatchObject({ result: 'pinned' })
  await expect(run('profile.update', { source: 'git:example.test/mikker/profiles' })).rejects.toThrow(/Couldn't update git:example.test\/mikker\/profiles/)
  await close()
})

it('takes the same repo at another ref in place of the first, cloned at that ref', async () => {
  const repo = remote('acme', 'profiles', { 'profiles/default/profile.ts': profile('One.') })
  git(repo, 'tag', 'v1')
  commit(repo, { 'profiles/default/profile.ts': profile('Two.') })
  const { run, close } = await open()
  await run('profile.install', { source: 'git:example.test/acme/profiles' })
  const { changed, source } = await run<{ changed: boolean; source: ProfileSourceInfo }>('profile.install', { source: 'git:example.test/acme/profiles@v1' })
  expect(changed).toBe(true)
  expect(source).toMatchObject({ source: 'git:example.test/acme/profiles@v1', ref: 'v1' })
  expect((await run<ProfileSourceInfo[]>('profile.sources')).map((s) => s.source)).toEqual(['git:example.test/acme/profiles@v1'])
  expect(git(source.dir, 'show', 'HEAD:profiles/default/profile.ts')).toContain('One.')
  await close()
})

it("removes a source: a git one's clone and the folders it leaves empty go with it, a folder stays", async () => {
  remote('mikker', 'profiles', { 'profiles/default/profile.ts': profile('Repo.') })
  const folder = join(dir, 'local')
  write(folder, { 'profiles/writer/profile.ts': profile('Write.') })
  const { peer, run, close } = await open()
  await run('profile.install', { source: 'git:example.test/mikker/profiles' })
  await run('profile.install', { source: folder })
  expect(await run('profile.remove', { source: 'git:example.test/mikker/profiles@whatever' })).toEqual({ source: 'git:example.test/mikker/profiles', dir: join(home, 'sources', 'example.test', 'mikker', 'profiles'), deleted: true })
  expect(existsSync(join(home, 'sources', 'example.test'))).toBe(false)
  expect(existsSync(join(home, 'sources'))).toBe(true)
  await run('profile.remove', { source: folder })
  expect(existsSync(join(folder, 'profiles', 'writer', 'profile.ts'))).toBe(true)
  expect(await peer.call<ProfileInfo[]>('profile.list', { cwd: project })).toEqual([])
  await expect(run('profile.remove', { source: folder })).rejects.toThrow(/No profile source/)
  await close()
})

it('says why a source fails to install, and lists nothing of it', async () => {
  remote('acme', 'empty', { 'README.md': 'no profiles here' })
  write(join(dir, 'bare'), { 'README.md': '' })
  const { run, close } = await open()
  await expect(run('profile.install', { source: 'git:example.test/acme/nothing' })).rejects.toThrow(/Couldn't clone git:example.test\/acme\/nothing/)
  await expect(run('profile.install', { source: 'git:example.test/acme/empty' })).rejects.toThrow(/has no profiles\/ folder/)
  await expect(run('profile.install', { source: join(dir, 'missing') })).rejects.toThrow(/No folder at/)
  await expect(run('profile.install', { source: join(dir, 'bare') })).rejects.toThrow(/has no profiles\/ folder/)
  await expect(run('profile.install', { source: 'profiles' })).rejects.toThrow(/a folder as ~\/… or an absolute path/)
  expect(await run('profile.sources')).toEqual([])
  expect(existsSync(join(home, 'sources', 'example.test'))).toBe(false)
  await close()
})

it('reads the list again when edited by hand: a git source not cloned yet is cloned by update, a missing folder told of', async () => {
  remote('mikker', 'profiles', { 'profiles/default/profile.ts': profile('Repo.') })
  const { run, close } = await open()
  write(home, { 'profile-sources.json': JSON.stringify({ sources: ['git:example.test/mikker/profiles', join(dir, 'gone')] }) })
  expect((await run<ProfileSourceInfo[]>('profile.sources')).map((s) => s.state)).toEqual(['not-cloned', 'missing'])
  expect(await run('profile.update')).toEqual([{ source: 'git:example.test/mikker/profiles', result: 'cloned' }, { source: join(dir, 'gone'), result: 'local' }])
  expect((await run<ProfileSourceInfo[]>('profile.sources'))[0]).toMatchObject({ state: 'ready', profiles: [{ name: 'default' }] })
  // A list that doesn't read is said so, and not written over.
  write(home, { 'profile-sources.json': '{ "sources": "nope"' })
  await expect(run('profile.sources')).rejects.toThrow(/profile-sources.json/)
  await expect(run('profile.install', { source: 'git:example.test/mikker/profiles' })).rejects.toThrow(/profile-sources.json/)
  await close()
})
