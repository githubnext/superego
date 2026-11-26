// @vitest-environment happy-dom
// Mentions over a real daemon, in the window drawn whole: `@` in the composer offers another thread and the thread's
// files, taking one writes its mention, and the message goes with a block telling the agent what each mention is, which
// the transcript leaves out, drawing the mentions as links instead.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { MESSAGE_ENTRY } from '@superego/protocol'
import { defineDaemonExtension } from '@superego/daemon'
import { defineUiExtension } from '@superego/app/ui'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '@superego/sdk/testing'
import files from '@superego/files/daemon'
import filesUi from '@superego/files/ui'
import threads from '@superego/threads/ui'
import mentions from '../src/daemon.ts'
import mentionsUi from '../src/ui.tsx'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const offered = () => $$('.completions__item').map((item) => item.textContent)

/** An extension of canvases: `@` offers them, its daemon half says what one is, and its links open them. */
const titles: Record<string, string> = { 'fox-and-rhino': 'Fox and rhino', 'Shoes & socks': 'Shoes & socks' }
const opened: string[] = []
const CanvasIcon = ({ size }: { size?: number }) => createElement('svg', { 'data-icon': 'canvas', width: size })
const canvasUi = defineUiExtension({
  name: 'canvas',
  setup(superego) {
    superego.composer.mention({
      kind: 'canvas', title: 'Canvases', icon: CanvasIcon,
      list: () => [{ id: 'fox-and-rhino', label: 'Fox and rhino', detail: 'Sketches' }, { id: 'Shoes & socks', label: 'Shoes & socks' }],
    })
    superego.link({ match: 'canvas:', open: (href) => { opened.push(href) } })
  },
})
const canvas = defineDaemonExtension({
  name: 'canvas',
  setup(superego) {
    superego.mention('canvas', ({ id }) => {
      if (id === 'slow') return new Promise((resolve) => setTimeout(() => resolve('too late'), 1_000))
      if (id === 'broken') throw new Error('no canvas today')
      return titles[id] ? `${JSON.stringify(titles[id])}. Read it with canvas_read (id: ${JSON.stringify(id)}).` : undefined
    })
  },
})

let dir: string
let daemon: TestDaemon
let ui: TestWindow | undefined
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-mentions-'))
  await mkdir(join(dir, 'src'))
  await writeFile(join(dir, 'src', 'dates.ts'), 'export {}\n')
  await writeFile(join(dir, 'notes.md'), '# notes\n')
  daemon = await testDaemon({ model: 'echo', extensions: [files, mentions, canvas], mentionLimit: 300 })
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

it("completes in the New thread dialog too, before there's a thread: the folder's files, and threads", async () => {
  const other = await daemon.thread(undefined, { title: 'Dates land a day early', cwd: dir })
  ui = await mountUi({ window: true, extensions: [threads, filesUi, mentionsUi], machines: [daemon] })
  await ui.key('mod+n')
  await ui.until(() => Boolean($('.new-thread [aria-label="Prompt"]')), 'the dialog')
  await ui.type('.new-thread [aria-label="Folder"]', dir)
  await ui.type('.new-thread [aria-label="Prompt"]', 'Look at @dat')
  await ui.until(() => offered().length === 2, 'the thread and the file in that folder offered')
  expect(offered()).toEqual(['Dates land a day early', 'dates.tssrc'])
  await ui.key('down')
  await ui.key('enter')
  await ui.until(() => ($('.new-thread [aria-label="Prompt"]') as HTMLTextAreaElement).value === 'Look at @src/dates.ts ', 'the file taken')
  // Taken, ⏎ starts the thread, the mention told the agent.
  await ui.key('enter')
  await ui.until(() => !$('.new-thread'), 'started')
  const started = (await daemon.call<{ id: string }[]>('thread.list', {})).find((t) => t.id !== other.id)!
  await daemon.idle(started.id)
  const sent = (JSON.parse(await daemon.transcript(started.id)) as { kind: string; model?: { content: { type: string; text?: string }[] }[] }[])
    .find((e) => e.kind === MESSAGE_ENTRY)!.model![0]!.content
  expect(sent.map((block) => block.text)).toEqual(['Look at @src/dates.ts', expect.stringContaining("@src/dates.ts is a file, relative to this thread's folder.")])
})

/** The blocks the newest message in `thread` gave the agent. */
const lastSent = async (thread: string) => {
  const entries = (JSON.parse(await daemon.transcript(thread)) as { kind: string; model?: { content: string | { type: string; text?: string }[] }[] }[])
    .filter((e) => e.kind === MESSAGE_ENTRY)
  const content = entries.at(-1)!.model![0]!.content
  return typeof content === 'string' ? [content] : content.map((block) => block.text)
}

it("completes an extension's things, tells the agent what they are, and draws them as its links", async () => {
  const here = await daemon.thread(undefined, { title: 'Here', cwd: dir })
  ui = await mountUi({ window: true, extensions: [threads, filesUi, mentionsUi, canvasUi], machines: [daemon], select: { thread: here.id } })
  await ui.until(() => $('.thread__title')?.textContent === 'Here', 'the thread shown')

  await ui.type('.composer textarea', 'Draw @can')
  await ui.until(() => offered().length === 2, 'the canvases offered')
  expect(offered()).toEqual(['Fox and rhinoSketches', 'Shoes & socksCanvases'])
  expect($$('.completions__icon svg[data-icon="canvas"]')).toHaveLength(2)
  await ui.key('enter')
  await ui.until(() => ($('.composer textarea') as HTMLTextAreaElement).value === 'Draw @canvas:fox-and-rhino ', 'the canvas taken')

  // `@canvas:` offers canvases alone; the one with a space in its name is taken quoted.
  await ui.type('.composer textarea', 'Draw @canvas:fox-and-rhino with @canvas:sh')
  await ui.until(() => offered()[0] === 'Shoes & socksCanvases', 'the canvas offered')
  await ui.key('tab')
  const text = 'Draw @canvas:fox-and-rhino with @canvas:"Shoes & socks" '
  await ui.until(() => ($('.composer textarea') as HTMLTextAreaElement).value === text, 'the quoted canvas taken')
  await ui.type('.composer textarea', `${text}but not @canvas:missing`)
  await ui.key('enter')

  await daemon.idle(here.id)
  expect(await lastSent(here.id)).toEqual([
    'Draw @canvas:fox-and-rhino with @canvas:"Shoes & socks" but not @canvas:missing',
    [
      '<mentions>',
      'The message mentions these. They aren\'t attached: read what you need.',
      '@canvas:fox-and-rhino is a canvas: "Fox and rhino". Read it with canvas_read (id: "fox-and-rhino").',
      '@canvas:"Shoes & socks" is a canvas: "Shoes & socks". Read it with canvas_read (id: "Shoes & socks").',
      '</mentions>',
    ].join('\n'),
  ])

  // In the transcript: each as a link its extension opens, the one that named nothing as typed, the block left out.
  await ui.until(() => $$('.msg a').some((a) => a.textContent === '@canvas:fox-and-rhino'), 'the message drawn')
  const links = $$('.msg a').filter((a) => a.textContent?.startsWith('@canvas:'))
  expect(links.map((a) => a.textContent)).toEqual(['@canvas:fox-and-rhino', '@canvas:"Shoes & socks"'])
  const message = links[0]!.closest('.msg, [class*="msg"]')!
  expect(message.textContent).toContain('but not @canvas:missing')
  expect(message.textContent).not.toContain('<mentions>')
  await ui.window!.click('@canvas:"Shoes & socks"')
  expect(opened).toEqual(['canvas:Shoes%20%26%20socks'])
})

it("sends a mention whose resolver is slow, fails or isn't there as written, and holds up the others for none of it", async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const here = await daemon.thread(undefined, { title: 'Here', cwd: dir })
  const send = async (text: string) => {
    await daemon.call('thread.send', { thread: here.id, text })
    await daemon.idle(here.id)
    return lastSent(here.id)
  }
  expect(await send('@canvas:slow, @canvas:broken, @canvas:fox-and-rhino and @ink:x')).toEqual([
    '@canvas:slow, @canvas:broken, @canvas:fox-and-rhino and @ink:x',
    expect.stringContaining('@canvas:fox-and-rhino is a canvas: "Fox and rhino".'),
  ])
  expect((await lastSent(here.id))[1]!.split('\n')).toHaveLength(4)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('Extension canvas: resolving @canvas:slow took over 0.3s'))
  expect(error).toHaveBeenCalledWith(expect.stringContaining('Extension canvas: resolving @canvas:broken failed'), expect.any(Error))
  // A thread that goes without the extension: its mentions name nothing.
  await daemon.call('settings.set', { key: 'extensions.canvas', value: false })
  expect(await send('@canvas:fox-and-rhino')).toEqual(['@canvas:fox-and-rhino'])
})
