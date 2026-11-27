// The rail picks the whole window (run by `test/look.sh <dir> rail`): a thread with a pane in Threads; Pages (a sidebar
// whose profile declares spaces: test/showcase/rail) empty, then a page open; Threads again, its thread and pane back;
// Board, a rail button's space shown alone. One rail button lit in each, checked; light and dark, into
// $SUPEREGO_SHOWCASE_OUT.
import { openApp } from './harness.mjs'

await openApp({ name: 'rail', timeout: 240_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1300, 760)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const { id } = await t.call('thread.start', { cwd: project, title: 'Import the bank export' })
  await t.call('thread.start', { cwd: project, title: 'Monthly report' })
  const row = (title) => `[...document.querySelectorAll('.threads-project .superego-list-item')].find((li) => li.textContent.includes(${JSON.stringify(title)}))`
  await until(`Boolean(${row('Import the bank export')})`, 'listed')
  await run(`${row('Import the bank export')}.click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'Import the bank export'`, 'the thread shown')
  await t.call('pane.open', { thread: id, kind: 'folder', params: { path: '' } })
  await until(`Boolean(document.querySelector('.files-folder'))`, 'its pane')
  await until(`Boolean(document.querySelector('.app__rail [aria-label="Pages"]'))`, "the Pages profile's button")

  /** The rail's lit buttons, by label: exactly `want`. */
  const lit = async (want, what) => until(`JSON.stringify([...document.querySelectorAll('.app__rail .app__rail-button.is-on')].map((b) => b.getAttribute('aria-label'))) === ${JSON.stringify(JSON.stringify(want))}`, `${what}: only ${want} lit`)
  const sidebar = (want) => `document.querySelector('.app__sidebar')?.dataset.sidebar === ${JSON.stringify(want)}`
  const rail = (label) => run(`document.querySelector('.app__rail [aria-label="${label}"]').click()`)

  await lit(['Threads'], 'Threads')
  await t.both('rail-threads')

  await rail('Pages')
  await until(sidebar('pages.list'), "Pages' list")
  await until(`document.querySelector('.app__main')?.textContent.includes('Nothing open in Pages.')`, 'nothing open yet')
  await t.check(`!document.querySelector('.app__main .thread') && !document.querySelector('.files-folder')`, "the thread and its pane gone with Threads' section")
  await lit(['Pages'], 'Pages')
  await t.both('rail-pages-empty')

  await run(`[...document.querySelectorAll('.pages-list .superego-list-item')].find((li) => li.textContent.includes('roadmap')).click()`)
  await until(`Boolean(document.querySelector('.pages-page'))`, 'the page')
  await lit(['Pages'], 'a page')
  await t.both('rail-pages-page')

  await rail('Threads')
  await until(`document.querySelector('.thread__title')?.textContent === 'Import the bank export' && Boolean(document.querySelector('.files-folder'))`, 'the thread and its pane back')
  await lit(['Threads'], 'Threads again')
  await t.both('rail-threads-again')

  await rail('Board')
  await until(`Boolean(document.querySelector('.pages-board'))`, 'the board')
  await until(`!document.querySelector('.app__sidebar')`, 'no sidebar')
  await lit(['Board'], 'Board')
  await t.both('rail-board-alone')

  await rail('Pages')
  await until(`document.querySelector('.pages-page h1')?.textContent === 'roadmap'`, 'Pages as it was left')
  await lit(['Pages'], 'Pages again')
})
