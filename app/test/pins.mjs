// Screenshots of pinned threads (run by `test/look.sh <dir> pins`): threads in two projects, two of them pinned to the
// top of the sidebar, in light and dark; a row's right-click menu; the title bar's pin; the rail's dots with the
// sidebar hidden. Into $SUPEREGO_SHOWCASE_OUT.
import { openApp } from './harness.mjs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

await openApp({ name: 'pins', timeout: 180_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1100, 600)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const site = join(process.env.SUPEREGO_HOME, 'site')
  mkdirSync(site, { recursive: true })
  const start = (cwd, title) => run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(cwd)}, title: ${JSON.stringify(title)} }).then((t) => t.id)`)
  const ids = {}
  for (const [cwd, title] of [[project, 'Import the bank export'], [site, 'Fix the pricing page'], [project, 'Reconcile March'], [site, 'Write the launch post'], [project, 'Tidy the categories']]) {
    ids[title] = await start(cwd, title)
  }
  const row = (title) => `[...document.querySelectorAll('.superego-list-item')].find((li) => li.querySelector('.threads__title')?.textContent === ${JSON.stringify(title)})`
  await until(`Boolean(${row('Tidy the categories')})`, 'the threads listed')
  // Pinned from the row's menu, and from the title bar.
  // A real right-click, as Chromium sends it.
  await run(`${row('Reconcile March')}.setAttribute('data-shot', '')`)
  await t.mouse('[data-shot]', { button: 'right' })
  await until(`Boolean([...document.querySelectorAll('.superego-menu__item')].find((i) => i.textContent.includes('Pin')))`, 'the row menu')
  await t.shot('pins-menu')
  await t.click('.superego-menu__item', 'Pin')
  await until(`Boolean(document.querySelector('.threads-pinned') && !document.querySelector('.superego-menu'))`, 'pinned, the menu closed')
  await run(`${row('Write the launch post')}.click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'Write the launch post'`, 'the thread shown')
  await t.click('.app__titlebar .thread__pin')
  await until(`document.querySelectorAll('.threads-pinned .superego-list-item').length === 2`, 'two pinned')
  await t.both('pins')
  await t.shot('pins-sidebar', `document.querySelector('.app__sidebar')`)
  // The sidebar hidden: the pinned dots first.
  t.key('/')
  await until(`Boolean(document.querySelector('.threads-rail__dot'))`, 'the dots')
  await t.both('pins-rail')
})
