// Panes beside a thread in a git repo: the changes, the editor (Live and Rendered, its links and images), an artifact
// that runs, the room between columns, the focus and ⌘W, the pane menu, ⌘P and the tree, and the editor keeping its place.
import { execFileSync } from 'node:child_process'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { nativeTheme } from 'electron'
import { home, openRow, pageAt } from './common.mjs'

export default async function panes(t, s) {
  const repo = s.repo = `${home}/repo`
  const git = (...args) => execFileSync('git', ['-C', repo, ...args])
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(`${repo}/notes.md`, 'one\n')
  git('add', '.'); git('-c', 'user.email=s@s', '-c', 'user.name=s', 'commit', '-q', '-m', 'start')
  const paned = s.paned = (await t.call('thread.start', { cwd: repo, title: 'panes' })).id
  const write = (path, content) => t.call('file.write', { thread: paned, path, content })
  const panesOf = async () => (await t.call('thread.list')).find((x) => x.id === paned).panes
  await write('notes.md', 'two\n')
  await write('page.html', `<body><script>document.body.dataset.ok = 'yes'</script>An artifact</body>`)
  await openRow(t, 'panes')
  await t.until(`document.querySelector('.thread__title')?.textContent === 'panes'`, 'pane thread open')
  t.key('d', ['meta', 'shift'])
  await t.until(`[...document.querySelectorAll('.diff-row--add')].some((r) => r.textContent.endsWith('+two'))`, 'changes pane shows the edit')
  await t.call('pane.open', { thread: paned, kind: 'editor', params: { path: 'notes.md' } })
  await t.until(`document.querySelector('.cm-content')?.textContent.includes('two')`, 'editor pane shows the file')
  // Rendered: read as a message reads, following the file as it changes; the editor kept behind it, for Live again.
  await t.click('.file-editor__mode button', 'Rendered')
  await t.until(`document.querySelector('.file-editor__rendered .md')?.textContent.includes('two') && document.querySelector('.file-editor__host').hidden`, 'rendered shows the file')
  await write('notes.md', '# Notes\n\ntwo, and **three**, see [[page.html]]\n')
  await t.until(`document.querySelector('.file-editor__rendered h1')?.textContent === 'Notes' && document.querySelector('.file-editor__rendered strong')?.textContent === 'three' && document.querySelector('.file-editor__rendered a.md__file')?.textContent === 'page.html'`, 'rendered follows the file')
  await t.check(`!document.querySelector('.file-editor__rendered .cm-content, .file-editor__rendered [contenteditable]')`, 'rendered is editable')
  // Its links open files beside the thread, as a message's do.
  mkdirSync(`${repo}/docs/img`, { recursive: true }); writeFileSync(`${repo}/docs/plan.md`, 'the plan\n')
  await write('notes.md', '# Notes\n\ntwo, and **three**, see [[page.html]] and [the plan](docs/plan.md)\n')
  await t.until(`[...document.querySelectorAll('.file-editor__rendered a.md__file')].some((a) => a.textContent === 'the plan')`, 'a link to a file')
  await t.click('.file-editor__rendered a.md__file', 'the plan')
  await t.until(`[...document.querySelectorAll('.panes__tab')].some((t) => t.textContent.startsWith('plan.md'))`, 'the link opened the file beside')
  await t.call('pane.close', { thread: paned, pane: (await panesOf()).find((p) => p.params?.path === 'docs/plan.md').id })
  await t.until(`![...document.querySelectorAll('.panes__tab')].some((t) => t.textContent.startsWith('plan.md'))`, 'and closed')
  // Its HTML (sanitized) and images, read from beside it: a <picture> shows the source for the app's theme.
  const svg = (width) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="10"><rect width="${width}" height="10" fill="teal"/></svg>`
  writeFileSync(`${repo}/docs/img/light.svg`, svg(40)); writeFileSync(`${repo}/docs/img/dark.svg`, svg(30)); writeFileSync(`${repo}/docs/img/plain.svg`, svg(20))
  writeFileSync(`${repo}/docs/guide.md`, '# Guide\n\ntwo, and **three**\n\n<picture><source media="(prefers-color-scheme: dark)" srcset="img/dark.svg"><img src="img/light.svg" alt="diagram" onerror="document.body.dataset.pwned = 1"></picture>\n\n![plain](img/plain.svg)\n\n<script>document.body.dataset.pwned = 1</script>\n')
  const editor = (await panesOf()).find((p) => p.kind === 'editor').id
  await t.call('pane.update', { thread: paned, pane: editor, params: { path: 'docs/guide.md' } })
  const imageWidths = `[...document.querySelectorAll('.file-editor__rendered img')].map((i) => i.src.startsWith('blob:') && i.complete ? i.naturalWidth : 0).join(',')`
  nativeTheme.themeSource = 'light'
  await t.until(`${imageWidths} === '40,20'`, 'rendered images, the light source')
  nativeTheme.themeSource = 'dark'
  await t.until(`${imageWidths} === '30,20'`, 'rendered images, the dark source')
  nativeTheme.themeSource = 'system'
  await t.check(`!document.body.dataset.pwned && !document.querySelector('.file-editor__rendered script, .file-editor__rendered [onerror]')`, 'rendered HTML kept a script or handler')
  await t.call('pane.update', { thread: paned, pane: editor, params: { path: 'notes.md' } })
  await t.until(`document.querySelector('.file-editor__rendered h1')?.textContent === 'Notes'`, 'back to the notes')
  await t.click('.file-editor__mode button', 'Live')
  await t.until(`!document.querySelector('.file-editor__rendered') && !document.querySelector('.file-editor__host').hidden && document.querySelector('.cm-content')?.textContent.includes('three')`, 'live again, with the change')
  await t.call('pane.open', { thread: paned, kind: 'artifact', params: { path: 'page.html' } })
  await t.until(async () => await pageAt('superego-artifact:')?.executeJavaScript('document.body?.dataset.ok') === 'yes', 'the artifact ran')
  await t.check(`document.querySelectorAll('.panes__tab').length === 3`, 'not three pane tabs')

  // The room between two columns resizes the one on its left (as macOS does); the one on its right keeps its width.
  const [threadBefore, firstBefore] = JSON.parse(await t.run(`JSON.stringify([...document.querySelectorAll('.panes > [data-column]')].map((c) => Math.round(c.getBoundingClientRect().width)))`))
  await t.run(`(() => {
    const gap = document.querySelector('.panes__gap')
    const x = gap.getBoundingClientRect().left + 4
    gap.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: 300 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + 60, clientY: 300 }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: x + 60, clientY: 300 }))
  })()`)
  await t.until(`(() => { const w = [...document.querySelectorAll('.panes > [data-column]')].map((c) => Math.round(c.getBoundingClientRect().width)); return Math.abs(w[0] - ${threadBefore} - 60) <= 2 && Math.abs(w[1] - ${firstBefore}) <= 2 })()`, 'the gap resized the thread, not the pane')
  // Opened from outside the window (as the agent opens them), they open beside and the focus stays put. ⌘W closes the
  // one with the focus, from inside the page too: the window takes its shortcuts before a frame.
  await t.check(`!document.querySelector('.panes__tab.is-active')`, 'a pane the window did not open took the focus')
  await t.emulateFocus()
  await t.run(`document.querySelector('.web-panes-frame .web-view').focus()`)
  await t.until(`document.querySelector('.panes__tab.is-active')?.textContent.startsWith('page.html')`, 'focus into the page brings it forward')
  for (let left = 2; left >= 0; left--) {
    t.key('w')
    await t.until(`document.querySelectorAll('.panes__tab').length === ${left}`, `a pane closed, ${left} left`)
    // The focus moved left: closing page.html leaves notes.md, before it, with the focus.
    if (left === 2) await t.until(`document.querySelector('.panes__tab.is-active')?.textContent.startsWith('notes.md') && Boolean(document.activeElement?.closest('[data-column]:not([data-column="thread"])'))`, 'focus moved to the pane on the left')
  }
  // The header's pane menu opens one too.
  await t.click('.thread__panes')
  await t.until(`[...document.querySelectorAll('.superego-menu__item')].some((i) => i.textContent === 'Changes')`, 'pane menu offers Changes')
  // Its items highlight as any menu's do, under the mouse and from the keyboard, with each its view's menu on a right-click.
  const highlighted = `document.querySelector('.superego-menu__item[data-highlighted]')?.textContent`
  await t.hover('.superego-menu__item', 'Changes')
  await t.until(`${highlighted} === 'Changes'`, 'the pane menu highlights the item under the mouse')
  if (await t.run(`document.querySelectorAll('.superego-menu__item').length`) > 1) {
    t.key('Down', [])
    await t.until(`${highlighted} && ${highlighted} !== 'Changes'`, 'the pane menu highlights the next item from the keyboard')
  }
  await t.mouse('.superego-menu__item[data-view="diff"]', { button: 'right' })
  await t.until(`document.querySelector('.view-menu [data-remove]')?.textContent === 'Remove from pane menu'`, "a pane menu item's own menu on a right-click")
  t.key('Escape', [])
  await t.until(`!document.querySelector('.view-menu')`, "the item's menu closed")
  if (!await t.run(`Boolean(document.querySelector('.superego-menu__item[data-view="diff"]'))`)) await t.click('.thread__panes')
  await t.until(`Boolean(document.querySelector('.superego-menu__item[data-view="diff"]'))`, 'pane menu open again')
  await t.click('.superego-menu__item', 'Changes')
  await t.until(`document.querySelector('.panes__tab')?.textContent.startsWith('Changes')`, 'pane menu opened Changes')
  t.key('w')
  await t.until(`!document.querySelector('.panes__tab')`, 'menu pane closed')

  // ⌘P: a file by a few letters of its name, opened beside the thread; its tree shows it, and a click there shows
  // another file in the same editor.
  t.key('p')
  await t.until(`Boolean(document.querySelector('.files-open .palette__input'))`, 'quick open')
  await t.type('.files-open .palette__input', 'note')
  await t.until(`document.querySelector('.files-open li.is-active')?.textContent.startsWith('notes.md')`, 'quick open finds notes.md')
  t.key('Enter', [])
  await t.until(`document.querySelector('.panes__tab.is-active')?.textContent.startsWith('notes.md') && !document.querySelector('.files-tree')`, 'notes.md open, its tree closed')
  t.key('t', ['meta', 'shift'])
  await t.until(`Boolean(document.querySelector('.files-tree__row.is-current'))`, 'tree shown, at notes.md')
  await t.click('.files-tree__row', 'page.html')
  await t.until(`document.querySelectorAll('.panes__tab').length === 1 && document.querySelector('.panes__tab')?.textContent.startsWith('page.html')`, 'the tree showed page.html in the same editor')
  // Clicking a pane's title takes the focus into it: the editor's text.
  await t.run(`document.querySelector('.composer textarea').focus()`)
  await t.click('.panes__label')
  await t.until(`document.activeElement?.matches('.cm-content')`, "a pane's title click focuses its editor")
  // Code is coloured by its language, loaded for the file's name.
  await t.until(`(() => { const base = getComputedStyle(document.querySelector('.cm-content')).color; return [...document.querySelectorAll('.cm-content .cm-line span')].some((s) => s.textContent === 'body' && getComputedStyle(s).color !== base) })()`, 'html in the editor is highlighted')

  // The editor keeps its place: when focus comes back to it from the keyboard, and when its thread is shown again.
  await write('long.md', Array.from({ length: 300 }, (_, i) => 'line ' + i).join('\n'))
  await t.call('pane.update', { thread: paned, pane: (await panesOf())[0].id, params: { path: 'long.md' } })
  await t.until(`document.querySelector('.file-editor__scroll')?.scrollHeight > 3000`, 'a long file open')
  await t.run(`document.querySelector('.file-editor__scroll').scrollTop = 1500`)
  // The scroll heard and kept (the editor keeps its place as it scrolls) before the focus moves.
  await t.settled()
  await t.run(`document.querySelector('.composer textarea').focus()`)
  t.key('Right', ['meta', 'alt'])
  await t.until(`document.activeElement?.matches('.cm-content')`, 'focus back in the editor')
  await t.settled()
  const kept = await t.run(`document.querySelector('.file-editor__scroll').scrollTop`)
  if (Math.abs(kept - 1500) > 4) t.fail(`the editor scrolled to ${kept} on focus`)
  // The app's keys work from inside the editor: it doesn't keep ⌘/ (comment) or ⌘L (select line) for itself.
  const docBefore = await t.run(`document.querySelector('.cm-content').textContent`)
  t.key('/')
  await t.until(`!document.querySelector('.app__sidebar')`, 'cmd+/ from the editor hides the sidebar')
  t.key('/')
  await t.until(`Boolean(document.querySelector('.app__sidebar'))`, 'and shows it')
  await t.run(`document.querySelector('.cm-content').focus()`)
  t.key('l')
  await t.until(`Boolean(document.querySelector('.navigator'))`, 'cmd+L from the editor opens the navigator')
  t.key('Escape', [])
  await t.until(`!document.querySelector('.navigator')`, 'navigator closed')
  await t.check(`document.querySelector('.cm-content').textContent === ${JSON.stringify(docBefore)}`, 'the editor changed its text on app keys')
  await t.run(`[...document.querySelectorAll('.superego-list-item')].find((li) => !li.classList.contains('is-selected')).click()`)
  await t.until(`document.querySelector('.thread__title')?.textContent !== 'panes'`, 'another thread')
  await openRow(t, 'panes')
  await t.until(`document.querySelector('.file-editor__scroll')?.scrollHeight > 3000`, 'the long file again')
  await t.until(`Math.abs(document.querySelector('.file-editor__scroll').scrollTop - 1500) <= 4`, 'the editor where it was left')
  // Changed on disk by someone else while open (another editor, git): the editor shows it at once, still in place.
  writeFileSync(`${repo}/.long.md.tmp`, Array.from({ length: 300 }, (_, i) => 'edited ' + i).join('\n'))
  renameSync(`${repo}/.long.md.tmp`, `${repo}/long.md`)
  await t.until(`document.querySelector('.cm-content')?.textContent.includes('edited ')`, 'the change shown')
  await t.until(`Boolean(document.querySelector('.cm-content .cm-arrived'))`, 'the change flashes as it arrives')
  await t.until(`!document.querySelector('.cm-content .cm-arrived')`, 'and fades')
  await t.until(`Math.abs(document.querySelector('.file-editor__scroll').scrollTop - 1500) <= 4`, 'still where it was')
  // ⌘W closes the pane with the focus: the editor's, here (switching back put it in the prompt).
  await t.run(`document.querySelector('[data-column]:not([data-column="thread"]) .cm-content').focus()`)
  t.key('w')
  await t.until(`!document.querySelector('.panes__tab')`, 'editor closed')
}
