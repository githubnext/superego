import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ConversationView } from '@earendil-works/pi-durable'
import { connectSocket, listen, openDaemon } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, type Hello, type Json, type ThreadInfo } from '@superego/protocol'
import images, { MAX_BYTES } from '../src/daemon.ts'
import type { ShowDetails } from '../src/shared.ts'
import { png } from './fixtures.ts'

const app = defineApp({ name: 'test', id: 'imagestest' })
let dir: string
afterEach(async () => { await rm(dir, { recursive: true, force: true }); delete process.env.IMAGESTEST_MODEL })

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const turn = (content: Json[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })
const show = (id: string, args: Json) => turn([{ type: 'toolCall', id, name: 'show_images', arguments: args }], 'toolUse')
type Result = { role?: string; toolCallId?: string; isError?: boolean; content?: { text?: string }[]; details?: ShowDetails }

/** A daemon whose model makes `calls` in turn, then stops; the results of each, by call id. */
async function run(calls: string[]) {
  await writeFile(join(dir, 'turns.jsonl'), [...calls, turn([{ type: 'text', text: 'There.' }], 'stop')].join('\n') + '\n')
  process.env.IMAGESTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.IMAGESTEST_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app, dataDir: join(dir, 'home'), defaultCwd: join(dir, 'project'), extensions: [images] })
  const server = await listen(daemon, join(dir, 's.sock'))
  const { peer, socket } = await connectSocket(join(dir, 's.sock'))
  const hello = await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
  expect(hello.extensions.map((e) => e.name)).toContain('images')
  const thread = await peer.call<ThreadInfo>('thread.start', {})
  await peer.call('thread.send', { thread: thread.id, text: 'show me' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'done')
  const { value } = await peer.call<{ value: ConversationView }>('thread.watch', { thread: thread.id })
  const results = new Map(value.entries.map((e) => e.model?.[0] as Result | undefined)
    .filter((m): m is Result => m?.role === 'toolResult').map((m) => [m.toolCallId!, m]))
  const close = async () => { socket.destroy(); server.close(); await daemon.close() }
  return { peer, thread, results, close }
}

it('shows files and web images, kept among the thread’s files for every client to read', async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-images-'))
  await mkdir(join(dir, 'project/shots'), { recursive: true })
  await writeFile(join(dir, 'project/shots/home.png'), png(40, 30))
  await writeFile(join(dir, 'elsewhere.png'), png(8, 8))
  const { peer, thread, results, close } = await run([
    show('one', { images: [{ path: 'shots/home.png', caption: 'Home', alt: 'The home page' }] }),
    show('few', { title: 'Before and after', images: [{ path: join(dir, 'elsewhere.png') }, { url: 'https://example.com/a.png' }] }),
    show('many', { layout: 'carousel', images: [{ path: 'shots/home.png' }, { path: 'shots/home.png' }] }),
  ])

  const one = results.get('one')!
  expect(one.isError).toBeFalsy()
  expect(one.content?.[0]?.text).toBe('Showed 1 image.')
  expect(one.details).toMatchObject({ layout: 'single', images: [{ name: 'shots/home.png', mimeType: 'image/png', width: 40, height: 30, caption: 'Home', alt: 'The home page' }] })
  // A copy among the thread's files, read back over the protocol as any client would, byte for byte.
  const kept = one.details!.images[0]!.path!
  expect(kept.startsWith(join(dir, 'home/attachments', thread.id, 'shown'))).toBe(true)
  const { content } = await peer.call<{ content: string }>('file.read', { thread: thread.id, path: kept, base64: true })
  expect(Buffer.from(content, 'base64').equals(await readFile(join(dir, 'project/shots/home.png')))).toBe(true)
  // Changing the original doesn't change what was shown.
  await writeFile(join(dir, 'project/shots/home.png'), png(2, 2))
  expect((await peer.call<{ content: string }>('file.read', { thread: thread.id, path: kept, base64: true })).content).toBe(content)

  const few = results.get('few')!
  expect(few.content?.[0]?.text).toBe('Showed 2 images.')
  expect(few.details).toMatchObject({ title: 'Before and after', layout: 'grid', images: [{ width: 8, height: 8 }, { url: 'https://example.com/a.png', name: 'https://example.com/a.png' }] })
  expect(few.details!.images[1]!.path).toBeUndefined()
  // An absolute path outside the folder is fine; each copy is its own.
  expect(new Set([...results.values()].flatMap((r) => r.details?.images.map((i) => i.path) ?? []).filter(Boolean)).size).toBe(4)
  expect(results.get('many')!.details!.layout).toBe('carousel')

  // file.read still takes a relative path in the thread's folder, and nothing of another thread's files.
  await writeFile(join(dir, 'project/notes.md'), 'notes')
  expect((await peer.call<{ content: string }>('file.read', { thread: thread.id, path: 'notes.md' })).content).toBe('notes')
  await expect(peer.call('file.read', { thread: thread.id, path: join(dir, 'home/attachments/other/x.png') })).rejects.toMatchObject({ kind: 'invalid' })
  await close()
})

it('says clearly what it couldn’t show, and shows none of a call that fails', async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-images-'))
  await mkdir(join(dir, 'project'), { recursive: true })
  await writeFile(join(dir, 'project/notes.png'), '# not an image')
  await writeFile(join(dir, 'project/ok.png'), png(4, 4))
  await writeFile(join(dir, 'project/huge.png'), png(4, 4))
  await truncate(join(dir, 'project/huge.png'), MAX_BYTES + 1)
  const { results, close } = await run([
    show('gone', { images: [{ path: 'missing.png' }] }),
    show('mixed', { images: [{ path: 'ok.png' }, { path: 'notes.png' }, { path: 'huge.png' }, { path: '.' }] }),
    show('urls', { images: [{ url: 'file:///etc/hosts' }, { url: 'not a url' }, { path: 'ok.png', url: 'https://example.com/a.png' }, {}] }),
  ])
  const error = (id: string) => { const r = results.get(id)!; expect(r.isError).toBe(true); return r.content?.map((c) => c.text).join('') ?? '' }
  expect(error('gone')).toContain('missing.png: no such file')
  const mixed = error('mixed')
  expect(mixed).toContain('Couldn’t show 3 of 4')
  expect(mixed).toContain('notes.png is not an image (PNG, JPEG, GIF, WebP or SVG)')
  expect(mixed).toContain('huge.png is 10.0 MB; images up to 10 MB are shown')
  expect(mixed).toContain('. is not a file')
  expect(mixed).not.toContain('ok.png')
  const urls = error('urls')
  expect(urls).toContain('give a file as its path, not a file:// address')
  expect(urls).toContain('not a url is not a web address')
  expect(urls).toContain('give a path or a url, not both')
  expect(urls).toContain('each image needs a path or a url')
  await close()
})
