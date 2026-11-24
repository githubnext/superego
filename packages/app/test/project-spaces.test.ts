// A project's spaces: a project's profile (`<root>/.superego/profiles/<name>`) may add spaces, registered for that
// project on its machine only; one per kind, the project's default profile's of two; its links open them only from that
// project's threads and spaces. Its other UI stays its own threads'; a thread-bound profile of the user's adds none.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineApp, type ProfileRef, type ThreadInfo } from '@superego/protocol'
import { defineUiExtension, type SpaceKind } from '../src/renderer/extension-api.ts'
import { createRegistry, projectOfProfile, seenIn } from '../src/renderer/registry.tsx'
import { linkHandler, projectSpaces, spaceFor } from '../src/renderer/lookups.ts'
import { projectProfiles } from '../src/renderer/profile-ui.ts'

const app = defineApp({ name: 'superego', id: 'superego' })
const None = () => null

const ofProject = (root: string, name = 'default'): ProfileRef => ({ scope: 'project', name, dir: `${root}/.superego/profiles/${name}` })
const thread = (root: string, profile?: ProfileRef): ThreadInfo => ({
  id: '1', title: 't', cwd: root, createdAt: 0, activeAt: 0, project: { root, name: root.split('/').at(-1)! }, status: { state: 'idle' }, ...(profile ? { profile } : {}),
})
/** A UI half with a board space (`board:` links open it), a tool row and a view of its threads. */
const board = (title = 'Board', extra: Partial<SpaceKind> = {}) => defineUiExtension({
  name: 'board',
  setup(superego) {
    superego.space('board.main', { title, component: None, match: 'board:', params: (href) => ({ card: href.slice(6) }), ...extra })
    superego.tool('board_move', { verbs: ['Moved', 'Moving', 'Move failed'] })
    superego.view('board.cards', { title: 'Cards', context: 'thread', fits: ['beside', 'sidebar'], component: None })
  },
})

afterEach(() => { vi.restoreAllMocks() })

describe("a project's spaces", () => {
  it("knows a project's profile's project by its folder; none for the user's own", () => {
    expect(projectOfProfile('box', ofProject('/src/shop', 'ops'))).toEqual({ machine: 'box', root: '/src/shop', profile: 'ops' })
    expect(projectOfProfile('local', { scope: 'user', name: 'notes', dir: '/home/me/.superego/profiles/notes' })).toBeUndefined()
  })

  it("registers a project's profile's space for that project on its machine, nowhere else", () => {
    const registry = createRegistry(app, [], () => {})
    registry.installProfile('local', ofProject('/src/shop'), [board()])
    const [space] = registry.spaces
    expect(space?.kind).toBe('board.main')
    expect(space?.machine).toBe('local')
    expect(space?.owner.project).toEqual({ machine: 'local', root: '/src/shop', profile: 'default' })
    expect(projectSpaces(registry, { machine: 'local', root: '/src/shop' }).map((s) => s.kind)).toEqual(['board.main'])
    expect(projectSpaces(registry, { machine: 'local', root: '/src/blog' })).toEqual([])
    expect(projectSpaces(registry, { machine: 'box', root: '/src/shop' })).toEqual([])
    // Not the app's: opened only as the project's.
    expect(spaceFor(registry, { kind: 'board.main', machine: 'local' })).toBeUndefined()
    expect(spaceFor(registry, { kind: 'board.main', machine: 'local', project: '/src/shop' })).toBe(space)
    // Set up again without it, it goes.
    registry.installProfile('local', ofProject('/src/shop'), [])
    expect(projectSpaces(registry, { machine: 'local', root: '/src/shop' })).toEqual([])
  })

  it("keeps its other UI to its own threads", () => {
    const registry = createRegistry(app, [], () => {})
    const own = ofProject('/src/shop')
    registry.installProfile('local', own, [board()])
    // Its view fits only the thread's places; its tool row, only its own threads.
    expect(registry.views.find((v) => v.id === 'board.cards')?.fits).toEqual(['beside'])
    expect(seenIn(registry.tools, { machine: 'local', thread: thread('/src/shop', own) })).toHaveLength(1)
    expect(seenIn(registry.tools, { machine: 'local', thread: thread('/src/shop', ofProject('/src/shop', 'ops')) })).toHaveLength(0)
    expect(seenIn(registry.tools, { machine: 'local', thread: thread('/src/shop') })).toHaveLength(0)
  })

  it("is one per kind: of two of the project's profiles, the default's", () => {
    const registry = createRegistry(app, [], () => {})
    registry.installProfile('local', ofProject('/src/shop', 'ops'), [board('Ops board')])
    registry.installProfile('local', ofProject('/src/shop'), [board('Board')])
    // Another project's of the same kind is its own.
    registry.installProfile('local', ofProject('/src/blog', 'ops'), [board('Blog board')])
    expect(registry.spaces).toHaveLength(3)
    const shop = projectSpaces(registry, { machine: 'local', root: '/src/shop' })
    expect(shop.map((s) => [s.kind, s.title])).toEqual([['board.main', 'Board']])
    expect(projectSpaces(registry, { machine: 'local', root: '/src/blog' }).map((s) => s.title)).toEqual(['Blog board'])
    // Without a default among them, the first set up.
    registry.installProfile('local', ofProject('/src/shop'), [])
    expect(projectSpaces(registry, { machine: 'local', root: '/src/shop' }).map((s) => s.title)).toEqual(['Ops board'])
  })

  it("claims its links only in its project's threads (whatever their profile) and spaces, and opens the space in it", async () => {
    const registry = createRegistry(app, [], () => {})
    registry.installProfile('local', ofProject('/src/shop', 'ops'), [board()])
    const claims = (where: Parameters<typeof linkHandler>[3]) => Boolean(linkHandler(registry, 'board:42', 'link', where))
    expect(claims({ machine: 'local', thread: thread('/src/shop') })).toBe(true)
    expect(claims({ machine: 'local', thread: thread('/src/shop', ofProject('/src/shop')) })).toBe(true)
    expect(claims({ machine: 'local', project: '/src/shop' })).toBe(true)
    expect(claims({ machine: 'local', thread: thread('/src/blog') })).toBe(false)
    expect(claims({ machine: 'box', thread: thread('/src/shop') })).toBe(false)
    expect(claims({ machine: 'local', project: '/src/blog' })).toBe(false)
    expect(claims({})).toBe(false)
    // Followed, it opens the project's space, in the project.
    const dispatch = vi.spyOn(registry.router, 'dispatch').mockResolvedValue(undefined)
    const handler = linkHandler(registry, 'board:42', 'link', { machine: 'local', thread: thread('/src/shop') })!
    expect(await handler.open('board:42', { beside: false, kind: 'link' })).toBeUndefined()
    expect(dispatch).toHaveBeenCalledWith('space.open', { kind: 'board.main', params: { card: '42' }, machine: 'local', project: '/src/shop' }, { source: 'link' })
  })

  it("can't be added by a thread-bound profile of the user's", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const registry = createRegistry(app, [], () => {})
    registry.installProfile('local', { scope: 'user', name: 'board', dir: '/home/me/.superego/profiles/board' }, [board()])
    expect(registry.spaces).toEqual([])
    expect(registry.links).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/space board\.main needs its profile to be global/))
  })
})

describe("loading a project's profiles", () => {
  it("takes those of the projects listed that may run, not the user's a thread there could start with", async () => {
    const asked: unknown[] = []
    const router = {
      dispatch: async (id: string, params: Record<string, unknown>, options: { machine?: string }) => {
        asked.push([id, params, options.machine])
        if (params.cwd === '/src/blog') throw new Error('gone')
        return [
          { ...ofProject('/src/shop'), allowed: true, description: 'The shop' },
          { ...ofProject('/src/shop', 'ops'), allowed: false },
          { scope: 'user', name: 'notes', dir: '/home/me/.superego/profiles/notes', allowed: true },
        ]
      },
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const refs = await projectProfiles({ router } as never, 'local', ['/src/shop', '/src/blog'])
    expect(asked).toEqual([['profile.list', { cwd: '/src/shop' }, 'local'], ['profile.list', { cwd: '/src/blog' }, 'local']])
    expect(refs).toEqual([ofProject('/src/shop')])
  })
})
