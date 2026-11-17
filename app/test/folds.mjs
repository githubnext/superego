// Screenshots of the sidebar folded (run by `test/look.sh <dir> folds`): a project folded, a thread's offshoots folded
// under it, and Pinned, in light and dark. Into $SUPEREGO_SHOWCASE_OUT.
import { openApp } from './harness.mjs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

await openApp({ name: 'folds', timeout: 180_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1100, 600)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const site = join(process.env.SUPEREGO_HOME, 'site')
  mkdirSync(site, { recursive: true })
  const start = (cwd, title, parent) => run(`window.superego.call('local', 'thread.start', ${JSON.stringify({ cwd, title, ...(parent ? { parent } : {}) })}).then((t) => t.id)`)
  const ids = {}
  for (const [cwd, title, parent] of [
    [site, 'Fix the pricing page'], [site, 'Write the launch post'], [project, 'Import the bank export'], [project, 'Reconcile March'],
    [project, 'Match the receipts', 'Reconcile March'], [project, 'Flag the duplicates', 'Reconcile March'], [project, 'Tidy the categories'],
  ]) ids[title] = await start(cwd, title, parent && ids[parent])
  const row = (title) => `[...document.querySelectorAll('.threads-project:not(.threads-pinned) .superego-list-item')].find((li) => li.querySelector('.threads__title')?.textContent === ${JSON.stringify(title)})`
  await until(`Boolean(${row('Tidy the categories')})`, 'the threads listed')
  await run(`${row('Import the bank export')}.setAttribute('data-shot', '')`)
  await t.mouse('[data-shot]', { button: 'right' })
  await until(`Boolean([...document.querySelectorAll('.superego-menu__item')].find((i) => i.textContent.includes('Pin')))`, 'the row menu')
  await t.click('.superego-menu__item', 'Pin')
  await until(`Boolean(document.querySelector('.threads-pinned') && !document.querySelector('.superego-menu'))`, 'pinned, the menu closed')
  await run(`${row('Tidy the categories')}.click()`)
  await t.shot('folds-open', `document.querySelector('.app__sidebar')`)
  // The offshoots of Reconcile March folded under it; the site project folded.
  await run(`${row('Reconcile March')}.querySelector('.threads-caret').click()`)
  await until(`!${row('Match the receipts')}`, 'the offshoots folded')
  await run(`[...document.querySelectorAll('.threads-project')].find((s) => s.querySelector('.threads-project__name')?.textContent.startsWith('site')).querySelector('.threads-caret').click()`)
  await until(`!${row('Fix the pricing page')}`, 'the project folded')
  await t.both('folds')
  await t.shot('folds-sidebar', `document.querySelector('.app__sidebar')`)
})
