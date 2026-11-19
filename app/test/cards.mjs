// Screenshots of a thread's card (run by `test/look.sh <dir> cards`): a row pointed at in the sidebar (a thread in a
// worktree under another, working), one waiting on you, a folded parent's, and a rail dot's with the sidebar hidden; in
// light and dark. Into $SUPEREGO_SHOWCASE_OUT.
//
// The threads are the daemon's own, started here; what they run with and how they stand are dressed up on their way to
// the window (each thread's, by title, in `DRESS`), since a scripted model has no provider, cost or worktree to show.
import { ipcMain, app } from 'electron'
import { openApp } from './harness.mjs'

const now = Date.now()
const m = 60_000
const project = process.env.SUPEREGO_SHOWCASE_PROJECT
const profile = { name: 'staff', scope: 'project', dir: `${project}/.superego/profiles/staff` }
const DRESS = {
  'Chief of Staff': { status: { state: 'working' }, model: 'claude-opus-4-5', provider: 'anthropic', cost: 4.12, profile },
  'Threads list: small info hover cards on rows': {
    status: { state: 'working' }, quiet: true, model: 'claude-opus-4-5', provider: 'anthropic', cost: 1.87, profile, ago: 2 * m,
    facts: { worktrees: { branch: 'superego/threads-list-small-info-hover-cards-on-r-12ff05', path: '/tmp/hover-cards', root: project } },
  },
  'Title bar: provider icons': { status: { state: 'done', msg: 'Merged: the model shows as its provider' }, quiet: true, model: 'gpt-5', provider: 'openai-codex', cost: 0.64, ago: 6 * m },
  'Release notes for 0.9': { status: { state: 'blocked', kind: 'question', msg: 'Call it 0.9 or 1.0? The API broke once since 0.8.' }, model: 'gemini-2.5-pro', provider: 'google', cost: 0.21, ago: m },
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
    if (answer.ok && method === 'threads.watch') return { ...answer, result: { ...answer.result, value: dress(answer.result.value) } }
    return answer
  }
  : run)
app.on('web-contents-created', (_event, contents) => {
  const send = contents.send.bind(contents)
  contents.send = (channel, message, ...rest) => {
    if (channel === 'superego:event' && message?.method === 'threads.changed') message = { ...message, params: { ...message.params, value: dress(message.params.value) } }
    return send(channel, message, ...rest)
  }
})

await openApp({ name: 'cards', timeout: 180_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1100, 600)
  const ids = {}
  for (const [title, parent] of [
    ['Release notes for 0.9'], ['Chief of Staff'], ['Threads list: small info hover cards on rows', 'Chief of Staff'], ['Title bar: provider icons', 'Chief of Staff'],
  ]) ids[title] = await run(`window.superego.call('local', 'thread.start', ${JSON.stringify({ cwd: project, title, ...(parent ? { parent: ids[parent] } : {}) })}).then((t) => t.id)`)
  const row = (title) => `[...document.querySelectorAll('.threads-project .superego-list-item')].find((li) => li.querySelector('.threads__title')?.textContent === ${JSON.stringify(title)})`
  await until(`Boolean(${row('Title bar: provider icons')})`, 'the threads listed')
  await run(`${row('Release notes for 0.9')}.click()`)

  // The sidebar and the card beside it.
  const region = `({ getBoundingClientRect: () => { const c = document.querySelector('.superego-hover-card').getBoundingClientRect(); return { x: 0, y: 0, width: c.right + 24, height: Math.max(c.bottom, document.querySelector('.threads')?.getBoundingClientRect().bottom ?? 0) + 24 } } })`
  const point = async (selector, file, title) => {
    await t.hover(selector)
    await until(`document.querySelector('.superego-hover-card .thread-card__title')?.textContent === ${JSON.stringify(title)}`, `${title}'s card`)
    for (const theme of ['light', 'dark']) {
      await t.theme(theme)
      await t.shot(`${file}-${theme}`, region)
    }
    await t.hover('.thread__title')
    await until(`!document.querySelector('.superego-hover-card')`, 'the card gone')
  }
  const mark = (title) => run(`document.querySelector('[data-shot]')?.removeAttribute('data-shot'); ${row(title)}.setAttribute('data-shot', '')`)
  await mark('Threads list: small info hover cards on rows')
  await point('[data-shot]', 'cards-worktree', 'Threads list: small info hover cards on rows')
  await mark('Release notes for 0.9')
  await point('[data-shot]', 'cards-question', 'Release notes for 0.9')
  await run(`${row('Chief of Staff')}.querySelector('.threads-caret').click()`)
  await until(`!${row('Title bar: provider icons')}`, 'the offshoots folded')
  await mark('Chief of Staff')
  await point('[data-shot]', 'cards-folded', 'Chief of Staff')
  t.key('/')
  await until(`Boolean(document.querySelector('.threads-rail__dot'))`, 'the dots')
  await point('.threads-rail__dot[aria-label^="Release notes"]', 'cards-rail', 'Release notes for 0.9')
})
