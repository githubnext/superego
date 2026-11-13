// The skills extension against a real daemon (the echo model): the agent told what each skill is for, a named skill
// sent with the message, the list the composer completes from, and all of it gone when a machine turns skills off.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { connectSocket, listen, openDaemon } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, type RpcPeer, type ThreadInfo } from '@superego/protocol'
import skills from '../src/daemon.ts'

const app = defineApp({ name: 'test', id: 'skillstest' })
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-skills-'))
  const skill = async (name: string, front: string, body: string) => {
    await mkdir(join(dir, 'agents', 'skills', name), { recursive: true })
    await writeFile(join(dir, 'agents', 'skills', name, 'SKILL.md'), `---\n${front}\n---\n\n${body}\n`)
  }
  await skill('commit', 'name: commit\ndescription: >-\n  Write commit\n  messages.', '# Commits\nImperative subjects.')
  await skill('secret', 'name: secret\ndescription: Only by name.\ndisable-model-invocation: true', 'Hush.')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}

async function open() {
  process.env.SKILLSTEST_MODEL = 'faux'
  const daemon = await openDaemon({ app, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [skills] })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  return { peer, close: async () => { socket.destroy(); server.close(); await daemon.close(); delete process.env.SKILLSTEST_MODEL } }
}

/** Send a thread `text` and wait for the answer: what the agent was given, and the message as it went in. */
async function send(peer: RpcPeer, text: string) {
  const thread = await peer.call<ThreadInfo>('thread.create', { cwd: dir })
  await peer.call('thread.submit', { id: thread.id, text })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread.id)!.status.state === 'done')
  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { id: thread.id })
  const user = value.entries.find((e) => e.kind === 'pi.user')!.model![0] as { content: string | { type: string; text?: string }[] }
  return { all: JSON.stringify(value), content: user.content }
}

it('offers the skills to the agent, sends one a message names, and lists them for the composer', async () => {
  const { peer, close } = await open()
  expect(await peer.call('skills.list', {})).toEqual([
    { name: 'commit', description: 'Write commit messages.' }, { name: 'secret', description: 'Only by name.' },
  ])
  const { all, content } = await send(peer, 'do $commit and /skill:secret, not $HOME')
  // The agent is told what each skill is for and where it is, but not about one kept to being named.
  expect(all).toContain(`<skill name=\\"commit\\" location=\\"${join(dir, 'agents', 'skills', 'commit', 'SKILL.md')}\\">Write commit messages.</skill>`)
  expect(all).not.toContain('Only by name.')
  const blocks = content as { type: string; text?: string }[]
  expect(blocks[0]!.text).toBe('do $commit and /skill:secret, not $HOME')
  expect(blocks).toHaveLength(3)
  expect(blocks[1]!.text).toMatch(/^<skill name="commit" [^]*Imperative subjects\.\n<\/skill>$/)
  expect(blocks[1]!.text).not.toContain('description:')
  expect(blocks[2]!.text).toContain('Hush.')
  await close()
})

it('switched off on a machine, sends a named skill as plain words and offers none', async () => {
  const { peer, close } = await open()
  await peer.call('settings.set', { key: 'extensions.skills', value: false })
  const { all, content } = await send(peer, 'do $commit')
  expect(content).toBe('do $commit')
  expect(all).not.toContain('Write commit messages.')
  await close()
})
