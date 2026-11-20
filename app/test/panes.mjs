// Screenshots of a thread with three panes in each layout (run by `test/look.sh <dir> panes`): scrolled (the thread kept
// in view, and not), then stacked
// from the strip's switch, a pane brought to the front by ⌃Tab and one opened from outside the window, then scrolled again
// by its shortcut; a pane's tab mid-drag; a pane maximized in each, and restored (Esc, a double click, another pane opening). Checks on the way that a stack never passes the window's edge, and that the last pane's handle is
// clear of it and drags the pane wider. Light and dark, into
// $SUPEREGO_SHOWCASE_OUT.
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openApp } from './harness.mjs'
import { threads } from './showcase/threads.mjs'


await openApp({ name: 'panes', timeout: 240_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1300, 820)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const { id } = await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)} })`)
  await run(`window.superego.call('local', 'thread.send', { thread: '${id}', text: ${JSON.stringify(threads[0].prompt)} })`)
  await until(`window.superego.call('local', 'thread.list', {}).then((l) => ['done', 'error'].includes(l.find((t) => t.id === '${id}')?.status.state))`, 'an answer')
  await run(`window.superego.call('local', 'thread.seen', { thread: '${id}' })`)
  await run(`document.querySelector('.app__sidebar .superego-list-item')?.click()`)
  await until(`document.querySelectorAll('.transcript .msg').length >= 2`, 'thread shown')
  await t.emulateFocus()

  const both = async (name) => {
    for (const theme of ['light', 'dark']) {
      await t.theme(theme)
      await t.shot(`panes-${name}-${theme}`)
    }
  }
  const paneIds = () => run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${id}').panes.map((p) => p.id))`)
  const open = async (kind, params, ready) => {
    await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: '${kind}', params: ${JSON.stringify(params)} })`)
    await until(ready, kind)
    await t.settled()
  }
  const key = (init) => run(`window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...${JSON.stringify(init)} }))`)
  const shownPanes = () => run(`[...document.querySelectorAll('.panes > [data-column]:not([data-column="thread"])')].filter((c) => getComputedStyle(c).visibility !== 'hidden').map((c) => c.dataset.column)`)

  await open('diff', {}, `!!document.querySelector('.diff-file, .pane-empty')`)
  await open('editor', { path: 'README.md' }, `!!document.querySelector('.file-editor .cm-content')`)
  await open('folder', { path: '' }, `!!document.querySelector('.files-tree__row')`)
  const [diff, editor, folder] = await paneIds()
  if (!folder) t.fail('three panes')
  // Scrolled: the editor focused, the row past the window's edge.
  await run(`window.superego.call('local', 'pane.focus', { thread: '${id}', pane: '${editor}' })`)
  await until(`(() => { const p = document.querySelector('.panes'); return p.scrollWidth > p.clientWidth })()`, 'scrolled: the row past the window')
  if (!await run(`!!document.querySelector('.panes--keep')`)) t.fail('scrolled: the thread kept in view by default')
  await t.settled()
  await both('scroll')
  // The last pane focused, its handle in view clear of the window's edge; dragged out, it grows and the row scrolls on.
  await run(`window.superego.call('local', 'pane.focus', { thread: '${id}', pane: '${folder}' })`)
  const handle = `[...document.querySelectorAll('.panes > .panes__gap')].at(-1)`
  // Scrolled to the last pane: its handle in view, clear of the window's edge.
  await until(`(() => { const p = document.querySelector('.panes').getBoundingClientRect(), h = ${handle}.getBoundingClientRect(); return p.right - h.right >= 16 })()`, "the last handle clear of the window's edge")
  await t.settled()
  await both('scroll-end')
  const lastWidth = () => run(`document.querySelector('[data-column="${folder}"]').offsetWidth`)
  const before = await lastWidth()
  await run(`(() => { const h = ${handle}; const r = h.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + 100, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: x + 100, clientY: y })) })()`)
  await until(`document.querySelector('[data-column="${folder}"]').offsetWidth >= ${before} + 90`, 'the last pane dragged wider')
  await run(`${handle}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await until(`document.querySelector('[data-column="${folder}"]').offsetWidth === ${before}`, 'the last pane put back')
  // Kept in view: the thread still at the start with the last pane focused, the pane whole beside it, the first pane
  // scrolled under it (away, on the strip), the thread's tab not.
  const rect = (column) => `document.querySelector('[data-column="${column}"]').getBoundingClientRect()`
  const beside = (pane) => `(() => { const row = document.querySelector('.panes').getBoundingClientRect(), t = ${rect('thread')}, p = ${rect(pane)}; return Math.abs(t.left - row.left) < 1 && p.left >= t.right - 1 && p.right <= row.right + 1 })()`
  await until(beside(folder), 'kept: the thread in view, the last pane whole beside it')
  if (!await run(`document.querySelector('.strip__tab:not([data-pane])').matches('.is-shown, .is-focused') && document.querySelector('.strip__tab[data-pane="${diff}"]').matches('.is-away')`)) t.fail('kept: the strip shows the thread in view, the first pane away')
  // ⌘⌥← to the pane before, and ⌃Tab back: each whole beside the thread.
  await run(`document.querySelector('.strip__tab[data-pane="${folder}"]').click()`)
  await until(`document.activeElement?.closest('[data-column]')?.dataset.column === '${folder}'`, 'kept: the last pane focused from its tab')
  await key({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, altKey: true })
  await until(`document.activeElement?.closest('[data-column]')?.dataset.column === '${editor}'`, 'kept: ⌘⌥← focus')
  await until(beside(editor), 'kept: ⌘⌥← shows the pane before beside the thread')
  await key({ key: 'Tab', code: 'Tab', ctrlKey: true })
  await until(beside(folder), 'kept: ⌃Tab shows the next beside the thread')
  // Turned off from the strip's pin: the row scrolls as one again, the thread off to the left; back on, it's in view.
  await run(`document.querySelector('.strip__keep').click()`)
  await until(`!document.querySelector('.panes--keep')`, 'the thread let scroll')
  await until(`${rect('thread')}.right <= document.querySelector('.panes').getBoundingClientRect().left + 1`, 'not kept: the thread scrolled off with the last pane focused')
  await t.settled()
  await both('scroll-end-unkept')
  // Maximized and restored, not kept: the row scrolled as it was.
  const unkeptScroll = await run(`document.querySelector('.panes').scrollLeft`)
  await key({ key: 'Enter', code: 'Enter', metaKey: true, shiftKey: true })
  await until(`document.querySelector('.panes > .is-maximized')?.dataset.column === '${folder}'`, 'not kept: maximized')
  await key({ key: 'Enter', code: 'Enter', metaKey: true, shiftKey: true })
  await until(`!document.querySelector('.panes.has-maximized')`, 'not kept: restored')
  if (await run(`document.querySelector('.panes').scrollLeft`) !== unkeptScroll) t.fail('not kept, restored: the row scrolled as it was')
  await run(`document.querySelector('.strip__keep').click()`)
  await until(`!!document.querySelector('.panes--keep')`, 'the thread kept again')
  await until(beside(folder), 'kept again: the thread in view')
  await t.settled()
  await both('scroll-end-kept')
  // On a phone, each column the screen's width as ever: nothing kept.
  // (The window goes no narrower than 600: zoomed, its page is a phone's 375.)
  await t.resize(600, 820)
  await t.zoom(1.6)
  await until(`!!document.querySelector('.panes--narrow') && !document.querySelector('.panes--keep')`, 'narrow: nothing kept')
  await t.zoom(1)
  await t.resize(1300, 820)
  await until(`!!document.querySelector('.panes--keep')`, 'wide again: the thread kept')
  await run(`window.superego.call('local', 'pane.focus', { thread: '${id}', pane: '${editor}' })`)
  await t.settled()

  // A pane's tab mid-drag along the strip: it follows the pointer, lifted, the one it passed slid aside. Esc puts it back.
  await run(`(() => { const tab = document.querySelector('.strip__tab[data-pane="${editor}"]'); const r = tab.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2
    const to = document.querySelector('.strip__tab[data-pane="${folder}"]').getBoundingClientRect()
    tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', clientX: x, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: x + 6, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: to.left + to.width / 2 + 6, clientY: y })) })()`)
  const tabsNow = () => run(`[...document.querySelectorAll('.strip__tab')].map((el) => [el.dataset.pane, el.hasAttribute('data-out'), el.hasAttribute('data-dragged'), el.style.transform].join(' ')).join(' | ')`)
  await until(`!!document.querySelector('.strip [data-dragged]') && !!document.querySelector('.strip__tab[data-pane="${folder}"]').style.transform`, 'a tab mid-drag, the next slid aside').catch(async (e) => { t.fail(`${e.message}: ${await tabsNow()}`) })
  await t.settled()
  await both('strip-drag')
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
  await until(`!document.querySelector('.strip [data-dragged]')`, 'Esc ended the drag')
  await run(`window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse' }))`)
  if (JSON.stringify(await paneIds()) !== JSON.stringify([diff, editor, folder])) t.fail(`Esc mid-drag: nothing moved, not ${await paneIds()}`)

  // Maximized from its tab's button: over the whole of the thread's area, the rest kept under it as they were (the
  // row's scroll too). An Esc the editor has no use for restores it.
  const maximized = () => run(`document.querySelector('.panes.has-maximized > .is-maximized')?.dataset.column ?? null`)
  const rowScroll = await run(`document.querySelector('.panes').scrollLeft`)
  await run(`document.querySelector('[data-column="${editor}"] .panes__maximize').click()`)
  await until(`document.querySelector('.panes > .is-maximized')?.dataset.column === '${editor}'`, 'maximized from its button')
  await t.settled()
  const covers = await run(`(() => { const s = document.querySelector('.sheet').getBoundingClientRect(), c = document.querySelector('[data-column="${editor}"]').getBoundingClientRect(); return [s.width - c.width, s.height - c.height].every((d) => Math.abs(d) < 1) })()`)
  if (!covers) t.fail('maximized: the pane should cover the thread and the rest')
  if (JSON.stringify(await shownPanes()) !== JSON.stringify([editor])) t.fail(`maximized: only it shown, not ${await shownPanes()}`)
  if (!await run(`document.querySelector('[data-column="thread"]').inert`)) t.fail('maximized: the thread under it is out of reach')
  if (await run(`document.querySelector('[data-column="${editor}"] .panes__maximize').getAttribute('aria-label')`) !== 'Restore README.md') t.fail('maximized: its button restores')
  await both('scroll-maximized')
  await run(`document.querySelector('[data-column="${editor}"] .cm-content').focus()`)
  await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))`)
  await until(`!document.querySelector('.panes.has-maximized')`, 'Esc restored it')
  if (await run(`document.querySelector('.panes').scrollLeft`) !== rowScroll) t.fail('restored: the row scrolled as it was')
  if (JSON.stringify(await shownPanes()) !== JSON.stringify([diff, editor, folder])) t.fail(`restored: every pane shown, not ${await shownPanes()}`)

  // Stacked, from the strip's switch: the focused pane in front, and nothing past the window's edge.
  await run(`document.querySelector('.strip__layout [aria-label="Stack panes"]').click()`)
  await until(`!!document.querySelector('.panes--stack')`, 'stacked')
  await t.settled()
  const fits = () => run(`(() => { const p = document.querySelector('.panes'); return p.scrollWidth <= p.clientWidth })()`)
  if (!await fits()) t.fail('stacked: the row passes the window')
  if (JSON.stringify(await shownPanes()) !== JSON.stringify([editor])) t.fail(`stacked: the focused pane in front, not ${await shownPanes()}`)
  await both('stack')

  // A tab in the strip brings its pane to the front, with the focus; ⌃Tab the next; ⌘⌥← the one before.
  const tab = (pane) => run(`[...document.querySelectorAll('.strip__tab')][${JSON.stringify([undefined, diff, editor, folder])}.indexOf(${JSON.stringify(pane)})].click()`)
  const inFront = async (pane, label) => {
    await until(`document.activeElement?.closest('[data-column]')?.dataset.column === '${pane}'`, `${label}: focus`)
    await t.settled()
    if (JSON.stringify(await shownPanes()) !== JSON.stringify([pane])) t.fail(`${label}: ${pane} in front, not ${await shownPanes()}`)
  }
  await tab(diff)
  await inFront(diff, 'strip')
  await key({ key: 'Tab', code: 'Tab', ctrlKey: true })
  await inFront(editor, '⌃Tab')
  await key({ key: 'Tab', code: 'Tab', ctrlKey: true })
  await inFront(folder, '⌃Tab again')
  await key({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, altKey: true })
  await inFront(editor, '⌘⌥←')
  await tab(diff)
  await inFront(diff, 'strip again')
  await both('stack-changes')
  // Maximized by its shortcut, from the pane with the focus; its title's double click restores it; maximized again,
  // a pane opening restores it.
  await key({ key: 'Enter', code: 'Enter', metaKey: true, shiftKey: true })
  await until(`document.querySelector('.panes > .is-maximized')?.dataset.column === '${diff}'`, 'maximized by its shortcut')
  await both('stack-maximized')
  await run(`document.querySelector('[data-column="${diff}"] .panes__label').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await until(`!document.querySelector('.panes.has-maximized')`, 'a double click restored it')
  await key({ key: 'Enter', code: 'Enter', metaKey: true, shiftKey: true })
  await until(`document.querySelector('.panes > .is-maximized')?.dataset.column === '${diff}'`, 'maximized again')
  // Opened from outside the window (the agent's pane_open, another client's): in front, the focus left where it was.
  await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'editor', params: { path: 'src/dates.mjs' } })`)
  await until(`document.querySelectorAll('.panes > [data-column]').length === 5`, 'a fourth pane')
  await t.settled()
  const fourth = (await paneIds()).at(-1)
  if (JSON.stringify(await shownPanes()) !== JSON.stringify([fourth])) t.fail(`opened: the new pane in front, not ${await shownPanes()}`)
  if (await maximized()) t.fail('opened: the layout restored')
  if (!await fits()) t.fail('stacked with four: the row passes the window')
  await both('stack-opened')

  // A pane's ···, for a view that goes elsewhere too: Move to, with what its buttons do (Maximize, Close). None otherwise.
  const items = (menu) => run(`[...document.querySelectorAll('${menu} :is(.superego-menu__item, .superego-menu__label)')].map((i) => i.textContent)`)
  const menuOf = async (pane) => {
    await run(`document.querySelector('[data-column="${pane}"] .panes__tab .view-menu__button').click()`)
    await until(`!!document.querySelector('.pane-menu')`, 'a pane menu')
    return items('.pane-menu')
  }
  const closeMenus = async () => {
    for (let i = 0; i < 3 && await run(`!!document.querySelector('.superego-menu')`); i++) {
      await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
      await t.settled()
    }
    await until(`!document.querySelector('.superego-menu')`, 'menus closed')
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  for (const pane of [diff, editor]) {
    if (await run(`!!document.querySelector('[data-column="${pane}"] .panes__tab .view-menu__button')`)) t.fail(`a pane with nowhere to move: no ···`)
  }
  await open('threads.details', {}, `!!document.querySelector('.panes__column .threads-details')`)
  const details = (await paneIds()).at(-1)
  const shown = await menuOf(details)
  if (!same(shown, ['Maximize⌘⇧↩', 'Move to', 'Close⌘W'])) t.fail(`a view's pane's menu: Maximize, Move to and Close, not ${shown}`)
  await run(`[...document.querySelectorAll('.pane-menu .superego-menu__item')].find((i) => i.textContent === 'Move to').click()`)
  await until(`!!document.querySelector('.view-menu__places [data-place]')`, 'Move to →')
  await both('tab-menu')
  await closeMenus()
  // The menu that opens panes: a right-click on an entry is its view's menu, which takes it out of there.
  await run(`document.querySelector('.thread__panes').click()`)
  await until(`document.querySelectorAll('.superego-menu .superego-menu__item').length > 0`, 'the menu that opens panes')
  const offered = await items('.superego-menu')
  await run(`(() => { const i = document.querySelector('.superego-menu .superego-menu__item'); const r = i.getBoundingClientRect(); i.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 10, clientY: r.top + 5 })) })()`)
  await until(`!!document.querySelector('.view-menu [data-remove]')`, 'an entry\'s own menu')
  if (await run(`document.querySelector('.view-menu [data-remove]').textContent`) !== 'Remove from pane menu') t.fail('an entry\'s menu: Remove from pane menu')
  await both('open-menu-entry')
  await run(`document.querySelector('.view-menu [data-remove]').click()`)
  await until(`![...document.querySelectorAll('.superego-menu .superego-menu__item')].some((i) => i.textContent === ${JSON.stringify(offered[0])})`, `${offered[0]} out of the menu that opens panes`)
  await closeMenus()

  // Its shortcut toggles it back.
  await key({ key: '|', code: 'Backslash', metaKey: true, shiftKey: true })
  await until(`!document.querySelector('.panes--stack')`, 'scrolled again')

  // Changes in a worktree thread: since main by default, its picker offering the uncommitted and the staged too; the
  // base picked kept in the pane's params.
  const { id: branchId } = await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)}, options: { worktrees: true }, title: 'On a branch' })`)
  const cwd = await run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${branchId}').cwd)`)
  const git = (...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=x', '-c', 'user.email=x@x', ...args])
  appendFileSync(join(cwd, 'README.md'), '\nCommitted on the branch.\n')
  git('commit', '-qam', 'branch work')
  writeFileSync(join(cwd, 'NOTES.md'), 'Staged.\n')
  git('add', 'NOTES.md')
  appendFileSync(join(cwd, 'README.md'), 'Not committed yet.\n')
  await until(`([...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('On a branch'))?.click(), document.querySelector('.thread__title')?.title === 'On a branch')`, 'the branch thread shown')
  await run(`window.superego.call('local', 'pane.open', { thread: '${branchId}', kind: 'diff' })`)
  await until(`document.querySelector('.git-base')?.textContent.startsWith('Since ')`, 'Changes since main')
  await run(`document.querySelector('.git-base').click()`)
  await until(`document.querySelectorAll('.superego-menu__item').length === 3`, 'the base picker')
  const bases = await items('.superego-menu')
  if (!same(bases.slice(0, 2), ['Uncommitted', 'Staged']) || !bases[2].startsWith('Since ')) t.fail(`bases: Uncommitted, Staged, Since main, not ${bases}`)
  await both('changes-base')
  await run(`[...document.querySelectorAll('.superego-menu__item')].find((i) => i.textContent.startsWith('Staged')).click()`)
  await until(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${branchId}').panes[0].params?.base === 'staged')`, 'staged kept in the pane')
  await until(`!document.querySelector('.superego-menu') && document.querySelector('.git-base')?.textContent === 'Staged' && document.querySelectorAll('.diff-file').length === 1`, 'the staged changes')
  await both('changes-staged')
})
