// Screenshots of every thread state as the window draws it (run by `test/look.sh <dir> states`): the sidebar (unread
// titles semibold, the word for what a thread waits on, the wave while it works, quiet offshoots, a folded parent's
// roll-up, pinned, an offline machine's project), the rail with the sidebar hidden, the title bar for a thread working,
// asking and failed, and ⌘U; in light and dark. Into $SUPEREGO_SHOWCASE_OUT.
//
// The threads are the daemon's own, started here; their statuses are dressed up on their way to the window (each
// thread's, by title, in `DRESS`), since a scripted model can't hold a thread in each state at once. Another machine,
// `workbox`, is made up the same way: connected long enough for its threads to be heard, then offline.
import { ipcMain, app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openApp } from './harness.mjs'

const now = Date.now()
const m = 60_000
/** Each thread's status as shown, by title: `ago`, how long since it was active; `quiet`, it reports to its parent. */
const DRESS = {
  'Chief of Staff': { status: { state: 'working' } },
  'Design: one language for thread states': { status: { state: 'working' }, quiet: true },
  'Threads list: collapse projects': { status: { state: 'working' }, quiet: true },
  'Release notes for 0.9': { status: { state: 'blocked', kind: 'permission', msg: 'Run `git push origin v0.9`?' }, quiet: true, ago: m },
  'Pinned threads stay in their projects': { status: { state: 'done', msg: 'Pinned threads stay at the top of their projects' }, quiet: true, ago: 6 * m },
  '@ mentions in the composer': { status: { state: 'done', msg: 'Mentions offer threads and files; 14 tests added' }, ago: 4 * m },
  'Smoke split by area': { status: { state: 'error', msg: 'check.ts stopped it after 8 minutes' }, ago: 12 * m },
  'Fix flaky sync test': { status: { state: 'working' } },
  'Onboarding copy pass': { status: { state: 'blocked', kind: 'auth', msg: 'Anthropic rejected the API key' }, ago: 20 * m },
  'Rename settings tabs': { status: { state: 'idle' }, ago: 120 * m },
  'Staff board': { status: { state: 'idle' }, ago: 5 * m },
  'Lint pass': { status: { state: 'working' }, quiet: true },
  'Picker keys': { status: { state: 'done', msg: 'Picker keys go both ways' }, ago: m },
  'Design: the staff board as an overview': { status: { state: 'blocked', kind: 'question', msg: 'Which wave should the board open on?' }, ago: 2 * m },
  'Sentry overview': { status: { state: 'idle' }, ago: 180 * m },
}
const dress = (list) => list.map((thread) => {
  const as = DRESS[thread.title]
  if (!as) return thread
  const { ago = 0, quiet, ...rest } = as
  return { ...thread, ...rest, ...(quiet ? { quiet: true } : {}), activeAt: now - ago }
})

// workbox: a machine of make-believe, with a project of its own.
const workbox = { id: 'workbox', label: 'workbox', state: 'connected', features: [], extensions: [] }
const tremolo = { root: '/home/me/tremolo', name: 'tremolo' }
const WORKBOX = [
  { id: 'wb1', title: 'Bench: live CSS knobs', cwd: tremolo.root, createdAt: now - 3 * 3_600_000, activeAt: now, project: tremolo, status: { state: 'working' } },
  { id: 'wb2', title: 'Page links in the editor', cwd: tremolo.root, createdAt: now - 3 * 86_400_000, activeAt: now - 86_400_000, project: tremolo, status: { state: 'idle' } },
]
const withWorkbox = (list) => [...list.filter((machine) => machine.id !== 'workbox'), workbox]

// The window's calls and events, dressed on their way: set up before the app's own handlers are.
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, run) => handle(channel, channel === 'superego:machines'
  ? async (...args) => withWorkbox(await run(...args))
  : channel === 'superego:call'
    ? async (event, machine, method, params) => {
      if (machine === 'workbox') {
        const value = method === 'threads.watch' ? (params?.hidden ? [] : WORKBOX) : null
        return { ok: true, result: method.endsWith('.watch') ? { sub: `workbox-${method}`, value } : null }
      }
      const answer = await run(event, machine, method, params)
      if (answer.ok && method === 'threads.watch') return { ...answer, result: { ...answer.result, value: dress(answer.result.value) } }
      return answer
    }
    : run)
app.on('web-contents-created', (_event, contents) => {
  const send = contents.send.bind(contents)
  contents.send = (channel, message, ...rest) => {
    if (channel === 'superego:event' && message?.method === '$machines') message = { ...message, params: withWorkbox(message.params) }
    if (channel === 'superego:event' && message?.method === 'threads.changed') message = { ...message, params: { ...message.params, value: dress(message.params.value) } }
    return send(channel, message, ...rest)
  }
})

await openApp({ name: 'states', timeout: 240_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1200, 760)
  const home = process.env.SUPEREGO_HOME
  const superego = join(home, 'superego')
  const tuna = join(home, 'tuna')
  for (const dir of [superego, tuna]) mkdirSync(dir, { recursive: true })
  const ids = {}
  const start = async (cwd, title, parent) => {
    ids[title] = await run(`window.superego.call('local', 'thread.start', ${JSON.stringify({ cwd, title, ...(parent ? { parent: ids[parent] } : {}) })}).then((t) => t.id)`)
  }
  for (const [cwd, title, parent] of [
    [superego, 'Rename settings tabs'], [superego, 'Onboarding copy pass'], [superego, 'Fix flaky sync test'], [superego, 'Smoke split by area'],
    [superego, '@ mentions in the composer'], [superego, 'Chief of Staff'],
    [superego, 'Pinned threads stay in their projects', 'Chief of Staff'], [superego, 'Release notes for 0.9', 'Chief of Staff'],
    [superego, 'Threads list: collapse projects', 'Chief of Staff'], [superego, 'Design: one language for thread states', 'Chief of Staff'],
    [tuna, 'Sentry overview'], [tuna, 'Design: the staff board as an overview'], [tuna, 'Staff board'],
    [tuna, 'Picker keys', 'Staff board'], [tuna, 'Lint pass', 'Staff board'],
  ]) await start(cwd, title, parent)

  const row = (title) => `[...document.querySelectorAll('.threads-project:not(.threads-pinned) .superego-list-item')].find((li) => li.querySelector('.threads__title')?.textContent === ${JSON.stringify(title)})`
  await until(`Boolean(${row('Lint pass')}) && Boolean(${row('Page links in the editor')})`, 'the threads listed, workbox\'s too')
  // workbox goes away: its project stays, the last thing known.
  workbox.state = 'offline'
  t.contents().send('superego:event', { machine: 'app', method: '$machines', params: await run(`window.superego.machines()`) })
  await until(`Boolean(document.querySelector('.threads-project.is-stale'))`, 'workbox offline')

  // Pinned: the board's question, from its project.
  await run(`${row('Design: the staff board as an overview')}.setAttribute('data-shot', '')`)
  await t.mouse('[data-shot]', { button: 'right' })
  await until(`Boolean([...document.querySelectorAll('.superego-menu__item')].find((i) => i.textContent.includes('Pin')))`, 'the row menu')
  await t.click('.superego-menu__item', 'Pin')
  await until(`Boolean(document.querySelector('.threads-pinned') && !document.querySelector('.superego-menu'))`, 'pinned, the menu closed')
  await run(`document.querySelector('[data-shot]')?.removeAttribute('data-shot')`)
  // The staff board's offshoots folded: one working, one new.
  await run(`${row('Staff board')}.querySelector('.threads-caret').click()`)
  await until(`!${row('Lint pass')}`, 'the offshoots folded')

  const both = async (file, element, before) => {
    for (const theme of ['light', 'dark']) {
      await t.theme(theme)
      if (before) await before()
      await t.shot(`${file}-${theme}`, element)
    }
  }
  const select = async (title) => {
    await run(`${row(title)}.click()`)
    await until(`document.querySelector('.thread__title')?.textContent === ${JSON.stringify(title)}`, `${title} shown`)
  }
  const titlebar = `document.querySelector('.app__titlebar')`

  await select('Design: one language for thread states')
  await both('states-window')
  await both('states-sidebar', `document.querySelector('.app__sidebar')`)
  for (const [file, title] of [['working', 'Fix flaky sync test'], ['question', 'Design: the staff board as an overview'], ['failed', 'Smoke split by area']]) {
    await select(title)
    await both(`states-titlebar-${file}`, titlebar)
  }
  // ⌘U: what's unread, most pressing first.
  await select('Rename settings tabs')
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    t.key('u')
    await until(`document.querySelectorAll('.unread-list li').length > 0`, 'the unread list')
    await t.shot(`states-unread-${theme}`, `document.querySelector('.unread-list')`)
    t.key('Escape', [])
    await until(`!document.querySelector('.unread-list')`, 'the unread list closed')
  }
  // The sidebar hidden: the threads as marks in the rail.
  t.key('/')
  await until(`Boolean(document.querySelector('.threads-rail__dot'))`, 'the rail\'s marks')
  await both('states-rail', `document.querySelector('.app__rail')`)
  await t.theme('system')
})
