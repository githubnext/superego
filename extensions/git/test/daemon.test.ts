// git's daemon half against a real daemon: the changes in a thread's folder as a read, and Changes told to the agent
// while the machine has git on.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { connectSocket, listen, openDaemon } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, type ActionInfo, type Hello, type ThreadInfo } from '@superego/protocol'
import git from '../src/daemon.ts'
import { DIFF, type Changes } from '../src/shared.ts'

const app = defineApp({ name: 'test', id: 'gittest' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-git-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}

async function open() {
  process.env.GITTEST_MODEL = 'faux'
  const data = join(dir, 'data')
  await mkdir(data)
  const daemon = await openDaemon({ app, dataDir: data, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [git] })
  const server = await listen(daemon, join(data, 's.sock'))
  const { peer, socket } = await connectSocket(join(data, 's.sock'))
  const hello = await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
  return { peer, hello, close: async () => { socket.destroy(); server.close(); await daemon.close(); delete process.env.GITTEST_MODEL } }
}

it("reads a thread's changes by git: the diff against HEAD and the files not tracked yet, as a plain read", async () => {
  const repo = join(dir, 'repo')
  await mkdir(repo)
  const run = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  run('init', '-q')
  await writeFile(join(repo, 'notes.md'), 'one\n')
  run('add', 'notes.md'); run('commit', '-q', '-m', 'notes')
  await writeFile(join(repo, 'notes.md'), 'two\n')
  await writeFile(join(repo, 'new.md'), 'new\n')
  const { peer, hello, close } = await open()
  expect(hello.features).toContain('ext:git')
  const thread = await peer.call<ThreadInfo>('thread.create', { cwd: repo })
  const changes = await peer.call<Changes>(DIFF, { id: thread.id })
  expect(changes.repo).toBe(true)
  expect(changes.diff).toContain('-one')
  expect(changes.diff).toContain('+two')
  expect(changes.untracked).toEqual(['new.md'])
  // A read, not an action; and a folder that isn't a repository says so.
  expect((await peer.call<ActionInfo[]>('action.list', {})).map((a) => a.id)).not.toContain(DIFF)
  const plain = await peer.call<ThreadInfo>('thread.create', { cwd: join(dir, 'data') })
  expect(await peer.call<Changes>(DIFF, { id: plain.id })).toEqual({ diff: '', untracked: [], repo: false })
  await close()
})

it('tells the agent it can open Changes, unless the machine has git off', async () => {
  const { peer, close } = await open()
  const prompt = async (text: string) => {
    const thread = await peer.call<ThreadInfo>('thread.create', { prompt: text })
    await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread.id)!.status.state === 'done')
    return JSON.stringify((await peer.call<{ value: unknown }>('thread.watch', { id: thread.id })).value)
  }
  expect(await prompt('hi')).toContain('\\"diff\\": the changes in the working folder')
  await peer.call('settings.set', { key: 'extensions.git', value: false })
  expect(await prompt('hi again')).not.toContain('\\"diff\\"')
  await close()
})
