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
  expect(hello.extensions.map((e) => e.name)).toContain('git')
  const thread = await peer.call<ThreadInfo>('thread.start', { cwd: repo })
  const changes = await peer.call<Changes>(DIFF, { thread: thread.id })
  expect(changes.repo).toBe(true)
  expect(changes.diff).toContain('-one')
  expect(changes.diff).toContain('+two')
  expect(changes.untracked).toEqual(['new.md'])
  // A read, not an action; and a folder that isn't a repository says so.
  expect((await peer.call<ActionInfo[]>('action.list', {})).map((a) => a.id)).not.toContain(DIFF)
  const plain = await peer.call<ThreadInfo>('thread.start', { cwd: join(dir, 'data') })
  expect(await peer.call<Changes>(DIFF, { thread: plain.id })).toEqual({ diff: '', untracked: [], repo: false })
  await close()
})

it('tells the agent it can open Changes, unless the machine has git off', async () => {
  const { peer, close } = await open()
  const prompt = async (text: string) => {
    const thread = await peer.call<ThreadInfo>('thread.start', { prompt: text })
    await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread.id)!.status.state === 'done')
    return JSON.stringify((await peer.call<{ value: unknown }>('thread.watch', { thread: thread.id })).value)
  }
  expect(await prompt('hi')).toContain('\\"diff\\": the changes in the working folder')
  await peer.call('settings.set', { key: 'extensions.git', value: false })
  expect(await prompt('hi again')).not.toContain('\\"diff\\"')
  await close()
})

it("refuses to open Changes for the agent where git is off, naming the kinds there are", async () => {
  const turn = (content: unknown[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })
  const call = (id: string) => turn([{ type: 'toolCall', id, name: 'pane_open', arguments: { kind: 'diff' } }], 'toolUse')
  await writeFile(join(dir, 'turns.jsonl'), [call('on'), turn([{ type: 'text', text: 'There.' }], 'stop'), call('off'), turn([{ type: 'text', text: 'There.' }], 'stop')].join('\n') + '\n')
  const data = join(dir, 'data')
  await mkdir(data)
  process.env.GITTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.GITTEST_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app, dataDir: data, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [git] })
  const server = await listen(daemon, join(data, 's.sock'))
  const { peer, socket } = await connectSocket(join(data, 's.sock'))
  await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
  type Result = { role?: string; toolCallId?: string; isError?: boolean; content?: { text?: string }[] }
  const results = async (id: string) => {
    await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === id)!.status.state === 'done')
    const { value } = await peer.call<{ value: { entries: { model?: unknown[] }[] } }>('thread.watch', { thread: id })
    return new Map(value.entries.map((e) => e.model?.[0] as Result | undefined).filter((m): m is Result => m?.role === 'toolResult').map((m) => [m.toolCallId!, m]))
  }
  const on = await peer.call<ThreadInfo>('thread.start', { prompt: 'show me' })
  expect((await results(on.id)).get('on')?.isError).toBeFalsy()
  expect((await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === on.id)!.panes?.map((p) => p.kind)).toEqual(['diff'])

  await peer.call('settings.set', { key: 'extensions.git', value: false })
  const off = await peer.call<ThreadInfo>('thread.start', { prompt: 'show me' })
  const refused = (await results(off.id)).get('off')!
  expect(refused.isError).toBe(true)
  expect(refused.content?.[0]?.text).toContain('no "diff" pane')
  expect(refused.content?.[0]?.text).toContain('"editor"')
  expect((await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === off.id)!.panes ?? []).toEqual([])
  socket.destroy(); server.close(); await daemon.close(); delete process.env.GITTEST_MODEL; delete process.env.GITTEST_REPLAY_SPEED
})
