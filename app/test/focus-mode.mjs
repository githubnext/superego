// Screenshots of focus mode (run by `test/look.sh <dir> focus-mode`): threads in three projects, two of them (one with
// its sub-threads) in focus; the mode off, their faint ◎ after their titles; a row's menu with Focus; the ◎'s menu in
// the sidebar's heading; the mode on, the list narrowed to them and to what needs you, "Show N more" at its end; for an
// hour, its ring draining and the minutes left in the heading; and a phone's drawer, on and off. In light and dark. Into $SUPEREGO_SHOWCASE_OUT.
//
// The threads are the daemon's own, started here; their statuses are dressed on their way to the window (by title, in
// `DRESS`), as states.mjs does: a scripted model can't hold threads waiting on you.
import { ipcMain, app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openApp } from './harness.mjs'

const now = Date.now()
const m = 60_000
const DRESS = {
  'Fix the date parsing in the importer': { status: { state: 'done', msg: 'Fixed, and both tests pass' } },
  'Check the Danske export': { status: { state: 'working' }, quiet: true },
  'Migrate the imported rows': { status: { state: 'blocked', kind: 'permission', msg: 'Run the migration?' }, quiet: true },
  'Tidy the date helpers': { status: { state: 'working' }, quiet: true },
  'Reconcile March': { status: { state: 'idle' }, ago: 50 * m },
  'Tidy the categories': { status: { state: 'idle' }, ago: 3 * 60 * m },
  'Write the launch post': { status: { state: 'working' } },
  'Fix the pricing page': { status: { state: 'blocked', kind: 'question', msg: 'Monthly or yearly first?' }, ago: 4 * m },
  'Update the pricing copy': { status: { state: 'idle' }, ago: 2 * 60 * m },
  'Speed up the test suite': { status: { state: 'error', msg: 'The suite timed out' }, ago: 9 * m },
  'Rename settings tabs': { status: { state: 'idle' }, ago: 26 * 60 * m },
}
const dress = (list) => list.map((thread) => {
  const as = DRESS[thread.title]
  if (!as) return thread
  const { ago = 0, quiet, ...rest } = as
  return { ...thread, ...rest, ...(quiet ? { quiet: true } : {}), activeAt: now - ago }
})
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, run) => handle(channel, channel === 'superego:call'
  ? async (event, machine, method, params) => {
    const answer = await run(event, machine, method, params)
    if (answer.ok && method === 'threads.watch' && !params?.hidden) return { ...answer, result: { ...answer.result, value: dress(answer.result.value) } }
    return answer
  }
  : run)
app.on('web-contents-created', (_event, contents) => {
  const send = contents.send.bind(contents)
  contents.send = (channel, message, ...rest) => {
    if (channel === 'superego:event' && message?.method === 'threads.changed' && Array.isArray(message.params?.value)) message = { ...message, params: { ...message.params, value: dress(message.params.value) } }
    return send(channel, message, ...rest)
  }
})

await openApp({ name: 'focus-mode', timeout: 240_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1100, 640)
  const home = process.env.SUPEREGO_HOME
  const ledger = process.env.SUPEREGO_SHOWCASE_PROJECT
  const site = join(home, 'site')
  const superego = join(home, 'superego')
  for (const dir of [site, superego]) mkdirSync(dir, { recursive: true })
  const ids = {}
  for (const [cwd, title, parent] of [
    [superego, 'Rename settings tabs'], [ledger, 'Tidy the categories'], [site, 'Update the pricing copy'], [ledger, 'Reconcile March'],
    [superego, 'Speed up the test suite'], [site, 'Fix the pricing page'], [site, 'Write the launch post'],
    [ledger, 'Fix the date parsing in the importer'], [ledger, 'Check the Danske export', 'Fix the date parsing in the importer'],
    [ledger, 'Migrate the imported rows', 'Fix the date parsing in the importer'], [ledger, 'Tidy the date helpers', 'Fix the date parsing in the importer'],
  ]) ids[title] = await run(`window.superego.call('local', 'thread.start', ${JSON.stringify({ cwd, title, ...(parent ? { parent: ids[parent] } : {}) })}).then((t) => t.id)`)

  const row = (title) => `[...document.querySelectorAll('.threads-project:not(.threads-pinned) .superego-list-item')].find((li) => li.querySelector('.threads__title')?.textContent === ${JSON.stringify(title)})`
  const item = (text) => `[...document.querySelectorAll('.superego-menu__item')].find((i) => i.querySelector('.superego-menu__text')?.textContent === ${JSON.stringify(text)})`
  await until(`Boolean(${row('Tidy the date helpers')}) && Boolean(${row('Rename settings tabs')})`, 'the threads listed')
  const select = async (title) => {
    await run(`${row(title)}.click()`)
    await until(`document.querySelector('.thread__title')?.textContent === ${JSON.stringify(title)}`, `${title} shown`)
  }

  // Focused from a row's menu (its sub-threads with it), and the one shown from ⌘⌥F.
  await select('Fix the date parsing in the importer')
  await run(`${row('Fix the date parsing in the importer')}.setAttribute('data-shot', '')`)
  await t.mouse('[data-shot]', { button: 'right' })
  await until(`Boolean(${item('Focus')})`, 'the row menu')
  await t.both('focus-mode-row-menu')
  await run(`${item('Focus')}.click()`)
  await run(`document.querySelector('[data-shot]')?.removeAttribute('data-shot')`)
  await until(`Boolean(${row('Tidy the date helpers')}?.querySelector('.focus-glyph'))`, 'focused, with its sub-threads')
  await select('Write the launch post')
  t.key('f', ['meta', 'alt'])
  await until(`Boolean(${row('Write the launch post')}?.querySelector('.focus-glyph'))`, 'focused from ⌘⌥F')
  await select('Fix the date parsing in the importer')
  await t.both('focus-mode-off')

  // The ◎'s menu, then on: the list narrowed.
  await run(`document.querySelector('.focus-button').click()`)
  await until(`Boolean(${item('Focus for 1 hour')})`, 'the ◎ menu')
  await t.both('focus-mode-menu')
  await run(`${item('Focus mode')}.click()`)
  await until(`document.querySelector('.threads__head > span')?.textContent === 'Focus' && !${row('Reconcile March')}`, 'focus mode on')
  await t.both('focus-mode-on')
  // Off with ⌘⇧F, then for an hour: the ring drains.
  t.key('f', ['meta', 'shift'])
  await until(`Boolean(${row('Reconcile March')})`, 'off again')
  await run(`document.querySelector('.focus-button').click()`)
  await until(`Boolean(${item('Focus for 1 hour')})`, 'the ◎ menu again')
  await run(`${item('Focus for 1 hour')}.click()`)
  await until(`document.querySelector('.focus-button')?.getAttribute('aria-label')?.startsWith('Focus mode: 60 min')`, 'on for an hour')
  // 37 minutes on, as if.
  await run(`window.superego.call('app', 'app.settings.set', { key: 'focus.until', value: Date.now() + 22.5 * 60_000 })`)
  await until(`document.querySelector('.focus-left')?.textContent === '23 min'`, '23 minutes left')
  await t.both('focus-mode-hour')

  // A phone: the drawer, narrowed.
  await t.resize(600, 640)
  await t.zoom(1.6)
  await run(`document.querySelector('.app__mobilebar button')?.click()`)
  await until(`Boolean(document.querySelector('.app__drawer .focus-button.is-on'))`, 'the drawer, focus on')
  await t.both('focus-mode-phone')
  t.key('f', ['meta', 'shift'])
  await until(`Boolean(${row('Reconcile March')})`, 'the drawer, everything')
  await t.both('focus-mode-phone-off')
  await t.zoom(1)
})
