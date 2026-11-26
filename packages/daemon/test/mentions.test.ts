// What a mention of an extension's thing names (`superego.mention`): a resolver per kind, refused for a kind that can't
// be one or is taken, found for the threads that have its extension (`mentionResolver`), and asked within its time.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineApp, type ThreadInfo } from '@superego/protocol'
import { defineDaemonExtension, openDaemon, type DaemonApi } from '../src/index.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-mentions-')) })
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }) })

const thread = (extra: Partial<ThreadInfo> = {}): ThreadInfo => ({ id: '1', title: 't', cwd: dir, createdAt: 0, activeAt: 0, project: { root: dir, name: 'd' }, status: { state: 'idle' }, ...extra })

it('resolves a kind for threads that have its extension, within its time, and refuses kinds that can\'t be or are taken', async () => {
  const refused: string[] = []
  let api!: DaemonApi
  const canvas = defineDaemonExtension({
    name: 'canvas',
    setup(superego) {
      api = superego
      superego.mention('canvas', ({ ref, kind, id, thread }) => id === 'slow' ? new Promise((resolve) => setTimeout(() => resolve('late'), 500)) : `${kind} ${id} (${ref}) in ${thread.id}`)
      for (const kind of ['Canvas', 'thread', 'file', 'folder', 'canvas']) {
        try { superego.mention(kind, () => 'x') } catch (error) { refused.push((error as Error).message) }
      }
    },
  })
  const daemon = await openDaemon({ app: defineApp({ name: 'superego', id: 'superego' }), dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [canvas], mentionLimit: 100 })
  try {
    expect(refused).toEqual([
      'Extension canvas: mention kind "Canvas" must be lowercase letters, digits and dashes, starting with a letter',
      "Extension canvas: mention kind thread is the Mentions extension's own",
      "Extension canvas: mention kind file is the Mentions extension's own",
      "Extension canvas: mention kind folder is the Mentions extension's own",
      "Mention kind canvas is canvas's already",
    ])
    const resolve = api.mentionResolver('canvas', thread())!
    expect(await resolve({ ref: '@canvas:fox', id: 'fox' })).toBe('canvas fox (@canvas:fox) in 1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await resolve({ ref: '@canvas:slow', id: 'slow' })).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('resolving @canvas:slow took over 0.1s'))
    expect(api.mentionResolver('note', thread())).toBeUndefined()
    expect(api.mentionResolver('canvas', thread({ without: ['canvas'] }))).toBeUndefined()
  } finally {
    await daemon.close()
  }
})
