// @vitest-environment happy-dom
// A thread in the window drawn whole (superego/testing's mountUi) over a real daemon: started from ⌘N's dialog, your
// messages as Markdown, an archived one read only until unarchived. (A thread whose profile is gone: window-profile.test.ts.)
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '../../sdk/src/testing.ts'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const titled = () => $('.thread__title')?.textContent
const transcript = () => $('.transcript')?.textContent ?? ''

let daemon: TestDaemon
let ui: TestWindow
beforeEach(async () => { daemon = await testDaemon({ model: 'echo' }) })
afterEach(async () => { await ui?.unmount(); await daemon.close() })

it('starts a thread from ⌘N with its prompt, refusing a folder that isn’t there', async () => {
  ui = await mountUi({ window: true, machines: [daemon] })
  await ui.key('mod+n')
  await ui.until(() => Boolean($('.new-thread [aria-label="Prompt"]')), 'the new thread dialog')
  await ui.type('.new-thread [aria-label="Folder"]', '/nowhere/at/all')
  await ui.type('.new-thread [aria-label="Prompt"]', 'hello from the dialog')
  $$('.new-thread button').find((b) => b.textContent?.startsWith('Start'))!.click()
  await ui.until(() => Boolean($('.new-thread__error')?.textContent?.includes('No folder')), 'the missing folder refused')
  await ui.type('.new-thread [aria-label="Folder"]', daemon.dataDir)
  await ui.key('mod+enter')
  await ui.until(() => !$('.new-thread') && transcript().includes('echo: hello from the dialog'), 'started with the prompt')
})

it('reads your messages as Markdown, each newline kept', async () => {
  const thread = await daemon.thread(undefined, { title: 'said' })
  ui = await mountUi({ window: true, machines: [daemon], select: { thread: thread.id } })
  // Code, a highlighted block; a lone * stays. (A thread link in it: the threads extension's window test.)
  await daemon.call('thread.send', { thread: thread.id, text: `From [this thread](thread:${thread.id}):\nrun \`pnpm test\` * twice\n\n\`\`\`ts\nconst a = 1\n\`\`\`` })
  const said = () => $$('.msg--user').at(-1)
  await ui.until(() => Boolean(said()?.querySelector('pre code.is-highlighted span')), 'the message drawn, its code highlighted')
  const message = said()!
  expect(message.querySelector('p br')).not.toBeNull()
  expect(message.querySelector('p code')?.textContent).toBe('pnpm test')
  expect(message.textContent).toContain(' * twice')
})

it('shows an archived thread read only, with Unarchive where Send would be', async () => {
  const thread = await daemon.thread('an old one', { title: 'old' })
  await daemon.call('thread.archive', { thread: thread.id })
  ui = await mountUi({ window: true, machines: [daemon], select: { thread: thread.id } })
  const textarea = () => $('.composer textarea') as HTMLTextAreaElement
  await ui.until(() => titled() === 'old' && Boolean($('.titlebar__archived')) && textarea()?.disabled && Boolean($('.composer__unarchive')), 'the archived thread, read only')
  $('.composer__unarchive')!.click()
  await ui.until(() => titled() === 'old' && !$('.titlebar__archived') && !textarea().disabled, 'unarchived, and shown')
  expect((await daemon.call<{ id: string }[]>('thread.list', {})).some((t) => t.id === thread.id)).toBe(true)
})
