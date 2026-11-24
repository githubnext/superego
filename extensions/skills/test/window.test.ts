// @vitest-environment happy-dom
// Skills in the composer beside its own commands, in the window over a real daemon: a `/` opening the message offers
// both (`/clear` and `/compact` first, then the skills), and taking a skill puts it in to write after, where ⏎ on a command runs it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ThreadInfo } from '@superego/protocol'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '@superego/sdk/testing'
import skills from '../src/daemon.ts'
import skillsUi from '../src/ui.tsx'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const offered = () => [...document.querySelectorAll('.completions__item .completions__label')].map((item) => item.textContent)
const box = () => $('.composer textarea') as HTMLTextAreaElement

let dir: string
let daemon: TestDaemon
let ui: TestWindow | undefined
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-skills-window-'))
  for (const name of ['commit', 'clean-copy']) {
    await mkdir(join(dir, 'agents', 'skills', name), { recursive: true })
    await writeFile(join(dir, 'agents', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nDo it.\n`)
  }
  daemon = await testDaemon({ extensions: [skills], dataDir: dir, model: 'echo' })
})
afterEach(async () => { await ui?.unmount(); ui = undefined; await daemon.close(); await rm(dir, { recursive: true, force: true }) })

it('offers the commands and the skills a `/` names in one menu, a skill taken to write after', async () => {
  const thread = await daemon.thread(undefined, { cwd: dir, title: 'Here' })
  ui = await mountUi({ window: true, extensions: [skillsUi], machines: [daemon], select: { thread: thread.id } })
  await ui.until(() => $('.thread__title')?.textContent === 'Here', 'the thread shown')

  await ui.type('.composer textarea', '/c')
  await ui.until(() => offered().length === 4, 'the commands and the skills')
  expect(offered()).toEqual(['/clear', '/compact', '/skill:clean-copy', '/skill:commit'])
  expect($('.completions')?.getAttribute('aria-label')).toBe('Commands · Skills')
  await ui.type('.composer textarea', '/cl')
  await ui.until(() => offered().join() === '/clear,/skill:clean-copy', 'narrowed as typed')
  await ui.type('.composer textarea', '/comm')
  await ui.until(() => offered().join() === '/skill:commit', 'a skill alone')
  await ui.key('enter')
  await ui.until(() => box().value === '/skill:commit ', 'the skill put in, not sent')
  expect((await daemon.call<ThreadInfo[]>('thread.list', {})).map((t) => t.id)).toEqual([thread.id])
  // ⇥ on a command puts it in too, to write after it.
  await ui.type('.composer textarea', '/cl')
  await ui.until(() => offered()[0] === '/clear', 'the command first')
  await ui.key('tab')
  await ui.until(() => box().value === '/clear ', 'the command put in')
  expect((await daemon.call<ThreadInfo[]>('thread.list', {})).map((t) => t.id)).toEqual([thread.id])
})
