// Screenshots of the window's layout (run by test/look.sh): the sidebar shown and hidden (the threads as dots); the thread
// alone (and dragged narrower) and with Changes beside it (and a file past it); a long title, parent and branch; thread
// details, their menu and the layout's file beside the thread; ⌘U's unread list; a phone, its drawer open, a data view in it, the thread's sheet; a data view
// as a space; the first-launch page, ⌘N's dialog, Settings and its Keyboard; light and dark. Into $SUPEREGO_SHOWCASE_OUT.
import { openApp } from './harness.mjs'
import { threads } from './showcase/threads.mjs'

await openApp({ name: 'look', timeout: 180_000 }, async (t) => {
  const { run, until } = t
  const [width, height] = (process.env.LOOK_SIZE ?? '1100x760').split('x').map(Number)
  await t.resize(width, height)
  // A fresh home: the first-launch page, before any thread.
  await until(`document.querySelectorAll('.onboarding .onboarding__extension').length > 1`, 'the first-launch page')
  await t.both('onboarding')
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const state = (id) => `window.superego.call('local', 'thread.list', {}).then((list) => list.find((s) => s.id === '${id}')?.status.state)`
  const turnOn = async (id, text) => {
    await run(`window.superego.call('local', 'thread.seen', { thread: '${id}' })`)
    await run(`window.superego.call('local', 'thread.send', { thread: '${id}', text: ${JSON.stringify(text)} })`)
    await until(`${state(id)}.then((s) => s === 'done' || s === 'error')`, `answer in ${id}`)
  }
  const ids = []
  for (const thread of threads.slice(0, 2)) {
    const { id } = await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)} })`)
    ids.push(id)
    await turnOn(id, thread.prompt)
    for (const text of thread.followUps) await turnOn(id, text)
  }
  // One left unseen, one shown.
  const id = ids[0]
  await run(`window.superego.call('local', 'thread.seen', { thread: '${id}' })`)
  const title = await run(`window.superego.call('local', 'thread.list', {}).then((list) => list.find((t) => t.id === '${id}').title)`)
  await run(`[...document.querySelectorAll('.superego-list-item, .threads-rail__dot')].find((li) => (li.textContent + li.getAttribute('aria-label')).includes(${JSON.stringify(title)}.slice(0, 12)))?.click()`)
  await until(`document.querySelectorAll('.transcript .msg').length >= 2`, 'thread shown')
  const out = process.env.SUPEREGO_SHOWCASE_OUT
  const setting = (key, value) => run(`window.superego.call('app', 'app.settings.set', { key: '${key}', value: ${JSON.stringify(value)} })`)
  const end = () => run(`document.querySelectorAll('.thread__scroll').forEach((el) => { el.scrollTop = el.scrollHeight })`)
  const both = async (name) => {
    for (const theme of ['light', 'dark']) {
      await t.theme(theme)
      await end()
      await t.settled()
      await t.shot(`${name}-${theme}`)
    }
  }
  await both('open')
  // ⌘U: the unread threads (the one left unseen), to pick one.
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', metaKey: true, bubbles: true }))`)
  await until(`!!document.querySelector('.unread-list .unread-list__title')`, 'the unread list')
  await t.settled()
  await both('unread')
  await run(`document.querySelector('.unread-list .palette__input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await until(`!document.querySelector('.unread-list')`, 'the unread list closed')
  // A right-click on a space in the rail: its menu.
  await run(`(() => { const b = document.querySelector('.app__rail .superego-context[data-view="threads.list"] button'); const r = b.getBoundingClientRect()
    b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })) })()`)
  await until(`!!document.querySelector('.view-menu')`, 'rail menu')
  await t.settled()
  await both('rail-menu')
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await until(`!document.querySelector('.view-menu')`, 'rail menu closed')
  // The sidebar's edge: dragged to its least and its most; past its least, dimmed as letting go would hide it; let go
  // there, hidden (the threads as dots); dragged out from the rail, the list again; a double click puts its width back.
  const sidebarWidth = () => run(`document.querySelector('.app__sidebar')?.offsetWidth ?? 0`)
  const edge = (dx, { up = true } = {}) => run(`(() => { const h = document.querySelector('.app__edge'); const r = h.getBoundingClientRect(); const x = r.left, y = r.top + r.height / 2
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + ${dx}, clientY: y }))
    ${up ? `window.dispatchEvent(new PointerEvent('pointerup', { clientX: x + ${dx}, clientY: y }))` : ''} })()`)
  await edge(180 - await sidebarWidth())
  await until(`window.superego.call('app', 'settings.watch', {}).then((r) => r.value.values['app.sidebar.width'] === 180)`, 'sidebar at 180')
  await t.settled()
  console.log('sidebar least:', await sidebarWidth())
  await both('sidebar-180')
  await edge(420 - await sidebarWidth())
  await until(`window.superego.call('app', 'settings.watch', {}).then((r) => r.value.values['app.sidebar.width'] === 420)`, 'sidebar at 420')
  await t.settled()
  console.log('sidebar most:', await sidebarWidth())
  await both('sidebar-420')
  await edge(120 - await sidebarWidth(), { up: false })
  await t.settled()
  await both('sidebar-hiding')
  await run(`window.dispatchEvent(new PointerEvent('pointerup', { clientX: 0, clientY: 0 }))`)
  await until(`!!document.querySelector('.threads-rail') && !document.querySelector('.app.is-hiding')`, 'hidden, the threads as dots')
  await t.settled()
  await both('sidebar-hidden')
  await edge(300)
  await until(`!!document.querySelector('.threads-project')`, 'dragged out from the rail')
  await t.settled()
  console.log('sidebar dragged out:', await sidebarWidth())
  await both('sidebar-out')
  await run(`document.querySelector('.app__edge').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await until(`window.superego.call('app', 'settings.watch', {}).then((r) => r.value.values['app.sidebar.width'] === 232)`, 'sidebar width reset')
  // The thread alone, dragged narrower from its handle at the row's end, then put back with a double click.
  const handle = `[...document.querySelectorAll('.panes__gap')].at(-1)`
  const dragBy = (dx) => run(`(() => { const h = ${handle}; const r = h.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + ${dx}, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: x + ${dx}, clientY: y })) })()`)
  await dragBy(-360)
  await t.settled()
  console.log('dragged:', await run(`document.querySelector('.panes__column--thread').offsetWidth`))
  await both('open-dragged')
  await run(`${handle}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await t.settled()
  console.log('reset:', await run(`document.querySelector('.panes__column--thread').offsetWidth`))
  console.log('open:', await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'diff' }).then((r) => JSON.stringify(r), (e) => 'ERR ' + e.message)`))
  await until(`!!document.querySelector('.git-changes, .diff-file')`, 'changes')
  console.log('pane:', await run(`document.querySelector('.panes__column:last-child')?.innerText.slice(0, 200)`))
  await t.settled()
  await both('open-changes')
  // Changes focused, a file beside it off to the right.
  await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'editor', params: { path: 'README.md' } })`)
  await until(`!!document.querySelector('.file-editor')`, 'editor')
  const panesOf = () => run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${id}').panes.map((p) => p.id))`)
  const [diffId, editorId] = await panesOf()
  await run(`window.superego.call('local', 'pane.focus', { thread: '${id}', pane: '${diffId}' })`)
  await t.settled()
  await run(`document.querySelector('[data-column="${diffId}"]')?.focus()`)
  await both('open-changes-file')
  await run(`window.superego.call('local', 'pane.close', { thread: '${id}', pane: '${editorId}' })`)
  await run(`document.activeElement?.blur()`)
  await until(`!document.querySelector('[data-column="${editorId}"]')`, 'the file closed')
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true }))`)
  await until(`!document.querySelector('.app__sidebar')`, 'the sidebar hidden')
  await both('dots-changes')
  // Focus shown: the thread holds the keyboard.
  await run(`document.querySelector('.composer textarea')?.focus()`)
  await both('dots-changes-composer')
  await run(`document.activeElement?.blur()`)
  const paneId = await run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${id}').panes[0].id)`)
  await run(`window.superego.call('local', 'pane.close', { thread: '${id}', pane: '${paneId}' })`)
  await until(`!document.querySelector('[data-column="${paneId}"]')`, 'Changes closed')
  await both('dots')
  // A long title, a parent and a long branch, then archived: the title bar fits the window, wide and at its narrowest.
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true }))`)
  const long = 'Make the next and previous thread keys follow the order the sidebar shows them in, children under their parents'
  const { id: longId } = await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)}, options: { worktrees: true }, parent: '${id}', title: ${JSON.stringify(long)} })`)
  await until(`([...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('Make the next'))?.click(), document.querySelector('.thread__title')?.title === ${JSON.stringify(long)})`, 'long thread shown')
  const tight = async (name) => {
    await both(name)
    for (const narrow of [860, 600]) {
      await t.resize(narrow, height)
      await both(`${name}-${narrow}`)
    }
    await t.resize(width, height)
  }
  await tight('long')
  await run(`window.superego.call('local', 'thread.archive', { thread: '${longId}' })`)
  await until(`!!document.querySelector('.thread__unarchive')`, 'archived')
  await tight('long-archived')
  // Thread details beside the thread (⌘I), then a phone's width: the thread under its bar, and the drawer open.
  await until(`([...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes(${JSON.stringify(title)}.slice(0, 12)))?.click(), document.querySelector('.thread__title')?.title === ${JSON.stringify(title)})`, 'first thread shown again')
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', metaKey: true, bubbles: true }))`)
  await until(`!!document.querySelector('.threads-details')`, 'details')
  await both('details')
  // Its ··· menu, then the layout's file from there.
  await run(`document.querySelector('.placed-view .view-menu__button').click()`)
  await until(`[...document.querySelectorAll('.view-menu .superego-menu__item')].some((i) => i.textContent === 'Move to')`, 'view menu')
  await run(`[...document.querySelectorAll('.view-menu .superego-menu__item')].find((i) => i.textContent === 'Move to').focus()`)
  await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`)
  await t.settled()
  await both('details-menu')
  await run(`[...document.querySelectorAll('.view-menu .superego-menu__item')].find((i) => i.textContent === 'Edit layout…').click()`)
  await until(`!!document.querySelector('.layout-note')`, 'layout.json beside the thread')
  await t.settled()
  await both('layout-file')
  const layoutPane = await run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${id}').panes.at(-1).id)`)
  await run(`window.superego.call('local', 'pane.close', { thread: '${id}', pane: '${layoutPane}' })`)
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', metaKey: true, bubbles: true }))`)
  await until(`!document.querySelector('.threads-details')`, 'details hidden')
  // The window goes no narrower than 600: zoomed, its page is a phone's 375.
  await t.resize(600, height)
  await t.zoom(1.6)
  await both('phone')
  await run(`document.querySelector('.app__mobilebar button')?.click()`)
  await until(`!!document.querySelector('.app__sidebar')`, 'drawer')
  await both('phone-drawer')
  // A data view (the skills, placed as a space): in the drawer, switched to from its foot.
  await setting('app.layout', { place: { 'skills.view': 'space' } })
  await until(`!!document.querySelector('.app__drawer-bar [aria-label="Skills"]')`, 'Skills in the drawer')
  await run(`document.querySelector('.app__drawer-bar [aria-label="Skills"]').click()`)
  await until(`document.querySelector('.data-view--space')?.textContent.includes('$release')`, 'skills listed')
  await both('phone-data-view')
  await run(`document.querySelector('.app__drawer-bar [aria-label="Threads"]').click()`)
  await run(`document.querySelector('.app__scrim').click()`)
  // The thread's sheet: what the title bar holds wide as a menu, the panes to open, and (the model's row pressed) the details.
  await run(`document.querySelector('button.app__mobiletitle').click()`)
  await until(`!!document.querySelector('.thread-sheet')`, 'sheet')
  await both('phone-sheet')
  await run(`document.querySelector('.thread-sheet [data-item="view:threads.model"]').click()`)
  await until(`!!document.querySelector('.thread-sheet .threads-details')`, 'details in the sheet')
  await both('phone-sheet-details')
  await run(`document.querySelector('.thread-sheet [data-item="view:threads.model"]').click()`)
  await run(`document.querySelector('.app__scrim--sheet').click()`)
  // Wide again: the data view as a space, its button in the rail.
  await t.zoom(1)
  await t.resize(width, height)
  await until(`!!document.querySelector('.app__rail [aria-label="Skills"]')`, 'Skills in the rail')
  await run(`document.querySelector('.app__rail [aria-label="Skills"]').click()`)
  await until(`document.querySelector('.data-view--space')?.textContent.includes('$release')`, 'skills space')
  await t.settled()
  await both('data-view')
  await setting('app.layout', {})
  // ⌘N's dialog, with what extensions add to it.
  await t.click('.app__rail [aria-label="Threads"]')
  t.key('n')
  await until(`[...document.querySelectorAll('.new-thread .worktrees-check')].length > 0`, 'the new thread dialog')
  await t.both('new-thread')
  // ⌃2: the folder, its list of the folders this machine's threads worked in open under it.
  t.key('2', ['control'])
  await until(`document.activeElement?.getAttribute('aria-label') === 'Folder' && !!document.querySelector('.folder-field__list')`, 'the folder list')
  await t.both('new-thread-folders')
  t.key('Escape', [])
  await until(`!document.querySelector('.folder-field__list') && !!document.querySelector('.new-thread')`, 'only the folder list closed')
  t.key('Escape', [])
  await until(`!document.querySelector('.new-thread')`, 'the new thread dialog closed')
  // Settings: the app's own, and its Keyboard with a clash in it.
  await t.click('.app__settings')
  await until(`document.querySelector('.settings')?.textContent.includes('Appearance')`, 'Settings')
  await t.both('settings')
  await setting('app.keys', { 'app.sidebar': 'mod+shift+r', 'app.palette': 'mod+shift+r' })
  await until(`Boolean(document.querySelector('[data-action="app.sidebar"] .keymap__clash'))`, 'a clash in Keyboard')
  await t.both('keyboard', `document.querySelector('.keymap').scrollIntoView()`)
  await setting('app.keys', {})
  console.log(`look: done in ${out}`)
})
