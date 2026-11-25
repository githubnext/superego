// @vitest-environment happy-dom
// A thread whose request is too large for its provider (413), in the window drawn whole over a real daemon: its failure
// is its own kind, the transcript offers the ways on, and starting a fresh thread from it makes one with a handoff,
// its children moved there.
import { afterEach, expect, it } from 'vitest'
import type { ThreadInfo } from '@superego/protocol'
import { fail, mountUi, say, testDaemon, type TestDaemon, type TestWindow } from '../../sdk/src/testing.ts'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]

let daemon: TestDaemon
let ui: TestWindow | undefined
afterEach(async () => { await ui?.unmount(); ui = undefined; await daemon.close() })

it('says a 413 is a request too large, offers the ways on, and starts a fresh thread from it with a handoff', async () => {
  daemon = await testDaemon({
    model: [
      fail('413 Request Entity Too Large\n'),
      // The handoff its model writes, then the fresh thread's first turn.
      say('## Goal\nShip the golden-hour game.\n\n## Open\nTune the wire physics.'),
      say('Picking up the wire physics.'),
    ],
  })
  const stuck = await daemon.thread('Build the game', { title: 'Yeetshoe' })
  expect(stuck.failure).toEqual({ kind: 'too_large', detail: '413 Request Entity Too Large\n', times: 1 })
  const child = await daemon.dispatch<ThreadInfo>('thread.start', { parent: stuck.id, title: 'Physics' })

  ui = await mountUi({ window: true, machines: [daemon], select: { thread: stuck.id } })
  await ui.until(() => Boolean($('.transcript__stuck')), 'the ways on')
  expect($('.transcript__error')?.textContent).toContain('Run failed: request too large')
  expect($$('.transcript__stuck button').map((b) => b.textContent)).toEqual(['Retry without old images', 'Compact and retry', 'Start fresh thread'])

  await ui.window!.click('Start fresh thread')
  await ui.until(() => $('.thread__title')?.textContent === 'Yeetshoe (continued)', 'the fresh thread shown')
  const handoff = ui.calls.find((c) => c.method === 'action.run' && c.params.id === 'thread.handoff')
  expect(handoff?.params.params).toEqual({ thread: stuck.id })

  const old = await daemon.info(stuck.id)
  const fresh = await daemon.idle(old.continuedIn!)
  expect(fresh).toMatchObject({ continues: stuck.id, cwd: stuck.cwd, title: 'Yeetshoe (continued)' })
  const said = await daemon.transcript(fresh.id)
  expect(said).toContain(`This thread continues [Yeetshoe](thread:${stuck.id})`)
  expect(said).toContain('Tune the wire physics.')
  // The old one links to it; its child reports to it now.
  expect(await daemon.transcript(stuck.id)).toContain(`Continued in [Yeetshoe (continued)](thread:${fresh.id})`)
  expect((await daemon.info(child.id)).parent).toBe(fresh.id)
  await ui.until(() => !$('.transcript__stuck'), 'nothing to recover in the fresh one')
})

it('retries a stuck thread without its old images, from then on', async () => {
  daemon = await testDaemon({ model: [fail('413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}'), say('Fits now.')] })
  const stuck = await daemon.thread('Look at these', { title: 'Shots' })
  expect(stuck.failure?.kind).toBe('too_large')
  await daemon.dispatch('thread.retry', { thread: stuck.id, lean: true })
  const after = await daemon.idle(stuck.id)
  expect(after.failure).toBeUndefined()
  expect(after.lean).toBe(true)
  expect(after.status.msg).toBe('Fits now.')
})
