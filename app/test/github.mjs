// Threads' pull requests (run by `test/look.sh <dir> github`), from a stand-in gh (showcase/github-setup.mjs): a thread
// that opens one (its `gh pr create` attaching it, its link drawn with its state), and threads with one attached by hand
// in every state. Shot in light and dark, into $SUPEREGO_SHOWCASE_OUT: the window with the pull-request pane beside the
// thread; the title bar's chip in each state; its menu; a row pointed at, with its card; the pane alone; thread
// details; Settings → GitHub.
import { openApp } from './harness.mjs'

const URL = (n) => `https://github.com/acme/ledger/pull/${n}`
/** The threads, oldest first, each with the pull request attached to it by hand (the last opens its own). */
const THREADS = [
  ['Commands in the phone drawer', 409, 'closed'],
  ['Mermaid diagrams via Pele', 414, 'draft'],
  ['UI playground', 417, 'merged'],
  ['Phone composer on one line', 415, 'approved'],
  ['Confirm and Prompt dialogs', 416, 'changes'],
  ['Resume programs after a restart', 420, 'passing'],
  ['Code blocks by language', 421, 'running'],
]
const MAIN = 'Mentions from extensions'
/** Its prompt, by which showcase/github-setup.mjs's turns name it. */
const OPENS = 'Open a PR for this.'

await openApp({ name: 'github', timeout: 300_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1500, 820)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const ids = {}
  for (const [title, number] of THREADS) {
    ids[title] = await run(`window.superego.call('local', 'thread.start', ${JSON.stringify({ cwd: project, title })}).then((t) => t.id)`)
    await t.call('action.run', { id: 'github.attach', params: { thread: ids[title], url: URL(number) } })
  }
  ids[MAIN] = await run(`window.superego.call('local', 'thread.start', ${JSON.stringify({ cwd: project, title: MAIN, prompt: OPENS })}).then((t) => t.id)`)
  const row = (title) => `[...document.querySelectorAll('.threads-project .superego-list-item')].find((li) => li.querySelector('.threads__title')?.textContent === ${JSON.stringify(title)})`
  await until(`Boolean(${row(MAIN)})`, 'the threads listed')
  await run(`${row(MAIN)}.click()`)
  await until(`document.querySelector('.thread__title')?.textContent === ${JSON.stringify(MAIN)}`, 'the thread shown')
  // Its `gh pr create` attached #418, and the poller has every pull request's state.
  await until(`document.querySelector('.github-chip')?.textContent.startsWith('#418')`, "the thread's pull request in the title bar", 60_000)
  await until(`[...document.querySelectorAll('.github-link')].some((a) => a.querySelector('.github-glyph.is-merged'))`, 'the merged link drawn with its state', 30_000)
  await until(`document.querySelectorAll('.threads-project .github-mark').length === ${THREADS.length}`, 'a mark on every row but the closed one', 30_000)

  // The window: the pane beside the thread.
  await t.call('pane.open', { thread: ids[MAIN], kind: 'pull-request', params: { url: URL(418) } })
  await until(`document.querySelector('.github-pane')?.textContent.includes('To do')`, 'the pane', 30_000)
  await t.both('github-window')

  // The pane alone.
  const pane = `document.querySelector('.github-pane').closest('[data-column]')`
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await t.shot(`github-pane-${theme}`, pane)
  }
  await run(`document.querySelector('.github-fold summary').click()`)
  await t.shot('github-pane-passed-dark', pane)

  // The chip in each state: the title bar from the thread's title to its end.
  const bar = `({ getBoundingClientRect: () => { const c = document.querySelector('.github-chip').getBoundingClientRect(); const b = document.querySelector('.thread__title').getBoundingClientRect(); return { x: b.left - 12, y: c.top - 10, width: c.right - b.left + 40, height: c.height + 20 } } })`
  for (const [title, , state] of [...THREADS, [MAIN, 418, 'failing']]) {
    await run(`${row(title)}.click()`)
    await until(`document.querySelector('.thread__title')?.textContent === ${JSON.stringify(title)} && Boolean(document.querySelector('.github-chip'))`, `${title}'s chip`)
    for (const theme of ['light', 'dark']) {
      await t.theme(theme)
      await t.shot(`github-chip-${state}-${theme}`, bar)
    }
  }

  // Its menu.
  const menu = `({ getBoundingClientRect: () => { const m = document.querySelector('.github-menu__head').closest('.superego-menu').getBoundingClientRect(); const c = document.querySelector('.github-chip').getBoundingClientRect(); return { x: Math.min(m.left, c.left) - 16, y: c.top - 10, width: Math.max(m.right, c.right) - Math.min(m.left, c.left) + 32, height: m.bottom - c.top + 26 } } })`
  // Open once, shot in both themes: a menu reopened at once may still be on its way out.
  await t.click('.github-chip')
  await until(`Boolean(document.querySelector('.github-menu__stage'))`, 'the menu')
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await t.shot(`github-menu-${theme}`, menu)
  }
  t.key('Escape', [])
  await until(`!document.querySelector('.github-menu__head')`, 'the menu closed')

  // A row pointed at, with its card: the sidebar and the card beside it.
  const card = `({ getBoundingClientRect: () => { const c = document.querySelector('.superego-hover-card').getBoundingClientRect(); return { x: 0, y: 0, width: c.right + 24, height: Math.max(c.bottom, document.querySelector('.threads')?.getBoundingClientRect().bottom ?? 0) + 24 } } })`
  for (const title of ['Confirm and Prompt dialogs', MAIN]) {
    await run(`document.querySelector('[data-shot]')?.removeAttribute('data-shot'); ${row(title)}.setAttribute('data-shot', '')`)
    await t.hover('[data-shot]')
    await until(`document.querySelector('.superego-hover-card .thread-card__title')?.textContent === ${JSON.stringify(title)} && Boolean(document.querySelector('.superego-hover-card .github-spelled'))`, `${title}'s card`)
    const file = title === MAIN ? 'github-card-failing' : 'github-card-changes'
    for (const theme of ['light', 'dark']) {
      await t.theme(theme)
      await t.shot(`${file}-${theme}`, card)
    }
    await t.hover('.thread__title')
    await until(`!document.querySelector('.superego-hover-card')`, 'the card gone')
  }

  // Settings → GitHub: gh signed in.
  await t.click('.app__settings')
  await until(`[...document.querySelectorAll('.settings__nav button')].some((b) => b.textContent.trim() === 'This computer')`, 'Settings')
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent.trim() === 'This computer').click()`)
  await until(`document.querySelector('.github-settings')?.textContent.includes('Signed in as mikker')`, 'Settings → GitHub')
  const section = `document.querySelector('.github-settings').closest('.settings-section')`
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await run(`${section}.scrollIntoView({ block: 'center' })`)
    await t.shot(`github-settings-${theme}`, section)
  }
})
