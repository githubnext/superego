// A fresh app process on the daemon that outlived the first: the threads, the one window left open and its state, the
// second machine reconnected; a provider that rejects its key there; `superego <dir>` from a terminal; a restart back
// onto the build as it is; and a window reloaded onto another build than the app's.
import { app, BrowserWindow, net } from 'electron'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { home, openNotice, openRow, restartOntoNewCode, row, STRAY } from './common.mjs'

export default async function reopen(t) {
  await t.until(`Boolean(${row('hello from smoke')})`, 'thread after reopen')
  // Seen in the first run (Get started): the onboarding page, for good, no more.
  if (!await t.run(`window.superego.call('local', 'settings.watch', {}).then((r) => r.value.values['onboarding.seen'] === true)`) || await t.run(`Boolean(document.querySelector('.onboarding'))`)) t.fail('onboarding not put away for good')
  // The one window left open reopened, and the state of the one closed is gone.
  if (BrowserWindow.getAllWindows().length !== 1) t.fail('not the one window left open, reopened')
  await t.until(`(() => { const id = new URLSearchParams(location.search).get('window'); return Object.keys(localStorage).filter((k) => k.startsWith('superego.window.')).every((k) => k.startsWith('superego.window.' + id + '.')) })()`, "the closed window's state dropped")
  // Right after start, the listed thread of the marked profile is marked, though none of its threads was shown.
  await t.until(`${row('marked thread')}?.querySelector('.smoke-mark')?.textContent === 'marked: marked thread'`, "a listed thread's profile UI after reopen, without opening it")
  await t.check(`document.querySelector('.thread__profile')?.textContent !== 'marked'`, 'a thread of the marked profile was shown')
  await t.until(`window.superego.machines().then((list) => list.filter((m) => m.state === 'connected').length === 2)`, 'second machine reconnected after reopen', 30_000)
  await openRow(t, 'hello from smoke')
  await t.until(`document.querySelector('.transcript')?.textContent.includes('echo: typed message')`, 'transcript after reopen')

  // The second machine's provider rejects its key (the scripted model does, for a key starting "reject"): the threads it
  // stops wait quietly, one notice names the machine and counts them, one notification says it (not one per thread),
  // Sign in again opens that machine's Providers, and a new key takes them on by themselves.
  const second = await t.run(`window.superego.machines().then((list) => list.find((m) => m.label === 'Second').id)`)
  const secondAuth = `${home}/second/auth.json`
  writeFileSync(secondAuth, JSON.stringify({ faux: { type: 'api_key', key: 'reject-me' } }))
  globalThis.superegoNotifications = []
  await t.run(`window.dispatchEvent(new Event('blur'))`)
  for (const prompt of ['keyed one', 'keyed two']) await t.call('thread.start', { title: prompt, prompt }, second)
  await t.until(`document.querySelectorAll('.app__rail .rail-notice--auth').length === 1 && document.querySelector('.rail-notice--auth').getAttribute('aria-label') === 'faux rejected the API key on Second'`, 'one notice for the rejected key, naming the machine')
  await t.until(`[...document.querySelectorAll('.superego-list-item')].filter((li) => /keyed (one|two)/.test(li.textContent) && li.querySelector('.superego-status-word--signin')).length === 2`, 'the threads waiting quietly')
  // Both rejections are in (the window shows both waiting): a notification for the second would be in by now.
  await t.until(() => globalThis.superegoNotifications.some((n) => n.machine === second), 'a notification for the rejected key')
  await t.settled()
  const keyNotices = globalThis.superegoNotifications.filter((n) => n.machine === second)
  if (keyNotices.length !== 1 || keyNotices[0].title !== 'faux rejected the API key') t.fail(`not one notification for the rejected key: ${JSON.stringify(globalThis.superegoNotifications)}`)
  await t.run(`window.dispatchEvent(new Event('focus'))`)
  // Shown, a waiting thread says why in place of its failure, and offers to sign in again.
  await openRow(t, 'keyed one')
  await t.until(`document.querySelector('.transcript__waiting')?.textContent.startsWith('faux rejected the API key. It goes on once you sign in again.') && !document.querySelector('.transcript__error')`, 'the thread waiting, not failed')
  await openNotice(t, 'auth', 'the rejected key')
  await t.until(`document.querySelector('.rail-notice__popup .auth-notice')?.textContent.startsWith('faux rejected the API key on Second.2 threads are waiting.')`, 'the rejected key, in full')
  await t.click('.rail-notice__popup .auth-notice button', 'Sign in again')
  await t.until(`document.querySelector('.settings__nav-machine.is-selected')?.textContent.includes('Second') && document.querySelector('.settings')?.textContent.includes('Providers')`, "sign in again: that machine's Providers")
  await t.click('.app__rail [aria-label="Threads"]')
  await t.until(`!document.querySelector('.settings')`, 'Settings left for Threads')
  writeFileSync(secondAuth, JSON.stringify({}))
  // The one shown is seen as it answers; the other is done.
  await t.until(`!document.querySelector('.rail-notice--auth') && !document.querySelector('.transcript__waiting') && document.querySelector('.transcript')?.textContent.includes('echo: keyed one')
    && Boolean(${row('keyed two')}?.querySelector('.superego-status--done'))`, 'a new key: the threads went on and answered', 20_000)

  // `superego <dir> -p ...` from a terminal: a new thread there, shown in this (already running) app.
  const cli = new URL('../../bin/superego.ts', import.meta.url).pathname
  execFileSync('node', [cli, home, '-p', 'from the cli'], { env: { ...process.env, SUPEREGO_APP: new URL('../..', import.meta.url).pathname } })
  await t.until(`document.querySelector('.thread__title')?.textContent === 'from the cli' && document.querySelector('.transcript')?.textContent.includes('echo: from the cli')`, 'thread opened from the command line', 30_000)
  // The extra file is gone again: the daemon is out of date once more, and restarts back.
  await restartOntoNewCode(t, () => rmSync(STRAY, { force: true }), { atRest: true })
  // App settings persisted in the app's own file.
  await t.until(`document.documentElement.style.getPropertyValue('--superego-mono').includes('Menlo')`, 'font after reopen')
  await windowOfAnotherBuild(t)
}

/**
 * The window reloaded onto another build than the main process's (its code served with another build in it, as if out/
 * had been rebuilt under the app): "App updated", whose Restart relaunches the app and quits (both held here). Served as
 * built again, a reload finds them alike.
 */
async function windowOfAnotherBuild(t) {
  await t.check(`!document.querySelector('.rail-notice--build')`, 'app updated, though built together')
  const { build } = JSON.parse(readFileSync(new URL('../../out/main/build.json', import.meta.url), 'utf8'))
  const contents = t.contents()
  const renderer = new URL('../../out/renderer/', import.meta.url).href
  contents.session.protocol.handle('file', async (request) => {
    const response = await net.fetch(request, { bypassCustomProtocolHandlers: true })
    if (!request.url.startsWith(renderer) || !request.url.endsWith('.js')) return response
    return new Response((await response.text()).replaceAll(build, 'smoke0builds'), { headers: response.headers })
  })
  contents.reload()
  await openNotice(t, 'build', 'app updated')
  await t.until(`document.querySelector('.rail-notice--build')?.getAttribute('aria-label') === 'App updated' && document.querySelector('.rail-notice__popup .build-notice')?.textContent.includes('The app was updated: restart to use it.')`, 'app updated, in full')
  const held = { relaunch: app.relaunch, quit: app.quit }
  const asked = []
  app.relaunch = () => asked.push('relaunch')
  app.quit = () => asked.push('quit')
  await t.click('.rail-notice__popup .build-notice button', 'Restart')
  await t.until(() => asked.length >= 2, 'the restart to relaunch and quit', 5000).finally(() => Object.assign(app, held))
  if (asked.join() !== 'relaunch,quit') t.fail(`restart asked for ${asked.join() || 'nothing'}`)
  contents.session.protocol.unhandle('file')
  contents.reload()
  await t.until(`Boolean(document.querySelector('.threads.is-ready')) && !document.querySelector('.rail-notice--build')`, 'built together again, after a reload')
}
