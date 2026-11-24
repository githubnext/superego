// @vitest-environment happy-dom
// `/clear` (or `/new`) in a thread's composer, in the window drawn whole over a real daemon: a new thread like it takes
// its place (its folder, profile, model and thinking; its pin), what follows the command its first message, and the old
// one archived. Offered as it's typed, run with one ⏎; not in the New thread dialog, nor while a card claims the composer.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ThreadInfo } from '@superego/protocol'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '../../sdk/src/testing.ts'
import { defineUiExtension } from '../src/renderer/extension-api.ts'
import { useComposerClaim } from '../src/renderer/composer-view.tsx'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const offered = () => $$('.completions__item .completions__label').map((item) => item.textContent)
const box = () => $('.composer textarea') as HTMLTextAreaElement
const titled = () => $('.thread__title')?.textContent

let dir: string
let daemon: TestDaemon
let ui: TestWindow | undefined
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-clear-'))
  daemon = await testDaemon({ model: 'echo' })
})
afterEach(async () => { await ui?.unmount(); ui = undefined; await daemon.close(); await rm(dir, { recursive: true, force: true }) })

const listed = () => daemon.call<ThreadInfo[]>('thread.list', {})
const archived = () => daemon.call<ThreadInfo[]>('thread.list', { archived: true })
/** The thread that took `old`'s place, once there is one, and the window shows it. */
async function replacement(old: ThreadInfo) {
  let found: ThreadInfo | undefined
  await ui!.until(async () => {
    found = (await listed()).find((t) => t.id !== old.id && t.createdAt >= old.createdAt)
    return Boolean(found) && ui!.registry.window.selection?.thread === found!.id
  }, 'a new thread, shown')
  return found!
}

it('starts the thread over with one ⏎: a new one like it, shown and focused, the old one archived', async () => {
  await mkdir(join(dir, 'sub'))
  const old = await daemon.call<ThreadInfo>('thread.start', { cwd: join(dir, 'sub'), title: 'Old', model: 'faux/faux-1', thinking: 'low' })
  ui = await mountUi({ window: true, machines: [daemon], select: { thread: old.id } })
  await ui.until(() => titled() === 'Old', 'the thread shown')

  await ui.type('.composer textarea', '/cl')
  await ui.until(() => offered().join() === '/clear', '/clear offered')
  expect($('.completions')?.getAttribute('aria-label')).toBe('Commands')
  await ui.type('.composer textarea', '/clear')
  await ui.until(() => offered().join() === '/clear', 'still offered, typed whole')
  await ui.key('enter')

  const next = await replacement(old)
  // Like it: its folder (the subfolder it worked in), its project, its profile and model; nothing sent to it.
  expect(next).toMatchObject({ cwd: join(dir, 'sub'), project: old.project, chosen: { model: 'faux/faux-1', thinking: 'low' } })
  expect(next.profile?.name).toBe(old.profile?.name)
  expect(next.title).not.toBe('Old')
  await ui.until(async () => (await archived()).some((t) => t.id === old.id), 'the old one archived')
  await ui.until(() => document.activeElement === box() && box().value === '', 'its composer focused, empty')
  expect(ui.calls.some((c) => c.method === 'thread.send')).toBe(false)
})

it('sends what follows the command to the new thread, by /new too, and moves the pin to it', async () => {
  const old = await daemon.thread(undefined, { cwd: dir, title: 'Pinned' })
  ui = await mountUi({ window: true, machines: [daemon], select: { thread: old.id } })
  await ui.until(() => titled() === 'Pinned', 'the thread shown')
  await ui.dispatch('thread.pin')
  const pinned = () => ui!.registry.router.offered('thread.unpin')
  await ui.until(pinned, 'pinned')

  await ui.type('.composer textarea', '/n')
  await ui.until(() => offered().join() === '/new', '/new offered, by its own name')
  await ui.type('.composer textarea', '/NEW  look at the tests ')
  await ui.until(() => offered().length === 0, 'past the command: nothing offered')
  await ui.key('enter')

  const next = await replacement(old)
  await daemon.idle(next.id)
  expect(await daemon.transcript(next.id)).toContain('echo: look at the tests')
  await ui.until(async () => (await archived()).some((t) => t.id === old.id), 'the old one archived')
  await ui.until(pinned, 'the pin moved to the new one')
})

it("leaves the thread as it was when the new one can't start, what was typed back in the box", async () => {
  const gone = join(dir, 'gone')
  await mkdir(gone)
  const old = await daemon.thread(undefined, { cwd: gone, title: 'Here' })
  await rm(gone, { recursive: true })
  ui = await mountUi({ window: true, machines: [daemon], select: { thread: old.id } })
  await ui.until(() => titled() === 'Here', 'the thread shown')
  await ui.type('.composer textarea', '/clear try again')
  await ui.key('enter')
  await ui.until(() => Boolean($('.composer__error')?.textContent), 'the failure said')
  expect(box().value).toBe('/clear try again')
  expect((await listed()).map((t) => t.id)).toEqual([old.id])
  expect(ui.registry.window.selection?.thread).toBe(old.id)
})

it('is no command in the New thread dialog, nor while a card claims the composer', async () => {
  const old = await daemon.thread(undefined, { cwd: dir, title: 'Asked' })
  let answered: string | undefined
  // A card that takes what's typed, as ask_user's does.
  const asking = defineUiExtension({
    name: 'asking',
    setup(superego) {
      superego.slot('composer.above', function Ask() {
        useComposerClaim({ placeholder: 'Answer…', submit: async (text) => { answered = text } })
        return null
      })
    },
  })
  ui = await mountUi({ window: true, machines: [daemon], extensions: [asking], select: { thread: old.id } })
  await ui.until(() => titled() === 'Asked' && box()?.placeholder === 'Answer…', 'the composer claimed')
  await ui.type('.composer textarea', '/clear')
  await ui.settle()
  expect(offered()).toEqual([])
  await ui.key('enter')
  await ui.until(() => answered === '/clear', 'the answer given')
  expect((await listed()).map((t) => t.id)).toEqual([old.id])

  await ui.key('mod+n')
  await ui.until(() => Boolean($('.new-thread [aria-label="Prompt"]')), 'the dialog')
  await ui.type('.new-thread [aria-label="Prompt"]', '/cl')
  await ui.settle()
  expect(offered()).toEqual([])
})
