// images against a real daemon: show_images checks each image, keeps a copy among the thread's files for every client
// to read, and says what it couldn't show.
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Json } from '@superego/protocol'
import { callTool, say, testDaemon } from '@superego/sdk/testing'
import images, { MAX_BYTES } from '../src/daemon.ts'
import type { ShowDetails } from '../src/shared.ts'
import { png } from '@superego/daemon/image-fixtures'

let dir: string
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const show = (id: string, args: Record<string, Json>) => callTool('show_images', args, id)
type Result = { role?: string; toolCallId?: string; isError?: boolean; content?: { text?: string }[]; details?: ShowDetails }

/** A daemon (its data in `dir/home`) whose model makes `calls` in turn in a thread in `dir/project`, then stops; the results of each, by call id. */
async function run(calls: ReturnType<typeof show>[]) {
  const daemon = await testDaemon({ extensions: [images], dataDir: join(dir, 'home'), model: [...calls, say('There.')] })
  expect(daemon.extensions.map((e) => e.name)).toContain('images')
  const thread = await daemon.thread('show me', { cwd: join(dir, 'project') })
  const results = new Map((JSON.parse(await daemon.transcript(thread.id)) as { model?: Result[] }[]).map((e) => e.model?.[0])
    .filter((m): m is Result => m?.role === 'toolResult').map((m) => [m.toolCallId!, m]))
  return { peer: daemon.peer, thread, results, close: () => daemon.close() }
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

  // file.read still takes a relative path in the thread's folder.
  await writeFile(join(dir, 'project/notes.md'), 'notes')
  expect((await peer.call<{ content: string }>('file.read', { thread: thread.id, path: 'notes.md' })).content).toBe('notes')
  await expect(peer.call('file.read', { thread: thread.id, path: join(dir, 'home/attachments/other/x.png') })).rejects.toMatchObject({ kind: 'not_found' })
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
