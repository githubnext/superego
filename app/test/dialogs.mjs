// Screenshots of the input dialogs (run by `test/look.sh <dir> dialogs`): the command palette (⌘K), browsing and with
// nothing matching; the navigator (⌘L), browsing, with archived threads (⌥A) and searched; the pane picker (⌘⇧P); ⌘N's
// fields; in light and dark. Into $SUPEREGO_SHOWCASE_OUT.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openApp } from './harness.mjs'

await openApp({ name: 'dialogs', timeout: 180_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1100, 720)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const site = join(process.env.SUPEREGO_HOME, 'site')
  mkdirSync(site, { recursive: true })
  const start = (cwd, title) => run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(cwd)}, title: ${JSON.stringify(title)} }).then((t) => t.id)`)
  const ids = {}
  for (const [cwd, title] of [[project, 'Import the bank export'], [site, 'Fix the pricing page'], [project, 'Reconcile March'], [site, 'Write the launch post'],
    [project, 'Tidy the categories'], [project, 'Reconcile February'], [site, 'Old landing page copy']]) {
    ids[title] = await start(cwd, title)
  }
  for (const title of ['Reconcile February', 'Old landing page copy']) await t.call('thread.archive', { thread: ids[title] })
  const row = (title) => `[...document.querySelectorAll('.superego-list-item')].find((li) => li.querySelector('.threads__title')?.textContent === ${JSON.stringify(title)})`
  await until(`Boolean(${row('Tidy the categories')}) && !${row('Reconcile February')}`, 'the threads listed')
  await run(`${row('Reconcile March')}.click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'Reconcile March'`, 'the thread shown')
  await t.click('.app__titlebar .thread__pin')
  await until(`document.querySelectorAll('.threads-pinned .superego-list-item').length === 1`, 'pinned')
  await t.call('pane.open', { thread: ids['Reconcile March'], kind: 'diff' })
  await until(`Boolean(document.querySelector('.git-changes, .diff-file, .panes__column:not(.panes__column--thread)'))`, 'a pane beside the thread')

  const input = `document.querySelector('.superego-dialog input')`
  const type = (text) => t.type('.superego-dialog input', text)
  const close = async () => {
    await run(`${input}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await until(`!document.querySelector('.superego-dialog')`, 'the dialog closed')
  }

  // ⌘K: the commands, browsing; then a search that finds nothing.
  t.key('k')
  await until(`document.activeElement === ${input} && document.querySelectorAll('.palette__list [role=option]').length > 3`, 'the palette')
  await t.both('palette')
  await run(`${input}.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`)
  await t.both('palette-moved')
  await type('zzqx')
  await until(`Boolean(document.querySelector('.palette__none'))`, 'nothing matches')
  await t.both('palette-none')
  await close()

  // ⌘L: the tree; with the archived threads; searched.
  t.key('l')
  await until(`document.activeElement === ${input} && Boolean(document.querySelector('.navigator'))`, 'the navigator')
  await t.both('navigator')
  t.key('a', ['alt'])
  await until(`[...document.querySelectorAll('.navigator [role=option]')].some((o) => o.textContent.includes('Reconcile February'))`, 'archived threads in the navigator')
  await t.both('navigator-archived')
  await type('reconcile')
  await until(`document.querySelectorAll('.navigator [role=option]').length >= 2`, 'searched')
  await t.both('navigator-search')
  await close()

  // ⌘⇧P: the panes to open beside the thread.
  t.key('p', ['meta', 'shift'])
  await until(`document.activeElement === ${input} && Boolean(document.querySelector('.pane-picker [role=option]'))`, 'the pane picker')
  await t.both('pane-picker')
  await close()

  // ⌘N: a dialog of fields, the prompt's focused.
  t.key('n')
  await until(`Boolean(document.querySelector('.new-thread .composer textarea'))`, 'the new thread dialog')
  await t.both('new-thread')
  t.key('Escape', [])
  await until(`!document.querySelector('.new-thread')`, 'the new thread dialog closed')
  console.log(`dialogs: done in ${process.env.SUPEREGO_SHOWCASE_OUT}`)
})
