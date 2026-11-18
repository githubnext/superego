// Headless end-to-end: the real app, the real daemon (scripted model), driven through the renderer, for what only the real
// processes show. What a window draws and does on its own is tested without Electron (packages/app/test/window-*.test.ts
// and the extensions' window tests, on superego/testing's `mountUi`).
//
// Phase "first" (smoke/*.mjs, in order) starts on a fresh home; phase "reopen" is a fresh app process that must find it
// all on the same daemon, which outlived the first app; phase "generation" finds a daemon of another protocol generation
// instead, and restarts it. Run by test/smoke.sh.
import { openApp } from './harness.mjs'
import { openNotice } from './smoke/common.mjs'

const phase = process.env.SUPEREGO_SMOKE_PHASE ?? 'first'
const first = ['threads', 'images', 'layout', 'panes', 'browser', 'permissions', 'session', 'settings', 'web', 'remote']
const areas = Object.fromEntries(await Promise.all((phase === 'first' ? first : phase === 'reopen' ? ['reopen'] : []).map(async (name) =>
  [name, (await import(`./smoke/${name}.mjs`)).default])))

await openApp({ name: `smoke(${phase})`, timeout: 150_000, size: [1100, 760], shots: undefined, console: 'all', connected: phase !== 'generation' }, async (t) => {
  if (phase === 'generation') {
    // smoke.sh put a daemon of another protocol generation in place: it refuses the link, which gives up on it, so the
    // app can't ask it anything. It's restarted onto this build all the same, and the threads are there again.
    await openNotice(t, 'service', 'restart required, refused by another generation')
    await t.until(`document.querySelector('.rail-notice__popup .service-notice')?.textContent.includes('Restart required')`, 'restart required, in full')
    await t.click('.rail-notice__popup .service-notice button', 'Restart when idle')
    await t.until(`!document.querySelector('.rail-notice--service') && Boolean(document.querySelector('.threads.is-ready'))`, 'restarted onto this generation', 40_000)
    if (!(await t.call('thread.list')).length) t.fail('the restart lost the threads')
    return
  }
  await t.until(`Boolean(document.querySelector('.threads.is-ready'))`, 'local machine connected')
  // What one area leaves (threads, folders, the second machine) the next takes up.
  const shared = {}
  for (const [name, area] of Object.entries(areas)) {
    const started = Date.now()
    await area(t, shared)
    console.log(`smoke(${phase}): ${name} ok (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  }
})
