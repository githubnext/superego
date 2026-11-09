// Headless end-to-end: the real app, the real daemon (scripted model), driven through the renderer.
// Phase "first" creates a thread and chats; phase "reopen" is a fresh app process that must find it on the same
// daemon, which outlived the first app. Run by test/smoke.sh.
import { app, BrowserWindow } from 'electron'

const phase = process.env.MU_SMOKE_PHASE ?? 'first'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
const fail = async (message) => {
  console.error(`smoke(${phase}): FAIL ${message}`)
  const window = BrowserWindow.getAllWindows()[0]
  if (window) console.error('POPOVER:', await window.webContents.executeJavaScript(`document.querySelector('.mu-font-picker__popover')?.textContent ?? 'none'`).catch(String))
  if (window) console.error('ROWS:', await window.webContents.executeJavaScript(`[...document.querySelectorAll('.machine-row')].map((r) => r.textContent).join(' | ')`).catch(String))
  if (window) console.error('DOM:', (await window.webContents.executeJavaScript('document.body.innerText').catch((e) => String(e))).slice(0, 2000))
  try { console.error('daemon.log:', readFileSync(`${process.env.MU_HOME}/daemon.log`, 'utf8').slice(-2000)) } catch {}
  app.exit(1)
}
// Any uncaught error in the main process fails the run; in the app it would be an error dialog.
process.on('uncaughtException', (error) => void fail(`uncaught in main: ${error.stack ?? error}`))
process.on('unhandledRejection', (error) => void fail(`unhandled in main: ${error?.stack ?? error}`))
app.on('web-contents-created', (_e, contents) => contents.on('console-message', (event) => console.error('renderer:', event.message)))
setTimeout(() => fail('timed out'), 90_000)

await import('../out/main/main.js')
// Top-level awaits on readiness would hold up Electron's ready event, so the test runs in a function.
void (async () => {
await app.whenReady()

const until = async (js, label, ms = 15_000) => {
  for (let i = 0; i < ms / 100; i++) {
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.webContents.isLoading()) {
      const value = await window.webContents.executeJavaScript(js).catch(() => undefined)
      if (value) return value
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await fail(`waiting for ${label}`)
  throw new Error('failed')
}
const STRAY = new URL('../out/main/zz-smoke-restart.js', import.meta.url).pathname
async function restartOntoNewCode(change) {
  const before = await run(`window.mu.machines().then((list) => list.find((m) => m.id === 'local'))`)
  change()
  await until(`document.querySelector('.service-notice')?.textContent.includes('Restart required')`, 'restart required shown')
  await run(`[...document.querySelectorAll('.service-notice button')].find((b) => b.textContent === 'Restart now').click()`)
  await until(`!document.querySelector('.service-notice')`, 'restart done', 40_000)
  const after = await run(`window.mu.call('local', 'hello', { client: 'smoke', version: 1 })`)
  if (after.machine.id !== before.machine.id || !(await run(`window.mu.call('local', 'thread.list', {})`)).length) { await fail('restart lost the machine or its threads'); throw new Error('failed') }
  return after
}
/** With MU_SMOKE_SHOTS=<dir>, a screenshot of the window at this point. */
const shot = async (name) => {
  if (!process.env.MU_SMOKE_SHOTS) return
  const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
  writeFileSync(`${process.env.MU_SMOKE_SHOTS}/${name}.png`, image.toPNG())
}
const run = (js, gesture = false) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(js, gesture)

await until(`Boolean(document.querySelector('.threads.is-ready'))`, 'local machine connected')

if (phase === 'first') {
  const id = await run(`window.mu.call('local', 'thread.create', { title: '' }).then((s) => s.id)`)
  await run(`window.mu.call('local', 'thread.submit', { id: '${id}', text: 'hello from smoke' })`)
  await until(`[...document.querySelectorAll('.mu-list-item')].some((li) => li.textContent.includes('hello from smoke'))`, 'thread in sidebar')
  await run(`[...document.querySelectorAll('.mu-list-item')].find((li) => li.textContent.includes('hello from smoke')).click()`)
  await until(`document.querySelector('.transcript')?.textContent.includes('echo: hello from smoke')`, 'answer rendered')
  await until(`document.querySelector('.thread__profile')?.textContent === 'default'`, "the user's default profile, shown in the header")
  await until(`document.querySelector('.smoke-badge')?.textContent === 'profile ui: hello from smoke'`, "the profile's own UI, loaded at runtime")
  await shot('main')
  // Type into the composer like a user: React needs the native setter and an input event.
  await run(`(() => {
    const ta = document.querySelector('.composer textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'typed message')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  await until(`document.querySelector('.transcript')?.textContent.includes('echo: typed message')`, 'typed answer rendered')
  // ask-user: a replayed agent asks; the question shows above the composer and the thread as needing you; an answer
  // from the card reaches it, and it carries on.
  await run(`window.mu.call('local', 'settings.set', { key: 'agent.model', value: 'replay/replay' })`)
  const asking = await run(`window.mu.call('local', 'thread.create', {}).then((s) => window.mu.call('local', 'thread.submit', { id: s.id, text: 'pick a colour' }).then(() => s.id))`)
  await run(`[...document.querySelectorAll('.mu-list-item')].find((li) => li.textContent.includes('pick a colour'))?.click()`)
  await until(`document.querySelector('.ask-user')?.textContent.includes('Which colour?')`, 'question card above the composer')
  await until(`[...document.querySelectorAll('.mu-list-item')].some((li) => li.textContent.includes('pick a colour') && li.querySelector('.mu-status--blocked'))`, 'thread marked as needing you')
  await run(`[...document.querySelectorAll('.ask-user button')].find((b) => b.textContent === 'blue').click()`)
  await until(`!document.querySelector('.ask-user') && document.querySelector('.ask-user-asked')?.textContent.includes('blue') && document.querySelector('.transcript').textContent.includes('Blue it is.')`, 'answered, agent carried on')
  await run(`window.mu.call('local', 'settings.set', { key: 'agent.model', value: 'faux/faux-1' })`)
  void asking
  // The sidebar's modes: the ··· menu (portalled, so a scrolling sidebar can't cut it off), ⌘\\ rail, ⌘I details.
  const key = async (keyCode, modifiers = ['meta']) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  await run(`document.querySelector('.threads-menu-trigger').click()`)
  await until(`[...document.querySelectorAll('.mu-menu .mu-menu__item')].some((i) => i.textContent.includes('Needs you first'))`, 'sidebar menu open')
  await shot('menu')
  await run(`[...document.querySelectorAll('.mu-menu .mu-menu__item')].find((i) => i.textContent.includes('Needs you first')).click()`)
  await until(`window.mu.call('app', 'settings.watch', {}).then((r) => r.value.values['threads.sort'] === 'status')`, 'sorted by status')
  await key('\\')
  await until(`Boolean(document.querySelector('.threads-rail.is-compact'))`, 'rail')
  await key('\\')
  await until(`Boolean(document.querySelector('.threads-session'))`, 'list again')
  await key('i')
  await until(`document.querySelector('.threads-details')?.textContent.includes('Machine')`, 'details pane')
  await key('i')
  await until(`!document.querySelector('.threads-details')`, 'details closed')
  await run(`window.mu.call('app', 'app.settings.set', { key: 'threads.sort', value: 'created' })`)
  // ⌘K is commands only; ⌘L finds a thread by name and opens it.
  await key('k')
  await until(`Boolean(document.querySelector('.palette__input'))`, 'palette')
  await until(`[...document.querySelectorAll('.palette__list li')].every((li) => !li.textContent.includes('hello from smoke'))`, 'no threads in the palette')
  await key('Escape', [])
  await key('l')
  await until(`Boolean(document.querySelector('.navigator .palette__input'))`, 'navigator')
  await run(`(() => {
    const input = document.querySelector('.palette__input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'hello')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await until(`document.querySelector('.palette__list li.is-active')?.textContent.includes('hello from smoke')`, 'navigator finds the thread')
  await key('Enter', [])
  await until(`!document.querySelector('.palette__input') && document.querySelector('.thread__title')?.textContent === 'hello from smoke'`, 'navigator opened it')
  // Every key and palette pick went through the router; the action log shows them, with where they came from.
  await key('k')
  await until(`Boolean(document.querySelector('.palette__input'))`, 'palette for the log')
  await run(`(() => {
    const input = document.querySelector('.palette__input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'action log')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await key('Enter', [])
  await until(`[...document.querySelectorAll('.action-log__table tr')].some((tr) => tr.textContent.includes('threads.rail') && tr.textContent.includes('keys'))`, 'action log')
  await until(`[...document.querySelectorAll('.action-log__table tr')].some((tr) => tr.textContent.includes('thread.select') && tr.textContent.includes('navigator'))`, 'navigator dispatch logged')
  await key('Escape', [])
  await until(`!document.querySelector('.action-log')`, 'log closed')
  // ⌘N: the New thread dialog refuses a folder that isn't there, then starts with the prompt on ⌘⏎.
  await key('n')
  await until(`Boolean(document.querySelector('.new-thread [aria-label="Prompt"]'))`, 'new thread dialog')
  await new Promise((resolve) => setTimeout(resolve, 400))
  await shot('new-thread')
  const setValue = (selector, value) => run(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await setValue('.new-thread [aria-label="Project folder"]', '/nowhere/at/all')
  await setValue('.new-thread [aria-label="Prompt"]', 'hello from the dialog')
  await run(`[...document.querySelectorAll('.new-thread button')].find((b) => b.textContent.startsWith('Start')).click()`)
  await until(`document.querySelector('.new-thread__error')?.textContent.includes('No folder')`, 'missing folder refused')
  await setValue('.new-thread [aria-label="Project folder"]', process.env.MU_HOME)
  await key('Enter', ['meta'])
  await until(`!document.querySelector('.new-thread') && document.querySelector('.transcript')?.textContent.includes('echo: hello from the dialog')`, 'started with the prompt')
  // Panes: in a git repo, the changes, the editor and an artifact the agent could have written, beside the thread.
  const { execFileSync: git } = await import('node:child_process')
  const repo = `${process.env.MU_HOME}/repo`
  git('mkdir', ['-p', repo]); git('git', ['init', '-q', repo])
  writeFileSync(`${repo}/notes.md`, 'one\n')
  git('git', ['-C', repo, 'add', '.']); git('git', ['-C', repo, '-c', 'user.email=s@s', '-c', 'user.name=s', 'commit', '-q', '-m', 'start'])
  const paned = await run(`window.mu.call('local', 'thread.create', { cwd: ${JSON.stringify(repo)}, title: 'panes' }).then((s) => s.id)`)
  await run(`window.mu.call('local', 'file.write', { id: '${paned}', path: 'notes.md', content: 'two\\n' })`)
  await run(`window.mu.call('local', 'file.write', { id: '${paned}', path: 'page.html', content: '<body><script>document.body.dataset.ok = \\'yes\\'</script>An artifact</body>' })`)
  await run(`[...document.querySelectorAll('.mu-list-item')].find((li) => li.textContent.includes('panes')).click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'panes'`, 'pane thread open')
  await key('d', ['meta', 'shift'])
  await until(`[...document.querySelectorAll('.diff-row--add')].some((r) => r.textContent === '+two')`, 'changes pane shows the edit')
  await run(`window.mu.call('local', 'pane.open', { id: '${paned}', kind: 'editor', params: { path: 'notes.md' } })`)
  await until(`document.querySelector('.cm-content')?.textContent.includes('two')`, 'editor pane shows the file')
  await run(`window.mu.call('local', 'pane.open', { id: '${paned}', kind: 'artifact', params: { path: 'page.html' } })`)
  const artifactRan = async () => {
    for (let i = 0; i < 100; i++) {
      const frame = BrowserWindow.getAllWindows()[0].webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith('mu-artifact:'))
      if (frame && await frame.executeJavaScript('document.body?.dataset.ok').catch(() => undefined) === 'yes') return
      await new Promise((r) => setTimeout(r, 100))
    }
    await fail('the artifact did not run'); throw new Error('failed')
  }
  await artifactRan()
  if (await run(`document.querySelectorAll('.panes__tab').length`) !== 3) { await fail('three pane tabs'); throw new Error('failed') }
  await shot('panes')
  // Keys typed into a frame stay in it: back to the window first, as a click there would.
  await run(`document.querySelector('.composer textarea').focus()`)
  for (let left = 2; left >= 0; left--) {
    await key('w', ['meta', 'shift'])
    await until("document.querySelectorAll('.panes__tab').length === " + left, 'a pane closed, ' + left + ' left')
  }
  await until(`!document.querySelector('.panes')`, 'panes closed')
  // The header's pane menu opens one too.
  await run(`document.querySelector('.thread__panes').click()`)
  await until(`[...document.querySelectorAll('.mu-menu__item')].some((i) => i.textContent === 'Changes')`, 'pane menu offers Changes')
  await run(`[...document.querySelectorAll('.mu-menu__item')].find((i) => i.textContent === 'Changes').click()`)
  await until(`document.querySelector('.panes__tab')?.textContent.startsWith('Changes')`, 'pane menu opened Changes')
  await key('w', ['meta', 'shift'])
  await until(`!document.querySelector('.panes')`, 'menu pane closed')
  // ⌘P: a file by a few letters of its name, opened beside the thread; its tree shows it, and a click there shows
  // another file in the same editor.
  await key('p')
  await until(`Boolean(document.querySelector('.files-open .palette__input'))`, 'quick open')
  await run(`(() => {
    const input = document.querySelector('.files-open .palette__input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'note')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await until(`document.querySelector('.files-open li.is-active')?.textContent.startsWith('notes.md')`, 'quick open finds notes.md')
  await key('Enter', [])
  await until(`document.querySelector('.panes__tab.is-active')?.textContent.startsWith('notes.md') && !document.querySelector('.files-tree')`, 'notes.md open, its tree closed')
  await key('e', ['meta', 'shift'])
  await until(`Boolean(document.querySelector('.files-tree__row.is-current'))`, 'tree shown, at notes.md')
  await run(`[...document.querySelectorAll('.files-tree__row')].find((b) => b.textContent === 'page.html').click()`)
  await until(`document.querySelectorAll('.panes__tab').length === 1 && document.querySelector('.panes__tab')?.textContent.startsWith('page.html')`, 'the tree showed page.html in the same editor')
  await shot('files')
  await key('w', ['meta', 'shift'])
  await until(`!document.querySelector('.panes')`, 'editor closed')
  // The window as it was left, after a reload: the same thread selected, its unsent draft still there.
  await run(`document.querySelector('.composer textarea').focus()`)
  BrowserWindow.getAllWindows()[0].webContents.insertText('half a thought')
  await until(`document.querySelector('.composer textarea').value === 'half a thought'`, 'draft typed')
  BrowserWindow.getAllWindows()[0].webContents.reload()
  await until(`document.querySelector('.thread__title')?.textContent === 'panes' && document.querySelector('.composer textarea')?.value === 'half a thought'`, 'selection and draft kept across a reload')
  await run(`document.querySelector('.composer textarea').select()`)
  await key('Backspace', [])
  await until(`document.querySelector('.composer textarea').value === ''`, 'draft cleared')
  // ⌘/ hides the sidebar and shows it again; its button stays where it was.
  const toggleAt = () => run(`JSON.stringify(document.querySelector('.app__sidebar-toggle').getBoundingClientRect())`)
  const before = await toggleAt()
  await key('/')
  await until(`!document.querySelector('.app__sidebar')`, 'sidebar hidden')
  if (await toggleAt() !== before) { await fail('the sidebar button moved'); throw new Error('failed') }
  await key('/')
  await until(`Boolean(document.querySelector('.app__sidebar'))`, 'sidebar shown')
  // ⌃Tab: the thread, then each pane beside it, and around.
  await run(`window.mu.call('local', 'pane.open', { id: '${paned}', kind: 'diff' })`)
  await until(`Boolean(document.querySelector('.panes__tab'))`, 'pane in front')
  await key('Tab', ['control'])
  await until(`window.mu.call('local', 'thread.list', {}).then((l) => !l.find((t) => t.id === '${paned}').pane)`, 'ctrl+tab to the thread')
  await new Promise((r) => setTimeout(r, 300))
  await key('Tab', ['control'])
  await until(`window.mu.call('local', 'thread.list', {}).then((l) => Boolean(l.find((t) => t.id === '${paned}').pane))`, 'ctrl+tab to the pane')
  await key('w', ['meta', 'shift'])
  await until(`!document.querySelector('.panes')`, 'diff closed')
  // Sessions: the panes repository is one, the home folder another; ⌘⇧[ and ⌘⇧] go between them.
  const { mkdirSync } = await import('node:fs')
  const elsewhere = `${process.env.MU_HOME}/elsewhere`
  mkdirSync(elsewhere, { recursive: true })
  const other = await run(`window.mu.call('local', 'thread.create', { cwd: ${JSON.stringify(elsewhere)}, title: 'elsewhere', prompt: 'hi' }).then((t) => t.id)`)
  await until(`[...document.querySelectorAll('.threads-session__name')].some((n) => n.textContent.startsWith('elsewhere'))`, 'a session per project')
  // ⌘. : the next thread with something unread, here the new one once it has answered.
  await until(`[...document.querySelectorAll('.mu-list-item')].some((li) => li.textContent.includes('elsewhere') && li.querySelector('.mu-status--done'))`, 'other thread done, in the window')
  // Each press goes to the next unread one; looking at it marks it seen, so the presses reach the new one.
  for (let press = 0; press < 6 && await run(`document.querySelector('.thread__title')?.textContent`) !== 'elsewhere'; press++) {
    const was = await run(`document.querySelector('.thread__title')?.textContent`)
    await key('.')
    await until(`document.querySelector('.thread__title')?.textContent !== ${JSON.stringify(was)}`, 'cmd+. moved on')
    await new Promise((r) => setTimeout(r, 300))
  }
  await until(`document.querySelector('.thread__title')?.textContent === 'elsewhere'`, 'cmd+. reached the unread thread')
  await key(']', ['meta', 'shift'])
  await until(`document.querySelector('.thread__title')?.textContent !== 'elsewhere'`, 'cmd+shift+] to the next session')
  await key('[', ['meta', 'shift'])
  await until(`document.querySelector('.thread__title')?.textContent === 'elsewhere'`, 'cmd+shift+[ back')
  // Focus: ⌘⌥← from the prompt goes to the sidebar, on the selected thread; ↓ moves along it; ⌘⌥→ comes back to the
  // thread's prompt; ⌃I goes to the prompt from anywhere. Wherever it is, it's drawn.
  // A hidden window's page never has focus, so :focus styles never apply; emulate it (nothing reaches the screen).
  const dbg = BrowserWindow.getAllWindows()[0].webContents.debugger
  if (!dbg.isAttached()) dbg.attach()
  await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await run(`document.querySelector('.composer textarea').focus()`)
  await key('Left', ['meta', 'alt'])
  await until(`document.activeElement?.matches('.app__sidebar .mu-list-item.is-selected')`, 'focus to the sidebar, on the selected thread')
  const ring = await run(`getComputedStyle(document.activeElement).outlineStyle`)
  await key('Down', [])
  await until(`document.activeElement?.matches('.app__sidebar .mu-list-item:not(.is-selected)')`, 'down the sidebar')
  await shot('focus')
  await key('Right', ['meta', 'alt'])
  await until(`document.activeElement?.matches('.composer textarea')`, 'focus back to the prompt')
  await key('Left', ['meta', 'alt'])
  await key('i', ['control'])
  await until(`document.activeElement?.matches('.composer textarea')`, 'ctrl+i to the prompt')
  if (ring !== 'solid') { await fail(`focus not drawn: ${ring}`); throw new Error('failed') }
  await shot('sessions')
  // Settings: the app's own sections, then the machine's, drawn from what each registers.
  await run(`[...document.querySelectorAll('.app__footer button')].find((b) => b.textContent === 'Settings').click()`)
  await until(`document.querySelector('.settings')?.textContent.includes('Appearance') && document.querySelector('.settings').textContent.includes('Notifications')`, 'app settings')
  await shot('settings')
  // Fonts: the picker lists installed families (needs a user gesture), and a choice sets the CSS variable.
  await run(`document.querySelector('[data-key="app.font.interface"] .mu-font-picker__button').click()`, true)
  await until(`document.querySelectorAll('.mu-font-picker__list button').length > 5`, 'installed fonts listed', 40_000)
  await run(`[...document.querySelectorAll('.mu-font-picker__list button')].find((b) => b.textContent === 'Helvetica' || b.textContent === 'Arial').click()`)
  await until(`/Helvetica|Arial/.test(document.documentElement.style.getPropertyValue('--mu-font'))`, 'interface font applied')
  await run(`window.mu.call('app', 'app.settings.set', { key: 'app.font.mono', value: 'Menlo' })`)
  await until(`document.documentElement.style.getPropertyValue('--mu-mono').includes('Menlo')`, 'mono font applied')
  // Keyboard: record a new shortcut for an action; the old one stops working, the new one runs it; a clash shows.
  const keysOf = (id) => `document.querySelector('[data-action="${id}"] .keymap__keys')`
  await until(`${keysOf('threads.rail')}?.textContent === '${process.platform === 'darwin' ? '⌘\\\\' : 'Ctrl+\\\\'}'`, 'keyboard settings list the rail shortcut')
  await run(`(() => { const b = ${keysOf('threads.rail')}; b.focus(); b.click() })()`)
  await until(`${keysOf('threads.rail')}?.classList.contains('is-recording')`, 'recording')
  await key('k', [])
  await until(`${keysOf('threads.rail')}?.textContent.includes('typing stays typing')`, 'a bare key is refused')
  await key('R', ['meta', 'shift'])
  await until(`/⇧R|Shift\\+R/.test(${keysOf('threads.rail')}?.textContent ?? '') && Boolean(document.querySelector('[data-action="threads.rail"] button.keymap__reset'))`, 'new shortcut recorded')
  await key('\\')
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (await run(`Boolean(document.querySelector('.threads-rail.is-compact'))`)) { await fail('the old shortcut still runs the action'); throw new Error('failed') }
  await key('R', ['meta', 'shift'])
  await until(`Boolean(document.querySelector('.threads-rail.is-compact'))`, 'the new shortcut runs the action')
  await key('R', ['meta', 'shift'])
  await until(`!document.querySelector('.threads-rail.is-compact')`, 'and back')
  await run(`window.mu.call('app', 'app.settings.set', { key: 'app.keys', value: { 'threads.rail': 'mod+shift+r', 'threads.details': 'mod+shift+r' } })`)
  await until(`document.querySelector('[data-action="threads.rail"] .keymap__clash')?.textContent.includes('Toggle thread details')`, 'clash shown')
  await run(`document.querySelector('.keymap').scrollIntoView()`)
  await shot('keyboard')
  await run(`[...document.querySelectorAll('.keymap__head button')].find((b) => b.textContent === 'Reset all').click()`)
  await until(`!document.querySelector('.keymap__clash') && ${keysOf('threads.rail')}?.textContent.includes('\\\\')`, 'reset to the actions’ own')
  // Machines: add one over ssh that can't connect; it shows its error, then goes away again.
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent === 'Machines').click()`)
  await run(`window.mu.call('app', 'machines.add', { label: 'Nowhere', target: 'mu-smoke.invalid' })`)
  await until(`[...document.querySelectorAll('.machine-row')].some((row) => row.textContent.includes('mu-smoke.invalid') && /disconnected/.test(row.textContent))`, 'ssh machine listed with its error')
  await run(`(async () => { const list = await window.mu.machines(); await window.mu.call('app', 'machines.remove', { id: list.find((m) => m.label === 'Nowhere').id }) })()`)
  await until(`![...document.querySelectorAll('.machine-row')].some((row) => row.textContent.includes('mu-smoke.invalid'))`, 'machine removed')
  // A second machine: another daemon, reached through a command that pipes stdio to it (as docker exec would).
  const second = `MU_HOME='${process.env.MU_HOME}/second' MU_MODEL=faux node '${new URL('../bin/mu.ts', import.meta.url).pathname}' connect --start`
  await run(`window.mu.call('app', 'machines.add', { label: 'Second', via: ${JSON.stringify(second)} })`)
  await until(`[...document.querySelectorAll('.machine-row')].some((row) => row.querySelector('input')?.value === 'Second' && / · connected/.test(row.textContent))`, 'second machine connected', 30_000)
  await shot('machines')
  // All machines: a disagreement shows as Mixed, and one change reaches both.
  await run(`window.mu.call('local', 'settings.set', { key: 'agent.model', value: 'faux/faux-1' })`)
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent === 'All machines').click()`)
  await until(`document.querySelector('[data-key="agent.model"]')?.textContent.includes('Mixed')`, 'mixed model across machines')
  await run(`(() => {
    const select = document.querySelector('[data-key="agent.model"] select')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'faux/faux-1')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await until(`!document.querySelector('[data-key="agent.model"]')?.textContent.includes('Mixed')`, 'model set on all machines')
  const secondId = await run(`window.mu.machines().then((list) => list.find((m) => m.label === 'Second').id)`)
  const secondModel = await run(`window.mu.call('${secondId}', 'settings.watch', {}).then((r) => r.value.values['agent.model'])`)
  if (secondModel !== 'faux/faux-1') { await fail(`second machine model is ${secondModel}`); throw new Error('failed') }
  await until(`window.mu.machines().then((list) => list.filter((m) => m.state === 'connected').length === 2)`, 'both machines connected')
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent.includes('This computer')).click()`)
  await until(`document.querySelector('.settings')?.textContent.includes('Providers') && Boolean(document.querySelector('[data-key="agent.model"]'))`, 'machine settings')
  await shot('providers')
  const hasFaux = await run(`[...document.querySelectorAll('[data-key="agent.model"] option')].some((o) => o.value === 'faux/faux-1')`)
  if (!hasFaux) { await fail('model choices'); throw new Error('failed') }
  // The menu bar: on by default; "Hide Dock icon" needs it; turning it off takes the item away.
  const desktop = () => run(`window.mu.call('app', 'app.desktop', {})`)
  if (!(await desktop()).menuBar) { await fail('menu bar item not up by default'); throw new Error('failed') }
  await run(`window.mu.call('app', 'app.settings.set', { key: 'app.hideDock', value: true })`)
  if (process.platform === 'darwin' && !(await desktop()).dockHidden) { await fail('dock not hidden'); throw new Error('failed') }
  await run(`window.mu.call('app', 'app.settings.set', { key: 'app.menuBar', value: false })`)
  await until(`window.mu.call('app', 'app.desktop', {}).then((d) => !d.menuBar && !d.dockHidden)`, 'menu bar off, dock back')
  const refused = await run(`window.mu.call('app', 'app.settings.set', { key: 'app.hideDock', value: true }).then(() => 'set', (e) => e.message)`)
  if (process.platform === 'darwin' && !/menu bar/.test(refused)) { await fail(`hide dock without menu bar: ${refused}`); throw new Error('failed') }
  await run(`window.mu.call('app', 'app.settings.set', { key: 'app.menuBar', value: true })`)
  // Restart: new daemon code on disk (faked with an extra file in the build) shows "Restart required"; restarting
  // brings up a daemon of that build, with the threads still there.
  await restartOntoNewCode(() => writeFileSync(STRAY, '// smoke\n'))
  // The dialog: Escape in the font picker closes only the picker; the next Escape closes Settings.
  const escape = async () => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  }
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent === 'General').click()`)
  await until(`Boolean(document.querySelector('[data-key="app.font.mono"]'))`, 'general pane')
  await run(`document.querySelector('[data-key="app.font.mono"] .mu-font-picker__button').click()`, true)
  await until(`document.activeElement?.placeholder === 'Search fonts'`, 'picker focused')
  await escape()
  await until(`!document.querySelector('.mu-font-picker__popover') && Boolean(document.querySelector('.mu-dialog.settings'))`, 'picker closed, dialog open')
  await escape()
  await until(`!document.querySelector('.mu-dialog.settings')`, 'dialog closed by Escape')
  // Web access: the daemon serves the same window to a browser. A window without the preload is just a web page.
  const port = 20000 + Math.floor(Math.random() * 20000)
  await run(`window.mu.call('local', 'settings.set', { key: 'web.port', value: ${port} })`)
  await run(`window.mu.call('local', 'settings.set', { key: 'web.access', value: 'local' })`)
  const url = await until(`window.mu.call('local', 'settings.watch', {}).then((r) => r.value.sections.find((s) => s.id === 'web')?.data?.url)`, 'web address')
  const browser = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  await browser.loadURL(url)
  const inBrowser = async (js, label) => {
    for (let i = 0; i < 150; i++) { if (await browser.webContents.executeJavaScript(js).catch(() => false)) return; await new Promise((r) => setTimeout(r, 100)) }
    await fail(`web: waiting for ${label}`); throw new Error('failed')
  }
  await inBrowser(`window.mu.web === true && location.hash === ''`, 'web bridge, token out of the address bar')
  await inBrowser(`[...document.querySelectorAll('.mu-list-item')].some((li) => li.textContent.includes('hello from smoke'))`, 'threads in the browser')
  await browser.webContents.executeJavaScript(`[...document.querySelectorAll('.mu-list-item')].find((li) => li.textContent.includes('hello from smoke')).click()`)
  await inBrowser(`document.querySelector('.transcript')?.textContent.includes('echo: hello from smoke')`, 'a transcript in the browser')
  // A phone: one column, the threads in a drawer from the bar at the top.
  browser.setContentSize(390, 844)
  await inBrowser(`Boolean(document.querySelector('.app__mobilebar')) && !document.querySelector('.app__sidebar')`, 'phone layout')
  if (process.env.MU_SMOKE_SHOTS) writeFileSync(`${process.env.MU_SMOKE_SHOTS}/phone-thread.png`, (await browser.webContents.capturePage()).toPNG())
  await browser.webContents.executeJavaScript(`document.querySelector('.app__mobilebar button').click()`)
  await inBrowser(`Boolean(document.querySelector('.app.has-drawer .app__sidebar'))`, 'drawer open')
  await new Promise((r) => setTimeout(r, 300))
  if (process.env.MU_SMOKE_SHOTS) writeFileSync(`${process.env.MU_SMOKE_SHOTS}/phone-drawer.png`, (await browser.webContents.capturePage()).toPNG())
  await browser.webContents.executeJavaScript(`[...document.querySelectorAll('.mu-list-item')].find((li) => li.textContent.includes('hello from smoke')).click()`)
  await inBrowser(`!document.querySelector('.app__sidebar')`, 'drawer closes on picking a thread')
  const wrongToken = await browser.webContents.executeJavaScript(`new Promise((resolve) => { const ws = new WebSocket('ws://' + location.host + '/rpc?token=wrong'); ws.onopen = () => resolve('open'); ws.onerror = () => resolve('refused') })`)
  if (wrongToken !== 'refused') { await fail(`a wrong token got in: ${wrongToken}`); throw new Error('failed') }
  browser.destroy()
  await run(`window.mu.call('local', 'settings.set', { key: 'web.access', value: 'off' })`)
  console.log('smoke(first): ok')
} else {
  await until(`[...document.querySelectorAll('.mu-list-item')].some((li) => li.textContent.includes('hello from smoke'))`, 'thread after reopen')
  await until(`window.mu.machines().then((list) => list.filter((m) => m.state === 'connected').length === 2)`, 'second machine reconnected after reopen', 30_000)
  await run(`[...document.querySelectorAll('.mu-list-item')].find((li) => li.textContent.includes('hello from smoke')).click()`)
  await until(`document.querySelector('.transcript')?.textContent.includes('echo: typed message')`, 'transcript after reopen')
  // `mu <dir> -p ...` from a terminal: a new thread there, shown in this (already running) app.
  const { execFileSync } = await import('node:child_process')
  const cli = new URL('../bin/mu.ts', import.meta.url).pathname
  execFileSync('node', [cli, process.env.MU_HOME, '-p', 'from the cli'], { env: { ...process.env, MU_APP: new URL('..', import.meta.url).pathname } })
  await until(`document.querySelector('.thread__title')?.textContent === 'from the cli' && document.querySelector('.transcript')?.textContent.includes('echo: from the cli')`, 'thread opened from the command line', 30_000)
  // The extra file is gone again: the daemon is out of date once more, and restarts back.
  await restartOntoNewCode(() => rmSync(STRAY, { force: true }))
  // App settings persisted in the app's own file.
  await until(`document.documentElement.style.getPropertyValue('--mu-mono').includes('Menlo')`, 'font after reopen')
  console.log('smoke(reopen): ok')
}
app.exit(0)
})().catch((error) => { if (error.message !== 'failed') void fail(error.stack ?? String(error)) })
