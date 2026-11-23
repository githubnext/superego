// Panes beside a thread in a git repo: the changes, the editor (Live and Rendered, its links and images), an artifact
// that runs, the room between columns (kept with each thread), the focus and ⌘W, the pane menu, ⌘P and the tree, and the editor keeping its place.
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
  await t.call('pane.open', { thread: paned, kind: 'browser', params: { path: 'page.html' } })
  await t.until(async () => await pageAt('superego-artifact:')?.executeJavaScript('document.body?.dataset.ok') === 'yes', 'the artifact ran')
  await t.check(`document.querySelectorAll('.panes__tab').length === 3`, 'not three pane tabs')

  // The room between two columns resizes the one on its left (as macOS does); the one on its right keeps its width.
  // The thread let scroll with them: kept in view, it leaves its panes their least beside it (no room to widen it here).
  await t.call('app.settings.set', { key: 'app.panes.keepThread', value: false }, 'app')
  await t.until(`!document.querySelector('.panes--keep')`, 'the thread let scroll')
  const [threadBefore, firstBefore] = JSON.parse(await t.run(`JSON.stringify([...document.querySelectorAll('.panes > [data-column]')].map((c) => Math.round(c.getBoundingClientRect().width)))`))
  await t.run(`(() => {
    const gap = document.querySelector('.panes__gap')
    const x = gap.getBoundingClientRect().left + 4
    gap.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: 300 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + 60, clientY: 300 }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: x + 60, clientY: 300 }))
  })()`)
  await t.until(`(() => { const w = [...document.querySelectorAll('.panes > [data-column]')].map((c) => Math.round(c.getBoundingClientRect().width)); return Math.abs(w[0] - ${threadBefore} - 60) <= 2 && Math.abs(w[1] - ${firstBefore}) <= 2 })()`, 'the gap resized the thread, not the pane')
  // Its width is kept with the thread, once let go: a factor of the window's width. The window wider, the thread's
  // column is as wide a part of it; the same thread in another window (a reload, here) the same again.
  const columns = `[...document.querySelectorAll('.panes > [data-column]')].map((c) => c.getBoundingClientRect().width)`
  const threadShare = `(${columns}[0] / window.innerWidth)`
  const keptWidth = async (id = paned) => (await t.call('thread.list')).find((x) => x.id === id).width
  const dragged = (threadBefore + 60) / await t.run('window.innerWidth')
  await t.until(async () => Math.abs((await keptWidth() ?? 0) - dragged) < 0.003, 'the thread kept its width, a factor of the window')
  const [contentWidth, contentHeight] = t.win().getContentSize()
  t.win().setContentSize(contentWidth + 300, contentHeight)
  await t.until(`window.innerWidth >= ${contentWidth + 250} && Math.abs(${threadShare} - ${dragged}) < 0.004`, 'the window wider, the thread as wide a part of it')
  t.win().setContentSize(contentWidth, contentHeight)
  await t.until(`window.innerWidth < ${contentWidth + 50} && Math.abs(${threadShare} - ${dragged}) < 0.004`, 'and back')
  t.contents().reload()
  await t.until(`document.querySelector('.thread__title')?.textContent === 'panes' && document.querySelectorAll('.panes > [data-column]').length === 4 && Math.abs(${threadShare} - ${dragged}) < 0.004`, 'the width kept across a reload')
  // Each thread has its own: another, with a pane of its own, starts at the default, and this one's is back as it's shown again.
  const elsewhere = (await t.call('thread.start', { cwd: repo, title: 'widths elsewhere' })).id
  const opened = await t.call('pane.open', { thread: elsewhere, kind: 'editor', params: { path: 'notes.md' } })
  await openRow(t, 'widths elsewhere')
  await t.until(`document.querySelector('.thread__title')?.textContent === 'widths elsewhere' && document.querySelectorAll('.panes > [data-column]').length === 2`, 'another thread, with a pane')
  await t.check(`Math.abs(${columns}[0] - ${threadBefore + 60}) > 20`, "another thread took this one's width")
  if (await keptWidth(elsewhere) !== undefined || opened.width !== undefined) t.fail('a new thread or pane had a width kept')
  await openRow(t, 'panes')
  await t.until(`document.querySelector('.thread__title')?.textContent === 'panes' && Math.abs(${threadShare} - ${dragged}) < 0.004`, "the thread's own width, shown again")
  await t.call('thread.archive', { thread: elsewhere })
  // A double click on the handle puts it back as it was, and keeps that.
  await t.run(`document.querySelector('.panes__gap').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await t.until(`Math.abs(${columns}[0] - ${threadBefore}) <= 2`, 'a double click put the thread back')
  await t.until(async () => await keptWidth() === undefined, 'and kept it so')
  await t.call('app.settings.set', { key: 'app.panes.keepThread', value: true }, 'app')
  // Opened from outside the window (as the agent opens them), they open beside and the focus stays put. ⌘W closes the
  // one with the focus, from inside the page too: the window takes its shortcuts before a frame.
  await t.check(`!document.querySelector('.panes__tab.is-active')`, 'a pane the window did not open took the focus')
  await t.emulateFocus()
  await t.run(`document.querySelector('.browser-frame .web-view').focus()`)
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
    // The keys go where the focus is: into the menu a frame or so after it opens, which a busy window can be slower to
    // draw than the mouse is to highlight an item.
    await t.until(`Boolean(document.activeElement?.closest('.superego-menu'))`, 'the pane menu has the focus')
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
  // ⌘⇧↩ maximizes the column with the focus, the thread's too: from its prompt (what's typed there kept, not sent) or
  // its transcript, over its panes, kept as they were under it. Again restores it; so does focusing a pane (⌃Tab).
  const maximized = `document.querySelector('.panes.has-maximized > .is-maximized')?.dataset.column`
  const restored = `!document.querySelector('.panes.has-maximized')`
  await t.type('.composer textarea', 'a draft')
  t.key('Enter', ['meta', 'shift'])
  await t.until(`${maximized} === 'thread'`, 'the thread maximized from its prompt')
  await t.check(`document.querySelector('.composer textarea').value === 'a draft'`, 'the prompt sent or changed its text on ⌘⇧↩')
  await t.check(`document.querySelector('[data-column]:not([data-column="thread"])').inert && !document.querySelector('[data-column="thread"]').inert`, 'the panes under the maximized thread still in reach')
  // The strip marks the thread focused once the thread has heard so (the prompt took the focus from the editor just now).
  await t.until(`document.querySelector('.strip__tab.is-focused')?.textContent === 'Thread' && [...document.querySelectorAll('.strip__tab:not(.is-focused)')].every((tab) => tab.matches('.is-away'))`, 'the strip shows the thread maximized')
  t.key('Enter', ['meta', 'shift'])
  await t.until(restored, 'the thread restored by ⌘⇧↩ again')
  await t.run(`document.querySelector('.thread__scroll').focus()`)
  t.key('Enter', ['meta', 'shift'])
  await t.until(`${maximized} === 'thread'`, 'the thread maximized from its transcript')
  t.key('Tab', ['control'])
  await t.until(`${restored} && Boolean(document.activeElement?.closest('[data-column]:not([data-column="thread"])'))`, 'focusing a pane restored the thread')
  // ⌘↩ in the prompt sends, as ↩ does.
  await t.type('.composer textarea', 'sent by cmd-return')
  t.key('Enter', ['meta'])
  await t.until(`document.querySelector('.composer textarea').value === '' && document.querySelector('.thread__scroll')?.textContent.includes('sent by cmd-return')`, '⌘↩ in the prompt sent')
  await t.until(async () => (await t.call('thread.list')).find((x) => x.id === paned).status.state !== 'working' && await t.run(`document.querySelector('.thread__scroll').textContent.includes('echo: sent by cmd-return')`), 'the answer')
  await t.check(restored, 'sending maximized something')

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
  await reorder(t, paned, panesOf)
  // ⌘W closes the pane with the focus: the editor's, here (switching back put it in the prompt).
  await t.run(`document.querySelector('[data-column]:not([data-column="thread"]) .cm-content').focus()`)
  t.key('w')
  await t.until(`!document.querySelector('.panes__tab')`, 'editor closed')
}

/**
 * A pane's tab dragged along the strip moves the pane, with Chromium's own pointer events: the thread keeps the order
 * (and the columns follow), a press that moves less than the threshold is a click, Esc puts it back, the thread's tab
 * stays put, and ⌘⌥⇧←/→ move the focused pane too.
 */
async function reorder(t, paned, panesOf) {
  await t.call('pane.open', { thread: paned, kind: 'editor', params: { path: 'notes.md' } })
  await t.call('pane.open', { thread: paned, kind: 'editor', params: { path: 'page.html' } })
  const ids = async () => (await panesOf()).map((p) => p.id)
  const start = await ids()
  if (start.length !== 3) t.fail(`three panes to move, not ${start.length}`)
  const [a, b, c] = start
  await t.until(`document.querySelectorAll('.strip__tab[data-pane]:not([data-out])').length === 3`, 'three pane tabs in the strip')
  // In the page's order, the tabs; the columns as they're laid out: the thread first, then the panes left to right (the
  // thread kept in view stays put as the row scrolls to the moved pane, and the one before slides under it).
  const tabs = `[...document.querySelectorAll('.strip__tab')].map((el) => el.dataset.pane ?? 'thread').join()`
  const columns = `['thread', ...[...document.querySelectorAll('.panes > [data-column]:not([data-column="thread"])')].sort((x, y) => x.getBoundingClientRect().left - y.getBoundingClientRect().left).map((el) => el.dataset.column)].join()`
  const at = (id) => t.run(`(() => { const r = document.querySelector('.strip__tab[data-pane="${id}"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), width: r.width } })()`)
  const send = (type, x, y) => t.contents().sendInputEvent({ type, x, y, button: 'left', clickCount: 1, ...(type === 'mouseMove' ? { modifiers: ['leftButtonDown'] } : {}) })
  const drag = async (id, by, { release = true } = {}) => {
    const from = await at(id)
    send('mouseDown', from.x, from.y)
    for (let step = 1; step <= 8; step++) { send('mouseMove', Math.round(from.x + (by * step) / 8), from.y); await t.settled() }
    if (release) send('mouseUp', from.x + by, from.y)
  }
  const order = (...want) => `${['thread', ...want].join()}`

  // Under the threshold, a click: it selects the tab, nothing moves.
  const first = await at(a)
  send('mouseDown', first.x, first.y)
  send('mouseMove', first.x + 2, first.y)
  send('mouseUp', first.x + 2, first.y)
  await t.until(async () => (await t.call('thread.list')).find((x) => x.id === paned).pane === a, 'a short press selects the tab')
  if (JSON.stringify(await ids()) !== JSON.stringify(start)) t.fail('a short press moved the pane')

  // Dragged past the others: the thread has it last, the tabs and the columns follow, and it has the focus.
  await drag(a, (await at(c)).x - first.x + 10)
  await t.until(async () => JSON.stringify(await ids()) === JSON.stringify([b, c, a]), 'the drag moved it last in the thread')
  await t.until(`${tabs} === ${JSON.stringify(order(b, c, a))}`, 'the tabs follow')
  await t.until(`${columns} === ${JSON.stringify(order(b, c, a))}`, 'the columns follow')
  await t.until(`document.activeElement?.closest('[data-column]')?.dataset.column === '${a}'`, 'the moved pane has the focus')
  await t.until(`!document.querySelector('.strip [data-dragged], .strip [data-dragging]') && [...document.querySelectorAll('.strip__tab')].every((el) => !el.style.transform)`, 'the strip at rest')

  // Esc mid-drag: put back, nothing moved.
  await drag(a, -(await at(a)).width * 2, { release: false })
  await t.until(`!!document.querySelector('.strip [data-dragged]')`, 'dragging')
  t.key('Escape', [])
  await t.until(`!document.querySelector('.strip [data-dragged]')`, 'Esc ends the drag')
  const last = await at(a)
  send('mouseUp', last.x, last.y)
  await t.settled()
  if (JSON.stringify(await ids()) !== JSON.stringify([b, c, a])) t.fail(`Esc should put it back, not ${await ids()}`)

  // The thread's tab doesn't move.
  const thread = await t.run(`(() => { const r = document.querySelector('.strip__tab:not([data-pane])').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  send('mouseDown', thread.x, thread.y)
  for (let step = 1; step <= 4; step++) send('mouseMove', thread.x + step * 60, thread.y)
  await t.check(`!document.querySelector('.strip [data-dragged]')`, "the thread's tab dragged")
  send('mouseUp', thread.x + 240, thread.y)
  await t.settled()
  if (JSON.stringify(await ids()) !== JSON.stringify([b, c, a])) t.fail(`the thread's tab moved a pane: ${await ids()}`)

  // ⌘⌥⇧← and → move the focused pane, a place at a time; the focus stays in it.
  await t.run(`document.querySelector('[data-column="${a}"] .cm-content')?.focus()`)
  await t.until(`document.activeElement?.closest('[data-column]')?.dataset.column === '${a}'`, 'the pane focused')
  t.key('Left', ['meta', 'alt', 'shift'])
  await t.until(async () => JSON.stringify(await ids()) === JSON.stringify([b, a, c]), '⌘⌥⇧← moved it left')
  await t.until(`${columns} === ${JSON.stringify(order(b, a, c))}`, 'the columns follow the keys')
  await t.check(`document.activeElement?.closest('[data-column]')?.dataset.column === '${a}'`, 'the moved pane kept the focus')
  t.key('Right', ['meta', 'alt', 'shift'])
  await t.until(async () => JSON.stringify(await ids()) === JSON.stringify([b, c, a]), '⌘⌥⇧→ moved it back')

  await keepThread(t, paned, a)

  // A middle click on a pane's tab closes it, as in a browser; on the thread's it does nothing.
  const middle = async (selector) => {
    const r = await t.run(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    for (const type of ['mouseDown', 'mouseUp']) t.contents().sendInputEvent({ type, x: r.x, y: r.y, button: 'middle', clickCount: 1 })
  }
  await middle('.strip__tab:not([data-pane])')
  await t.settled()
  if (JSON.stringify(await ids()) !== JSON.stringify([b, c, a])) t.fail(`a middle click on the thread's tab changed its panes: ${await ids()}`)
  await middle(`.strip__tab[data-pane="${b}"]`)
  await t.until(async () => JSON.stringify(await ids()) === JSON.stringify([c, a]), "a middle click closes a pane's tab")
  await t.call('pane.close', { thread: paned, pane: a })
  await t.until(`document.querySelectorAll('.strip__tab[data-pane]').length === 1`, 'one pane again')
}

/**
 * Scrolled, the thread kept in view (on by default): the last pane focused shows beside it, the thread still at the
 * start. The strip's pin turns it off (the row scrolls as one, the thread off to the left once it's past the window)
 * and on again, kept in the app's settings.
 */
async function keepThread(t, paned, last) {
  // The row's box less its padding (wide, the room at its start): where its columns go.
  const row = `(() => { const p = document.querySelector('.panes'), r = p.getBoundingClientRect(), s = getComputedStyle(p); return { left: r.left + parseFloat(s.paddingLeft), right: r.right - parseFloat(s.paddingRight) } })()`
  const rect = (column) => `document.querySelector('[data-column="${column}"]').getBoundingClientRect()`
  const setting = (value) => `window.superego.call('app', 'settings.watch', {}).then((r) => r.value.values['app.panes.keepThread'] === ${value})`
  await t.check(`!!document.querySelector('.panes--keep')`, 'the thread kept in view by default')
  await t.call('pane.focus', { thread: paned, pane: last })
  await t.until(`(() => { const r = ${row}, th = ${rect('thread')}, p = ${rect(last)}; return Math.abs(th.left - r.left) < 1 && p.left >= th.right - 1 && p.right <= r.right + 1 })()`, 'kept: the thread and the last pane in view')
  await t.click('.strip__keep')
  await t.until(setting(false), 'the pin turned it off, in the settings')
  await t.until(`!document.querySelector('.panes--keep') && (() => { const p = document.querySelector('.panes'); return p.scrollWidth <= p.clientWidth || ${rect('thread')}.right <= ${row}.left + 1 })()`, 'not kept: the thread scrolled away with the last pane')
  await t.click('.strip__keep')
  await t.until(setting(true), 'the pin turned it on again')
  await t.until(`!!document.querySelector('.panes--keep') && Math.abs(${rect('thread')}.left - ${row}.left) < 1`, 'kept again: the thread back in view')
}
