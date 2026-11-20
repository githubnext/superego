// The window's frame, as only a real window lays it out: the sidebar's edge dragged (a width kept for every window), a
// view that draws nothing taking no room, the layout as text in layout.json (written, read back, its mistakes noted), and
// ⌘N's dialog with what bundled extensions add to it; a thread whose profile is gone, offering another as you send.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { home, openNotice, openRow } from './common.mjs'

export default async function layout(t) {
  // Unread results elsewhere: a dot on Threads in the rail, and the thread's own in the list, to go to.
  await t.call('thread.start', { title: 'unread elsewhere', prompt: 'finish elsewhere' })
  await t.until(`Boolean(document.querySelector('.threads-rail__button .threads-rail__badge--done'))`, 'unread dot on Threads')
  await openRow(t, 'unread elsewhere')
  await t.until(`document.querySelector('.thread__title')?.textContent === 'unread elsewhere'`, 'went to the unread thread')

  // The sidebar's edge: dragged, a width kept for every window; let go short, hidden, then ⌘/ brings it back as wide as
  // it was; dragged out from the rail, the list again; a double click puts its width back.
  const edge = (dx) => t.run(`(() => { const h = document.querySelector('.app__edge'); const r = h.getBoundingClientRect(); const x = r.left, y = r.top + r.height / 2
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + ${dx}, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: x + ${dx}, clientY: y })) })()`)
  const sidebarIs = (width) => `window.superego.call('app', 'settings.watch', {}).then((r) => r.value.values['app.sidebar.width'] === ${width} && document.querySelector('.app__sidebar')?.offsetWidth === ${width})`
  await edge(300 - await t.run(`document.querySelector('.app__sidebar').offsetWidth`))
  await t.until(sidebarIs(300), 'sidebar dragged to 300')
  await edge(-200)
  await t.until(`!document.querySelector('.app__sidebar') && Boolean(document.querySelector('.threads-rail'))`, 'dragged short, hidden')
  t.key('/')
  await t.until(sidebarIs(300), 'shown as wide as it was')
  await edge(-200)
  await t.until(`Boolean(document.querySelector('.threads-rail'))`, 'hidden again')
  await edge(250)
  await t.until(`Boolean(document.querySelector('.threads-project')) && ${sidebarIs(250)}`, 'dragged out from the rail')
  await t.run(`document.querySelector('.app__edge').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await t.until(sidebarIs(232), 'width put back')

  // The details beside the thread. A view that draws nothing takes no room beside the thread, nor its ···; with only
  // such views, there's no beside.
  t.key('i')
  await t.until(`Boolean(document.querySelector('.app__beside .threads-details'))`, 'details beside the thread')
  await t.check(`(() => {
    const beside = document.querySelector('.app__beside')
    const empty = document.createElement('div')
    empty.className = 'placed-view'
    empty.innerHTML = '<button class="view-menu__button"></button>'
    beside.append(empty)
    const hidden = getComputedStyle(empty).display === 'none' && getComputedStyle(beside).display !== 'none'
    const alone = Object.assign(document.createElement('aside'), { className: 'app__beside' })
    alone.append(empty)
    document.body.append(alone)
    const gone = getComputedStyle(alone).display === 'none'
    alone.remove()
    return hidden && gone
  })()`, 'an empty view takes room, or a column beside of only those shows')

  // The layout as text: layout.json has the window's layout, and the views at its head; Edit layout… opens it beside the
  // thread.
  const layoutNow = `window.superego.call('app', 'settings.watch', {}).then((r) => JSON.stringify(r.value.values['app.layout'] ?? {}))`
  await t.call('app.settings.set', { key: 'app.layout', value: { place: { 'threads.details': 'beside' } } }, 'app')
  const layoutFile = `${home}/layout.json`
  // Written out, the change in it: what's typed into it below mustn't race the window's write.
  await t.until(() => { try { const text = readFileSync(layoutFile, 'utf8'); return text.includes('//   threads.details') && text.includes('"threads.details": "beside"') } catch { return false } }, 'layout.json written')
  await t.click('.placed-view[data-view="threads.details"] .view-menu__button')
  await t.until(`[...document.querySelectorAll('.view-menu .superego-menu__item')].some((i) => i.textContent === 'Edit layout…')`, 'the view menu')
  await t.click('.view-menu .superego-menu__item', 'Edit layout…')
  await t.until(`document.querySelector('.layout-note')?.textContent === 'Applied as you save'`, 'layout.json in the editor beside the thread')
  // A mistake is noted, and the last good layout stays; fixed, it applies.
  writeFileSync(layoutFile, '{ "place": { "threads.details": ')
  await t.until(`document.querySelector('.layout-note.is-problem')?.textContent.includes('Not JSON') && Boolean(document.querySelector('.app__rail .rail-notice--layout')) && Boolean(document.querySelector('.app__beside .threads-details'))`, 'bad JSON noted, the details kept')
  // A notice up doesn't hold the sidebar open: hidden, it's gone and the threads are dots; the notice is in the rail.
  t.key('/')
  await t.until(`!document.querySelector('.app__sidebar') && Boolean(document.querySelector('.threads-rail .threads-rail__dot')) && Boolean(document.querySelector('.app__rail .rail-notice--layout'))`, 'hidden with the layout notice up')
  await openNotice(t, 'layout', 'the layout notice')
  await t.until(`document.querySelector('.rail-notice__popup .layout-notice')?.textContent.includes('Not JSON')`, 'the layout notice, in full')
  t.key('Escape', [])
  await t.until(`!document.querySelector('.rail-notice__popup')`, 'the layout notice closed')
  t.key('/')
  await t.until(`Boolean(document.querySelector('.app__sidebar .threads-project'))`, 'shown with the layout notice up')
  writeFileSync(layoutFile, '{ "place": { "threads.detail": "beside" } }')
  await t.until(`document.querySelector('.layout-note:not(.is-problem)')?.textContent.includes('not here now, kept for when they\\'re back: threads.detail') && !document.querySelector('.rail-notice--layout')`, 'a view not here applied, and noted')
  writeFileSync(layoutFile, '{}')
  // The whole check inside the promise: one before `&&` is truthy as it is, and wouldn't be waited for.
  await t.until(`${layoutNow}.then((l) => l === '{}' && !document.querySelector('.app__beside') && !document.querySelector('.rail-notice--layout'))`, 'the layout reset from the file')
  await t.run(`window.superego.call('local', 'thread.list', {}).then((list) => Promise.all(list.flatMap((t) => (t.panes ?? []).filter((p) => p.params?.path === ${JSON.stringify(layoutFile)}).map((p) => window.superego.call('local', 'pane.close', { thread: t.id, pane: p.id })))))`)
  await t.until(`!document.querySelector('.layout-note')`, 'layout.json closed')

  // ⌘N: the New thread dialog (window-dialogs.test.ts), with the worktrees extension's field in it.
  t.key('n')
  await t.until(`[...document.querySelectorAll('.new-thread .worktrees-check')].some((l) => l.textContent.includes('worktree'))`, "the worktrees extension's field in the new thread dialog")
  t.key('Escape', [])
  await t.until(`!document.querySelector('.new-thread')`, 'the new thread dialog closed')

  // A thread whose profile is gone from under it, with none of that name left: sending offers another in the error;
  // picked (the default), what was typed goes, and the thread runs that from now on. (Here, not in a window test: the
  // daemon imports profiles, which vitest's DOM environment can't, and a test window in the kit's own DOM drops typing.)
  const goneDir = `${home}/profiles/gone`
  mkdirSync(goneDir, { recursive: true })
  writeFileSync(`${goneDir}/profile.ts`, "import { defineProfile } from 'superego'\nexport default defineProfile({})\n")
  await t.call('thread.start', { title: 'orphaned', profile: 'gone' })
  rmSync(goneDir, { recursive: true })
  await openRow(t, 'orphaned')
  await t.until(`document.querySelector('.thread__profile')?.textContent === 'gone'`, 'orphaned thread open')
  await t.type('.composer textarea', 'still there?', { enter: true })
  await t.until(`Boolean(document.querySelector('.composer__error .profile-switch select'))`, 'its profile gone: another offered')
  await t.click('.profile-switch button', 'Send')
  await t.until(`document.querySelector('.thread__profile')?.textContent === 'default' && document.querySelector('.transcript')?.textContent.includes('echo: still there?') && document.querySelector('.transcript').textContent.includes('runs the default profile now') && !document.querySelector('.composer__error')`, 'switched to the default, and sent')
}
