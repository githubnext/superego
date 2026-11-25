// A folder pane's New file (run by `test/look.sh <dir> files`): its buttons on the pane's tab, the name typed in place
// in a folder, the same name refused there, and the file it made open in the editor, its text focused; light and dark,
// cropped to the pane, into $SUPEREGO_SHOWCASE_OUT. Checks on the way that nothing is made over what's there.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openApp } from './harness.mjs'

await openApp({ name: 'files', timeout: 240_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1500, 760)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  mkdirSync(join(project, 'notes'), { recursive: true })
  writeFileSync(join(project, 'notes', 'march.md'), '# March\n')
  writeFileSync(join(project, 'notes', 'april.md'), '# April\n')
  const { id } = await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)}, title: 'Ledger' })`)
  await until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('Ledger'))`, 'listed')
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('Ledger')).click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'Ledger'`, 'shown')
  await t.emulateFocus()
  await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'folder', params: { path: '' } })`)
  await until(`[...document.querySelectorAll('.files-tree__row')].some((r) => r.textContent === 'notes')`, 'the folder pane')
  // Into notes, as a right-click's New file here would.
  await t.click('.files-tree__row', 'notes')
  await until(`[...document.querySelectorAll('.files-tree__row')].some((r) => r.textContent === 'march.md')`, 'notes open')
  const folder = `document.querySelector('.files-folder').closest('[data-column]')`
  const editor = `document.querySelector('.file-editor').closest('[data-column]')`
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await t.click('[data-column] .panes__tab [aria-label="New file"]')
    await until(`document.activeElement?.matches('.files-name__field')`, 'the name field, focused')
    await t.type('.files-name__field', 'april.md')
    await t.shot(`files-new-${theme}`, folder)
    await t.type('.files-name__field', 'april.md', { enter: true })
    await until(`document.querySelector('.files-name__problem')?.textContent === 'notes/april.md is already there'`, 'refused in place')
    if (readFileSync(join(project, 'notes', 'april.md'), 'utf8') !== '# April\n') t.fail('april.md was written over')
    await t.shot(`files-taken-${theme}`, folder)
    await t.type('.files-name__field', `may-${theme}.md`, { enter: true })
    await until(`document.activeElement?.matches('[data-column] .file-editor .cm-content')`, 'the new file open, its text focused')
    await t.shot(`files-made-${theme}`, editor)
    await run(`window.superego.call('local', 'pane.close', { thread: '${id}', pane: document.querySelector('[data-column] .file-editor').closest('[data-column]').dataset.column })`)
    await until(`!document.querySelector('.file-editor')`, 'the editor closed')
  }
})
