// Headless end to end for the core alone: no extensions, so no sidebar; the top bar picks sessions.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { app, BrowserWindow } from 'electron'

const fail = async (message) => {
  console.error(`smoke(minimal): FAIL ${message}`)
  const window = BrowserWindow.getAllWindows()[0]
  if (window) console.error('DOM:', (await window.webContents.executeJavaScript('document.body.innerText').catch(String)).slice(0, 1500))
  try { console.error('daemon.log:', readFileSync(`${process.env.MU_MINIMAL_HOME}/daemon.log`, 'utf8').slice(-1500)) } catch {}
  app.exit(1)
}
process.on('uncaughtException', (error) => void fail(`uncaught in main: ${error.stack ?? error}`))
setTimeout(() => fail('timed out'), 60_000)

await import('../out/main/main.js')
void (async () => {
  await app.whenReady()
  const run = (js) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(js)
  const until = async (js, label) => {
    for (let i = 0; i < 200; i++) {
      const window = BrowserWindow.getAllWindows()[0]
      if (window && !window.webContents.isLoading() && await window.webContents.executeJavaScript(js).catch(() => false)) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await fail(`waiting for ${label}`)
    throw new Error('failed')
  }

  await until(`Boolean(document.querySelector('.session-picker'))`, 'session picker (no sidebar)')
  await until(`window.mu.machines().then((list) => list.find((m) => m.id === 'local')?.state === 'connected')`, 'connected')
  if (await run(`Boolean(document.querySelector('.app__sidebar'))`)) { await fail('a sidebar without extensions'); return }
  const hello = await run(`window.mu.machines().then(() => window.mu.call('local', 'hello', { client: 'smoke', version: 2 }))`)
  if (hello.features.some((f) => f.startsWith('ext:'))) { await fail(`extension features: ${hello.features}`); return }
  if (!hello.machine.dataDir.endsWith(process.env.MU_MINIMAL_HOME.split('/').at(-1))) { await fail(`wrong data dir ${hello.machine.dataDir}`); return }

  // New from the top bar, then chat.
  await run(`[...document.querySelectorAll('.session-picker button')].find((b) => b.textContent === 'New').click()`)
  await until(`Boolean(document.querySelector('.composer textarea'))`, 'new session shown')
  await run(`(() => {
    const ta = document.querySelector('.composer textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'hello minimal')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  await until(`document.querySelector('.transcript')?.textContent.includes('echo: hello minimal')`, 'answer')

  // `mu-minimal <dir> -p …` hands a new session to this app, which shows it.
  const bin = new URL('../bin/mu-minimal.ts', import.meta.url).pathname
  execFileSync('node', [bin, process.env.MU_MINIMAL_HOME, '-p', 'from the cli'], { env: { ...process.env, MU_MINIMAL_APP: new URL('..', import.meta.url).pathname } })
  await until(`document.querySelector('.session__title')?.textContent === 'from the cli' && document.querySelector('.transcript')?.textContent.includes('echo: from the cli')`, 'session from the command line')
  await until(`document.querySelectorAll('.session-picker option').length >= 3`, 'both sessions in the picker')

  // Settings open from the top bar.
  await run(`[...document.querySelectorAll('.app__bar button')].find((b) => b.textContent === 'Settings').click()`)
  await until(`document.querySelector('.mu-dialog.settings')?.textContent.includes('Appearance')`, 'settings')
  console.log('smoke(minimal): ok')
  app.exit(0)
})().catch((error) => { if (error.message !== 'failed') void fail(error.stack ?? String(error)) })
