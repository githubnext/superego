// @vitest-environment happy-dom
// Mentions over a real daemon, in the window drawn whole: `@` in the composer offers another thread and the thread's
// files, taking one writes its mention, and the message goes with a block telling the agent what each mention is, which
// the transcript leaves out, drawing the mentions as links instead.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MESSAGE_ENTRY } from '@superego/protocol'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '@superego/sdk/testing'
import files from '@superego/files/daemon'
import filesUi from '@superego/files/ui'
import threads from '@superego/threads/ui'
import mentions from '../src/daemon.ts'
import mentionsUi from '../src/ui.tsx'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const offered = () => $$('.completions__item').map((item) => item.textContent)

let dir: string
let daemon: TestDaemon
let ui: TestWindow | undefined
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-mentions-'))
  await mkdir(join(dir, 'src'))
  await writeFile(join(dir, 'src', 'dates.ts'), 'export {}\n')
  await writeFile(join(dir, 'notes.md'), '# notes\n')
  daemon = await testDaemon({ model: 'echo', extensions: [files, mentions] })
})
afterEach(async () => { await ui?.unmount(); await daemon.close(); await rm(dir, { recursive: true, force: true }) })

it('completes a thread and a file, tells the agent what they are, and draws them as links', async () => {
  const other = await daemon.thread(undefined, { title: 'Dates land a day early', cwd: dir })
  const here = await daemon.thread(undefined, { title: 'Here', cwd: dir })
  ui = await mountUi({ window: true, extensions: [threads, filesUi, mentionsUi], machines: [daemon], select: { thread: here.id } })
  await ui.until(() => $('.thread__title')?.textContent === 'Here', 'the thread shown')

  await ui.type('.composer textarea', 'Compare @dat')
  await ui.until(() => offered().length === 2, 'the thread and the file offered')
  expect(offered()).toEqual(['Dates land a day early', 'dates.tssrc'])
  expect($('.completions')?.getAttribute('aria-label')).toBe('Mentions')
  await ui.key('enter')
  await ui.until(() => ($('.composer textarea') as HTMLTextAreaElement).value === `Compare @thread:${other.id} `, 'the thread taken')

  await ui.type('.composer textarea', `Compare @thread:${other.id} with @src/d`)
  await ui.until(() => offered()[0] === 'dates.tssrc', 'the file offered')
  await ui.key('tab')
  const text = `Compare @thread:${other.id} with @src/dates.ts `
  await ui.until(() => ($('.composer textarea') as HTMLTextAreaElement).value === text, 'the file taken')
  await ui.type('.composer textarea', `${text}and @someone`)
  await ui.key('enter')

  // The agent is told what each is; @someone named nothing there.
  await daemon.idle(here.id)
  const sent = (JSON.parse(await daemon.transcript(here.id)) as { kind: string; model?: { content: { type: string; text?: string }[] }[] }[])
    .find((e) => e.kind === MESSAGE_ENTRY)!.model![0]!.content
  expect(sent.map((block) => block.text)).toEqual([
    `Compare @thread:${other.id} with @src/dates.ts and @someone`,
    [
      '<mentions>',
      'The message mentions these. They aren\'t attached: read what you need.',
      `@thread:${other.id} is a thread: "Dates land a day early" (Idle). Read it with thread_read (thread: "${other.id}").`,
      '@src/dates.ts is a file, relative to this thread\'s folder.',
      '</mentions>',
    ].join('\n'),
  ])

  // In the transcript: the words, the thread by its title, the file as a link to it, the block left out.
  await ui.until(() => Boolean($('.msg .thread-ref')), 'the message drawn')
  const message = $('.thread-ref')!.closest('.msg, [class*="msg"]')!
  expect($('.thread-ref .thread-ref__title')?.textContent).toBe('Dates land a day early')
  expect($$('.md__file').map((link) => link.textContent)).toContain('@src/dates.ts')
  expect(message.textContent).toContain('and @someone')
  expect(message.textContent).not.toContain('<mentions>')
})

it('says a folder is one, and a thread that isn\'t there or on a machine out of reach, and sends nothing for no mention', async () => {
  const here = await daemon.thread(undefined, { title: 'Here', cwd: dir })
  const blocks = async (text: string) => {
    await daemon.call('thread.send', { thread: here.id, text })
    await daemon.idle(here.id)
    const entries = (JSON.parse(await daemon.transcript(here.id)) as { kind: string; model?: { content: string | { type: string; text?: string }[] }[] }[])
      .filter((e) => e.kind === MESSAGE_ENTRY)
    const content = entries.at(-1)!.model![0]!.content
    return typeof content === 'string' ? [content] : content.map((block) => block.text)
  }
  expect(await blocks('see @src, @thread:999 and @thread:nowhere/4')).toEqual(['see @src, @thread:999 and @thread:nowhere/4', [
    '<mentions>',
    'The message mentions these. They aren\'t attached: read what you need.',
    '@src is a folder, relative to this thread\'s folder.',
    '@thread:999 is a thread, thread 999, which isn\'t there.',
    '@thread:nowhere/4 is a thread on nowhere, a machine this one doesn\'t reach.',
    '</mentions>',
  ].join('\n')])
  expect(await blocks('mail me@host or @nobody, not @/etc/hosts')).toEqual(['mail me@host or @nobody, not @/etc/hosts'])
})
