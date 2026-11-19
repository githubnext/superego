// @vitest-environment happy-dom
// ⌘N's dialog drawn whole over real daemons: the machine first, then a folder on it from those its threads worked in
// (archived ones' too), each field a ⌃digit away, and the prompt the composer it is in a thread, files and all.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MESSAGE_ENTRY } from '@superego/protocol'
import { daemonMachine, mountUi, testDaemon, type TestDaemon, type TestWindow } from '../../sdk/src/testing.ts'

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const focused = () => document.activeElement?.getAttribute('aria-label')
const folder = () => $<HTMLInputElement>('.new-thread [aria-label="Folder"]')!.value
const listed = () => $$('.folder-field__name').map((row) => row.textContent)

let dir: string
let daemons: TestDaemon[] = []
let ui: TestWindow | undefined
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-new-thread-')) })
afterEach(async () => {
  await ui?.unmount()
  ui = undefined
  await Promise.all(daemons.map((d) => d.close()))
  daemons = []
  await rm(dir, { recursive: true, force: true })
})
const folders = async (...names: string[]) => Promise.all(names.map(async (name) => {
  await mkdir(join(dir, name))
  return join(dir, name)
}))

it('goes field to field by ⌃1–⌃7, and offers the folders each machine worked in, archived threads’ too', async () => {
  const [ledger, notes, garden] = await folders('ledger', 'notes', 'garden')
  const local = await testDaemon({ model: 'echo' })
  const box = await testDaemon({ model: 'echo' })
  daemons = [local, box]
  const old = await local.thread(undefined, { cwd: ledger })
  await local.call('thread.archive', { thread: old.id })
  await local.thread(undefined, { cwd: notes })
  await box.thread(undefined, { cwd: garden })
  ui = await mountUi({ window: true, machines: [local, daemonMachine(box, 'box')] })
  await ui.key('mod+n')
  await ui.until(() => Boolean($('.new-thread')), 'the dialog')

  // Two machines: it opens on the machine, the folder its threads worked in last already in.
  expect(focused()).toBe('Machine')
  expect(folder()).toBe(notes)
  // Each field's key, shown beside its name.
  expect($$('.new-thread__label').map((label) => label.textContent)).toEqual(
    ['Machine⌃1', 'Folder⌃2', 'Profile⌃3', 'Model⌃4', 'Thinking⌃5', 'Prompt⌃6', 'Name⌃7'].map((l) => navigator.platform.startsWith('Mac') ? l : l.replace('⌃', 'Ctrl+')))

  await ui.key('ctrl+2')
  expect(focused()).toBe('Folder')
  await ui.until(() => listed().join() === 'notes,ledger', "the machine's folders, the archived thread's after")
  await ui.type('.new-thread [aria-label="Folder"]', 'led')
  await ui.until(() => listed().join() === 'ledger', 'narrowed as typed')
  await ui.key('enter')
  expect(folder()).toBe(ledger)
  expect(listed()).toEqual([])

  // Another machine: its own folders.
  await ui.key('ctrl+1')
  expect(focused()).toBe('Machine')
  const machine = $<HTMLSelectElement>('.new-thread [aria-label="Machine"]')!
  machine.value = 'box'
  machine.dispatchEvent(new (machine.ownerDocument.defaultView as unknown as typeof globalThis).Event('change', { bubbles: true }))
  await ui.until(() => folder() === garden, "the other machine's last folder")

  for (const [key, field] of [['ctrl+6', 'Prompt'], ['ctrl+7', 'Name'], ['ctrl+3', 'Profile']] as const) {
    await ui.until(() => !$<HTMLSelectElement>(`.new-thread [aria-label="${field}"]`)?.disabled, `${field} ready`)
    await ui.key(key)
    expect(focused()).toBe(field)
  }
  // Esc with the folder's list open closes only the list.
  await ui.key('ctrl+2')
  await ui.until(() => listed().length > 0, 'the list open')
  await ui.key('escape')
  expect(Boolean($('.new-thread'))).toBe(true)
  expect(listed()).toEqual([])
})

it('sends the files picked in the prompt with the first message', async () => {
  const [project] = await folders('project')
  const local = await testDaemon({ model: 'echo' })
  daemons = [local]
  ui = await mountUi({ window: true, machines: [local] })
  await ui.key('mod+n')
  await ui.until(() => Boolean($('.new-thread [aria-label="Prompt"]')), 'the dialog')
  // One machine: it opens on the folder.
  expect(focused()).toBe('Folder')
  await ui.type('.new-thread [aria-label="Folder"]', project!)

  const picker = $<HTMLInputElement>('.new-thread input[type=file]')!
  const view = picker.ownerDocument.defaultView as unknown as typeof globalThis
  Object.defineProperty(picker, 'files', { configurable: true, value: [new view.File(['a note'], 'note.txt', { type: 'text/plain' })] })
  picker.dispatchEvent(new view.Event('change', { bubbles: true }))
  await ui.until(() => $('.new-thread .attachment__name')?.textContent === 'note.txt', 'the file waiting in the prompt')

  await ui.type('.new-thread [aria-label="Prompt"]', 'read this')
  await ui.key('enter')
  await ui.until(() => !$('.new-thread'), 'started')
  const [thread] = await local.call<{ id: string; cwd: string }[]>('thread.list', {})
  expect(thread!.cwd).toBe(project)
  await local.idle(thread!.id)
  const sent = (JSON.parse(await local.transcript(thread!.id)) as { kind: string; model?: { content: { type: string; text?: string }[] }[] }[])
    .find((e) => e.kind === MESSAGE_ENTRY)!.model![0]!.content
  expect(sent[0]?.text).toBe('read this')
  expect(sent.some((block) => block.text?.startsWith('<attachment name="note.txt"'))).toBe(true)
})
