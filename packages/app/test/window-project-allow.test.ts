// @vitest-environment happy-dom
// A project profile allowed while the window is open (from the command line, say): the window hears it from the
// machine (PROFILES_ALLOWED), lists the project's profiles again and loads the one now allowed, so its spaces show at
// once, without a thread of it shown or the window reloaded.
import { afterEach, expect, it } from 'vitest'
import { PROFILES_ALLOWED, type Json } from '@superego/protocol'
import { defineUiExtension } from '../src/renderer/sdk-ui.ts'
import { setLoader } from '../src/renderer/profile-ui.ts'
import { fakeMachine, mountUi, testThread, type TestWindow } from '../../sdk/src/testing.ts'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const root = '/src/shop'
const ref = { scope: 'project' as const, name: 'default', dir: `${root}/.superego/profiles/default` }

let ui: TestWindow
afterEach(async () => { await ui?.unmount() })

it("loads a project's profile as it's allowed, its spaces in the rail at once", async () => {
  let allowed = false
  const listed: unknown[] = []
  const machine = fakeMachine({
    threads: [testThread({ id: 't1', title: 'in the shop', profile: null, project: { root, name: 'shop' } })],
    values: { [PROFILES_ALLOWED]: [] },
    actions: [{ id: 'profile.list', title: 'List profiles' } as never],
    methods: {
      'profile.list': (params: { cwd: string }) => { listed.push(params.cwd); return [{ ...ref, allowed }] },
      'profile.ui': () => ({ hash: 'h1', entries: ['./ui.ts'] }),
      'profile.module': () => ({ path: 'ui.ts', code: 'export default {}' }),
    },
  })
  ui = await mountUi({ window: true, machines: [machine], select: { thread: 't1' } })
  // No DOM to load modules from blob URLs: the profile's UI half, as its module would give it.
  const loaded: string[] = []
  setLoader(async (profile) => {
    loaded.push(profile.dir)
    return [defineUiExtension({ name: 'shop', setup(superego) { superego.space('shop.board', { title: 'Board', component: () => null }) } })]
  })
  await ui.until(() => listed.length > 0, "the project's profiles listed")
  // Not allowed yet: nothing of it runs.
  expect(loaded).toEqual([])
  expect($('.app__project-spaces')).toBeNull()
  // Allowed on the machine (as `superego profile allow` does), which says so: its board shows.
  allowed = true
  machine.setValue(PROFILES_ALLOWED, [{ dir: ref.dir, hash: 'h1' }] as Json)
  await ui.until(() => Boolean($('.app__rail .app__project-spaces [aria-label="Board"]')), "the project's board in the rail")
  expect(loaded).toEqual([ref.dir])
  expect(listed.every((cwd) => cwd === root)).toBe(true)
})
