// The window as a session: reloaded as it was left, nothing of the page before left listening; a thread finishing while
// the window is away notifies and counts on the app icon; ⌘. to it; a second window (⌘⇧N); archived and Ego's threads;
// the focus drawn in every column, a terminal, attachments, a long thread paged in, and suggestions.
import { BrowserWindow, app } from 'electron'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync } from 'node:fs'
import { clickInto, home, openRow, pageAt, row } from './common.mjs'

export default async function session(t, s) {
  // The window as it was left, after a reload: the same thread selected, its unsent draft still there.
  await t.run(`document.querySelector('.composer textarea').focus()`)
  t.contents().insertText('half a thought')
  await t.until(`document.querySelector('.composer textarea').value === 'half a thought'`, 'draft typed')
  t.contents().reload()
  await t.until(`document.querySelector('.thread__title')?.textContent === 'panes' && document.querySelector('.composer textarea')?.value === 'half a thought'`, 'selection and draft kept across a reload')
  await t.run(`document.querySelector('.composer textarea').select()`)
  t.key('Backspace', [])
  await t.until(`document.querySelector('.composer textarea').value === ''`, 'draft cleared')
  // A reload leaves nothing of the page before: its settings watches stop (none hears a change made after it), and a
  // thread asked for as it loads (a notification clicked, `superego open`) shows once the new page listens.
  {
    const contents = t.contents()
    const heard = new Set()
    const send = contents.send
    contents.send = function (channel, event, ...rest) {
      if (event?.method === 'settings.changed') heard.add(event.params.sub)
      return send.call(this, channel, event, ...rest)
    }
    // The main process tells every watch of a change in one go: once one has heard it, all have.
    const changeHeard = async (value) => {
      heard.clear()
      await t.call('app.settings.set', { key: 'app.font.mono', value }, 'app')
      await t.until(() => heard.size, 'a settings watch to hear a change')
      return new Set(heard)
    }
    const before = await changeHeard('Menlo')
    await t.run(`[...document.querySelectorAll('.superego-list-item')].find((li) => !li.classList.contains('is-selected')).click()`)
    await t.until(`document.querySelector('.thread__title')?.textContent !== 'panes'`, 'another thread, before the reload')
    // Once the new page is in, before it listens: the last one can't keep it for it.
    contents.once('did-navigate', () => app.emit('second-instance', {}, [`--superego-open=local/${s.paned}`]))
    contents.reload()
    await t.until(`document.querySelector('.thread__title')?.textContent === 'panes'`, 'the thread asked for during a reload, shown after it')
    const stale = [...await changeHeard(null)].filter((sub) => before.has(sub))
    contents.send = send
    if (stale.length) t.fail(`${stale.length} settings watches of the page before the reload still hear changes`)
  }
  // ⌘/ hides the sidebar and shows it again; Threads in the rail stays where it was.
  const toggleAt = () => t.run(`JSON.stringify(document.querySelector('.threads-rail__button').getBoundingClientRect())`)
  const at = await toggleAt()
  t.key('/')
  await t.until(`!document.querySelector('.app__sidebar')`, 'sidebar hidden')
  if (await toggleAt() !== at) t.fail('the sidebar button moved')
  t.key('/')
  await t.until(`Boolean(document.querySelector('.app__sidebar'))`, 'sidebar shown')
  // ⌃Tab: from where keyboard focus is (the prompt, in the thread), to each pane beside it, and around; ⌘W closes the
  // one it's in.
  await t.emulateFocus()
  await t.call('pane.open', { thread: s.paned, kind: 'diff' })
  await t.until(`Boolean(document.querySelector('.panes__tab'))`, 'a pane beside')
  await t.run(`document.querySelector('.composer textarea').focus()`)
  t.key('Tab', ['control'])
  await t.until(`Boolean(document.activeElement?.closest('[data-column]:not([data-column="thread"])'))`, 'ctrl+tab to the pane')
  t.key('Tab', ['control'])
  await t.until(`Boolean(document.activeElement?.closest('[data-column="thread"]'))`, 'ctrl+tab around to the thread')
  t.key('Tab', ['control'])
  await t.until(`Boolean(document.activeElement?.closest('[data-column]:not([data-column="thread"])'))`, 'and to the pane again')
  t.key('w')
  await t.until(`!document.querySelector('.panes__tab')`, 'diff closed')

  // Projects: the panes repository is one, the home folder another. With no window in front (headless, none ever is), a
  // thread finishing is a notification from the app (collected here, not shown).
  const elsewhere = s.elsewhere = `${home}/elsewhere`
  mkdirSync(elsewhere, { recursive: true })
  globalThis.superegoNotifications = []
  await t.run(`window.dispatchEvent(new Event('blur'))`)
  const other = s.other = (await t.call('thread.start', { cwd: elsewhere, title: 'elsewhere', prompt: 'hi' })).id
  await t.until(`[...document.querySelectorAll('.threads-project__name')].some((n) => n.textContent.startsWith('elsewhere'))`, 'a project per folder')
  await t.until(`Boolean(${row('elsewhere')}?.querySelector('.superego-status--done'))`, 'other thread done, in the window')
  // What it did, too: its answer's first sentence (the daemon's recap).
  await t.until(() => globalThis.superegoNotifications.some((n) => n.title === 'elsewhere' && n.thread === other && n.status === 'Done' && n.text === 'echo: hi'), 'a notification of the thread finishing')
  // The app icon counts it, as the main process sets it (headless, kept here, not shown).
  const unreadNow = await t.run(`window.superego.call('local', 'thread.list', {}).then((ts) => ts.filter((t) => ['done', 'error', 'blocked'].includes(t.status.state) && t.status.kind !== 'auth' && !t.quiet).length)`)
  if (!(unreadNow >= 1)) t.fail(`no thread unread: ${unreadNow}`)
  await t.until(() => globalThis.superegoBadge === unreadNow, `the app icon to say ${unreadNow} unread`)
  await t.run(`window.dispatchEvent(new Event('focus'))`)
  // ⌘. : the next thread with something unread. Each press goes to the next; looking at it marks it seen, so the presses
  // reach the new one.
  for (let press = 0; press < 6 && await t.run(`document.querySelector('.thread__title')?.textContent`) !== 'elsewhere'; press++) {
    const was = await t.run(`document.querySelector('.thread__title')?.textContent`)
    t.key('.')
    await t.until(`document.querySelector('.thread__title')?.textContent !== ${JSON.stringify(was)}`, 'cmd+. moved on')
    await t.until(`!document.querySelector('.app__sidebar .superego-list-item.is-selected :is(.superego-status--done, .superego-status--error, .superego-status--question, .superego-status--permission)')`, 'the thread shown, seen')
  }
  await t.until(`document.querySelector('.thread__title')?.textContent === 'elsewhere'`, 'cmd+. reached the unread thread')
  // Seen, it's no longer counted.
  await t.until(() => globalThis.superegoBadge < unreadNow, 'the app icon to count one fewer once the thread was seen')
  // Back and forward, with the sidebar open, sit over the list at its right edge, clear of the window's buttons.
  await t.check(`(() => { const back = document.querySelector('.app__back').getBoundingClientRect(), forward = document.querySelector('.app__forward').getBoundingClientRect(), list = document.querySelector('.app__sidebar').getBoundingClientRect(); return back.left >= 76 && Math.abs(list.right - 10 - forward.right) < 1 })()`, "back and forward not at the list's right edge")

  // ⌘⇧N: another window, starting as a copy of this one; then each goes its own way, and closing it closes only it.
  {
    const main = t.win()
    t.key('n', ['meta', 'shift'])
    const second = await t.until(() => BrowserWindow.getAllWindows().find((w) => w !== main), 'cmd+shift+n to open a window')
    const m = t.on(() => main.webContents, 'first window')
    const w2 = t.on(() => second.webContents, 'second window')
    const titled = (title) => `document.querySelector('.thread__title')?.textContent === ${JSON.stringify(title)}`
    await w2.until(titled('elsewhere'), 'the new window, a copy of the first')
    await w2.check(`!/[?&](seed|first)=/.test(location.search)`, 'the new window kept its seed, or is first')
    await w2.run(`${row('panes')}.click()`)
    await w2.until(titled('panes'), 'its own thread')
    await m.until(titled('elsewhere'), 'its thread, whatever the other shows')
    // Reloaded, each window comes back to its own.
    second.webContents.reload()
    await w2.until(titled('panes'), 'its own thread after a reload')
    const kept = () => JSON.parse(readFileSync(`${home}/windows.json`, 'utf8')).windows.map((w) => w.id)
    if (kept().length !== 2) t.fail(`not two windows kept: ${kept()}`)
    // Two windows open, a thread finishing is one notification: the app decides, not each window.
    globalThis.superegoNotifications = []
    const twice = (await t.call('thread.start', { cwd: elsewhere, title: 'twice', prompt: 'hi' })).id
    await t.until(() => globalThis.superegoNotifications.some((n) => n.thread === twice), 'a notification with two windows open')
    // Both windows have it finished, and have drawn that: a notification of either's would be in by now.
    for (const page of [m, w2]) {
      await page.until(`Boolean(${row('twice')}?.querySelector('.superego-status--done'))`, 'the finished thread in each window')
      await page.settled()
    }
    const ofTwice = globalThis.superegoNotifications.filter((n) => n.thread === twice)
    if (ofTwice.length !== 1) t.fail(`not one notification with two windows open: ${JSON.stringify(globalThis.superegoNotifications)}`)
    await t.call('thread.archive', { thread: twice })
    second.close()
    await t.until(() => second.isDestroyed(), 'the second window closed')
    if (main.isDestroyed() || BrowserWindow.getAllWindows().length !== 1) t.fail('closing one window closed another')
    const id = await m.run(`new URLSearchParams(location.search).get('window')`)
    if (kept().join() !== id) t.fail(`the closed window was kept: ${kept()}`)
    await m.until(titled('elsewhere'), 'the first window as it was')
  }

  // Superego's own agent: from the rail, one thread in Superego's data folder, the same one each time, in no list. Its
  // tab is in front while it shows, alone: no sidebar. The Threads tab goes back to the listed thread it left.
  const threadsTab = `document.querySelector('.app__rail [aria-label="Threads"]')`
  await t.click('.ego__button')
  await t.until(`document.querySelector('.thread__title')?.textContent === 'Ego' && document.querySelector('.ego__button').classList.contains('is-on') && !document.querySelector('.app__sidebar .superego-list-item.is-selected')`, 'Ego opened, not in the sidebar')
  await t.until(`!document.querySelector('.app__sidebar') && !${threadsTab}.classList.contains('is-on') && document.querySelector('.app__rail').dataset.tab === 'alone'`, 'Ego alone, its tab in front')
  const ego = (await t.call('ego.ask')).id
  await t.run(`${threadsTab}.click()`)
  await t.until(`document.querySelector('.thread__title')?.textContent === 'elsewhere'`, 'away from it')
  await t.click('.ego__button')
  await t.until(`document.querySelector('.thread__title')?.textContent === 'Ego'`, 'the same one again')
  if ((await t.call('ego.ask')).id !== ego) t.fail('a second Ego')
  if ((await t.call('thread.list')).some((x) => x.facts?.ego)) t.fail('Ego listed')
  // Cleared from its title bar: the same thread, empty again.
  await t.call('thread.send', { thread: ego, text: 'what is a profile?' })
  await t.until(`[...document.querySelectorAll('.msg--user')].some((m) => m.textContent.includes('what is a profile?'))`, 'asked Ego')
  // An outside agent's message shows as one; the user's doesn't.
  await t.call('action.run', { id: 'ego.ask', params: { prompt: 'and from an agent?' }, exposure: 'outside' })
  await t.until(`[...document.querySelectorAll('.msg--user')].some((m) => m.textContent.includes('and from an agent?') && [...m.querySelectorAll('.attachment--chip')].some((c) => c.textContent === 'Outside agent') && !m.textContent.includes('<outside-agent>'))`, "an outside agent's message to Ego, marked")
  await t.check(`[...document.querySelectorAll('.msg--user')].find((m) => m.textContent.includes('what is a profile?')).querySelector('.ego__outside') === null`, "the user's message marked as an outside agent's")
  await t.until(`(document.querySelector('.transcript')?.textContent.split('echo:').length ?? 0) > 2`, 'Ego answered both')
  await t.click('.ego__clear')
  await t.until(`document.querySelector('.thread__title')?.textContent === 'Ego' && !document.querySelector('.msg--user')`, 'Ego cleared')
  await t.run(`${threadsTab}.click()`)
  await t.until(`document.querySelector('.thread__title')?.textContent === 'elsewhere'`, 'back to a listed thread')
  await t.until(`Boolean(document.querySelector('.app__sidebar .superego-list-item.is-selected')) && ${threadsTab}.classList.contains('is-on')`, 'the sidebar back, Threads in front')

  // A thread's row pressed with the mouse: the sidebar takes the focus, and hands it on to the thread opened, without
  // wearing its ring in between.
  const sideRing = `getComputedStyle(document.querySelector('.app')).getPropertyValue('--side-ring').trim()`
  {
    const at = await t.run(`(() => { const r = document.querySelector('.app__sidebar .superego-list-item:not(.is-selected)').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    t.contents().sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at })
    await t.until(`document.activeElement?.matches('.app__sidebar .superego-list-item')`, 'a row pressed: the focus in the sidebar')
    if (await t.run(sideRing)) t.fail('a row pressed with the mouse: the sidebar ringed')
    t.contents().sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...at })
    await t.until(`document.activeElement?.matches('.composer textarea') && document.querySelector('.thread__title')?.textContent !== 'elsewhere'`, 'a row clicked: the focus on to its thread')
    await t.run(`[...document.querySelectorAll('.app__sidebar .superego-list-item')].find((li) => li.textContent.includes('elsewhere')).click()`)
    await t.until(`document.querySelector('.thread__title')?.textContent === 'elsewhere'`, 'back to the thread before')
  }

  // Focus: ⌘⌥← from the prompt goes to the sidebar, on the selected thread; ↓ moves along it; ⌘⌥→ comes back to the
  // thread itself; ⌃I goes to the prompt from anywhere, and esc leaves it for the thread. Wherever it is, it's drawn.
  await t.run(`document.querySelector('.composer textarea').focus()`)
  t.key('Left', ['meta', 'alt'])
  await t.until(`document.activeElement?.matches('.app__sidebar .superego-list-item.is-selected')`, 'focus to the sidebar, on the selected thread')
  await t.until(sideRing, 'the sidebar ringed, reached from the keyboard')
  const ring = await t.run(`getComputedStyle(document.activeElement).outlineStyle`)
  t.key('Down', [])
  await t.until(`document.activeElement?.matches('.app__sidebar .superego-list-item:not(.is-selected)')`, 'down the sidebar')
  t.key('Right', ['meta', 'alt'])
  await t.until(`document.activeElement?.matches('.thread__scroll')`, 'focus back to the thread')
  t.key('Left', ['meta', 'alt'])
  t.key('i', ['control'])
  await t.until(`document.activeElement?.matches('.composer textarea')`, 'ctrl+i to the prompt')
  t.key('Escape', [])
  await t.until(`document.activeElement?.matches('.thread__scroll')`, 'esc from the prompt to the thread')
  t.key('i', ['control'])
  await t.until(`document.activeElement?.matches('.composer textarea')`, 'ctrl+i back to the prompt')
  if (ring !== 'solid') t.fail(`focus not drawn: ${ring}`)
  // Every column draws the focus it holds, the same way: a page's (whose own focus the window can't see), from the
  // keyboard and from a click into it, and a pane with nothing in it to focus but itself.
  const another = createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end('<body style="height:100vh">A page</body>') })
  await new Promise((resolve) => another.listen(0, '127.0.0.1', resolve))
  // The column wearing the ring, and the one brought forward (its title lit): focus moving into a column brings it.
  const ringed = (label) => t.until(`(() => {
    const ringed = [...document.querySelectorAll('.panes > [data-column]')].filter((c) => getComputedStyle(c).boxShadow.includes('0px 0px 0px 4px'))
    return ringed.length === 1 && (ringed[0].querySelector('.panes__label')?.textContent ?? 'thread') === ${JSON.stringify(label)}
  })()`, `only ${label} ringed`)
  const front = (label) => t.until(`(document.querySelector('.panes__tab.is-active .panes__label')?.textContent ?? 'thread') === ${JSON.stringify(label)}`, `${label} brought forward`)
  const closeBeside = () => t.run(`window.superego.call('local', 'pane.close', { thread: '${other}', pane: document.querySelector('[data-column]:not([data-column="thread"])').dataset.column })`)
  await t.call('pane.open', { thread: other, kind: 'browser', params: { url: `http://127.0.0.1:${another.address().port}/` } })
  await t.until(() => pageAt(`http://127.0.0.1:${another.address().port}/`), 'a page beside the thread')
  await t.run(`document.querySelector('.composer textarea').focus()`)
  await ringed('thread')
  // The page's keyboard, as the window gives it (a hidden window's view never has the system's focus to show).
  const shown = pageAt(`http://127.0.0.1:${another.address().port}/`)
  let given = 0
  const giveFocus = shown.focus
  shown.focus = function () { given++; return giveFocus.call(this) }
  t.key('Right', ['meta', 'alt'])
  await t.until(`document.activeElement?.matches('.web-view')`, 'cmd+alt+right into the pane')
  await ringed('Browser')
  await front('Browser')
  // The pane has the keyboard, not the page, and says so; Return passes it in.
  const hint = `[...document.querySelectorAll('.browser-hint')].some((h) => h.textContent === '↩ to use the page')`
  await t.until(hint, 'the hint in the pane\'s header')
  await t.settled()
  if (given) t.fail('the page took the keyboard as its pane was focused')
  t.key('Return', [])
  await t.until(() => given === 1, 'return passes the keyboard into the page')
  await t.until(`!(${hint})`, 'the hint gone')
  shown.focus = giveFocus
  // Out of it again: the page has the keyboard, so the window takes the key before it.
  for (const type of ['keyDown', 'keyUp']) shown.sendInputEvent({ type, keyCode: 'Left', modifiers: ['meta', 'alt'] })
  await t.until(`document.activeElement?.matches('.thread__scroll')`, 'cmd+alt+left out of the page')
  await ringed('thread')
  await front('thread')
  clickInto(t, pageAt(`http://127.0.0.1:${another.address().port}/`))
  await t.until(`document.activeElement?.matches('.web-view')`, 'a click into the page')
  await ringed('Browser')
  await front('Browser')
  await closeBeside()
  another.close()
  // ⌘⇧D: Changes (git's), beside the thread, its tab in the strip.
  t.key('D', ['meta', 'shift'])
  await t.until(`[...document.querySelectorAll('.strip__tab')].some((t) => t.textContent.startsWith('Changes'))`, 'cmd+shift+d: changes beside the thread')
  await t.run(`document.querySelector('.composer textarea').focus()`)
  t.key('Right', ['meta', 'alt'])
  await t.until(`document.activeElement?.matches('[data-column]:not([data-column="thread"])')`, 'cmd+alt+right to the pane itself')
  await ringed('Changes')
  await t.run(`document.querySelector('.composer textarea').focus()`)
  await ringed('thread')
  // A click on its title, as on the rest of its own parts, takes the focus into it.
  await t.mouse('.panes__label')
  await t.until(`document.activeElement?.matches('[data-column]:not([data-column="thread"])')`, 'a click on the title, into the pane')
  await closeBeside()
  await t.until(`!document.querySelector('.panes__tab')`, 'changes closed')
  // ⌃`: a terminal beside the thread (terminal's), its shell on the machine, with the focus; typed into and read back.
  t.key('`', ['control'])
  await t.until(`Boolean(document.querySelector('.terminal-pane__screen canvas')) && document.activeElement?.closest('.terminal-pane') !== null`, 'ctrl+`: a terminal with the focus')
  await ringed('Terminal')
  await t.until(`document.querySelector('.terminal-pane__screen').text().trim().length > 0`, "the shell's prompt")
  await t.run(`(() => { const screen = document.querySelector('.terminal-pane__screen')
    for (const ch of 'echo "smoke-$((2*21))"\\n') screen.dispatchEvent(new KeyboardEvent('keydown', { key: ch === '\\n' ? 'Enter' : ch, code: ch === '\\n' ? 'Enter' : '', bubbles: true, cancelable: true })) })()`)
  await t.until(`document.querySelector('.terminal-pane__screen').text().includes('smoke-42')`, "the shell's answer in the terminal")
  await closeBeside()
  await t.until(`!document.querySelector('.panes__tab')`, 'terminal closed')

  // Attachments: a file picked with Attach (under the box; on a phone, the + beside it) waits in the box, then goes with the message and shows under it.
  await t.run(`(() => {
    const input = document.querySelector('.dock input[type=file]')
    const files = new DataTransfer()
    files.items.add(new File(['# plan\\n'], 'plan.md', { type: 'text/markdown' }))
    input.files = files.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await t.until(`document.querySelector('.composer__files .attachment__name')?.textContent === 'plan.md'`, 'file waiting to be sent')
  await t.run(`document.querySelector('.composer textarea').focus()`)
  t.contents().insertText('read this')
  await t.until(`document.querySelector('.composer textarea').value === 'read this'`, 'text typed')
  t.key('Enter', [])
  await t.until(`[...document.querySelectorAll('.msg--user')].some((m) => m.textContent.includes('read this') && m.querySelector('.msg__files .attachment__name')?.textContent === 'plan.md') && !document.querySelector('.composer__files')`, 'file sent with the message')

  // Scrolling back: a thread longer than its watch holds pages in its earlier messages as the top comes near.
  const long = (await t.call('thread.start', { cwd: elsewhere, title: 'long' })).id
  for (let i = 0; i < 30; i++) {
    await t.call('thread.send', { thread: long, text: `message ${i}` })
    await t.until(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${long}').status.state === 'done')`, `long thread turn ${i}`)
  }
  await t.call('thread.seen', { thread: long })
  await openRow(t, 'long')
  // At its end once the view has kept it there (the frame after its entries are drawn): scrolled before that, the
  // scroll below moves nothing and the view, rightly, still counts itself at its end.
  const scroller = `document.querySelector('[data-column="thread"] .thread__scroll')`
  await t.until(`document.querySelector('.thread__title')?.textContent === 'long' && document.querySelector('.transcript')?.textContent.includes('message 29') && (() => { const el = ${scroller}; return el.scrollTop > 0 && el.scrollHeight - el.scrollTop - el.clientHeight < 40 })()`, 'the long thread, at its end')
  await t.check(`!document.querySelector('.transcript').textContent.includes('echo: message 0')`, 'the whole long thread came at once')
  // Each try scrolls to the top again: what's paged in above moves it down.
  await t.until(`(() => { const el = ${scroller}; el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); return document.querySelector('.transcript').textContent.includes('echo: message 0') && !document.querySelector('.transcript__more') })()`, 'scrolled back to the first message')
  // Scrolled up, the composer offers the way back down; taking it hides it again.
  await t.until(`Boolean(document.querySelector('[data-column="thread"] .dock__jump'))`, 'jump to bottom offered')
  await t.click('[data-column="thread"] .dock__jump')
  await t.until(`(() => { const el = ${scroller}; return el.scrollHeight - el.scrollTop - el.clientHeight < 40 && !document.querySelector('.dock__jump') })()`, 'jumped to the bottom')

  // Suggestions: numbered over the composer once the agent has answered (the echo model echoes them back from the
  // message). ⌃n sends the one with that number, from the thread as from the prompt; a number past them does nothing.
  const suggesting = (await t.call('thread.start', { cwd: elsewhere, title: 'suggesting' })).id
  await t.call('thread.send', { thread: suggesting, text: 'next? ["Run the tests", "Commit this"]' })
  await openRow(t, 'suggesting')
  await t.until(`[...document.querySelectorAll('.suggestions__item')].map((b) => b.textContent).join('|') === '${process.platform === 'darwin' ? '⌃1Run the tests|⌃2Commit this' : 'Ctrl+1Run the tests|Ctrl+2Commit this'}'`, 'suggestions with their keys')
  await t.run(`document.querySelector('[data-column="thread"] .thread__scroll').focus()`)
  const sent = `[...document.querySelectorAll('.msg--user')].map((m) => m.textContent)`
  t.key('3', ['control'])
  t.key('2', ['control'])
  await t.until(`${sent}.some((t) => t.includes('Commit this') && !t.includes('['))`, 'ctrl+2 sent the second suggestion')
  if (await t.run(`${sent}.length`) !== 2) t.fail(`ctrl+3 or ctrl+2 sent more: ${await t.run(`${sent}.join(' | ')`)}`)
}
