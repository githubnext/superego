// Screenshots of the title bar (run by `test/look.sh <dir> titlebar`): a thread with a profile of the user's, its title bar
// in light and dark, then the profile's card and the model's, each opened by pointing at its badge or mark, and the
// sidebar's heading pointed at. Into $SUPEREGO_SHOWCASE_OUT.
import { openApp } from './harness.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { threads } from './showcase/threads.mjs'

// A profile of the user's, bringing an extension of its own and one of the machine's MCP servers.
const profile = join(process.env.SUPEREGO_HOME, 'profiles', 'reviewer')
mkdirSync(profile, { recursive: true })
writeFileSync(join(profile, 'profile.ts'), `export default {
  description: 'Reviews a change for bugs and missing tests',
  extensions: ['./notes.ts'],
  mcp: ['github'],
}\n`)
writeFileSync(join(profile, 'notes.ts'), `export default { name: 'notes' }\n`)

await openApp({ name: 'titlebar', timeout: 180_000 }, async (t) => {
  const { win, run, until } = t
  await t.resize(1100, 600)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const { id } = await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)}, profile: 'reviewer', title: 'Review the ledger import' })`)
  await run(`window.superego.call('local', 'thread.send', { thread: '${id}', text: ${JSON.stringify(threads[0].prompt)} })`)
  await until(`window.superego.call('local', 'thread.list', {}).then((list) => ['done', 'error'].includes(list.find((s) => s.id === '${id}')?.status.state))`, 'answer')
  await run(`window.superego.call('local', 'thread.seen', { thread: '${id}' })`)
  await until(`([...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('Review the ledger'))?.click(), !!document.querySelector('.thread__profile'))`, 'thread shown')
  await t.settled()
  const bar = await run(`(() => { const r = document.querySelector('.app__titlebar').getBoundingClientRect(); return { x: 0, y: 0, width: Math.ceil(r.right), height: Math.ceil(r.bottom) } })()`)
  const shot = async (name, rect) => {
    await t.settled()
    writeFileSync(`${process.env.SUPEREGO_SHOWCASE_OUT}/${name}.png`, (await win().webContents.capturePage(rect)).toPNG())
  }
  await t.lights()
  await t.titleRowAligned('the title bar')
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await shot(`titlebar-${theme}`, bar)
    await shot(`window-${theme}`)
  }
  // A title too long for the bar, truncated, still on the line.
  await run(`window.superego.call('local', 'thread.rename', { thread: '${id}', title: 'Review the ledger import, its retries, the bank sync and every category rule it reads before the monthly report goes out' })`)
  await until(`document.querySelector('.titlebar__title .thread__title')?.textContent.startsWith('Review the ledger import, its')`, 'the long title')
  await until(`(() => { const t = document.querySelector('.titlebar__title .thread__title'); return t.scrollWidth > t.clientWidth })()`, 'the long title truncated')
  await t.titleRowAligned('a long title')
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await shot(`titlebar-long-${theme}`, bar)
  }
  await run(`window.superego.call('local', 'thread.rename', { thread: '${id}', title: 'Review the ledger import' })`)
  await until(`document.querySelector('.titlebar__title .thread__title')?.textContent === 'Review the ledger import'`, 'the title back')
  // Pointed at, the profile's badge and the model's mark say what they are.
  const center = (selector) => run(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  for (const [name, trigger, card, ready] of [
    ['profile-card', '.thread__profile', '.profile-card', '.profile-card .profile-card__about'],
    ['model-card', '.threads-model', '.threads-model-card', '.threads-model-card dl'],
  ]) {
    const at = await center(trigger)
    for (const theme of ['light', 'dark']) {
      await t.theme(theme)
      win().webContents.sendInputEvent({ type: 'mouseMove', x: at.x - 40, y: at.y + 200 })
      await until(`!document.querySelector('${card}')`, `the ${name} gone`)
      win().webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
      await until(`Boolean(document.querySelector('${ready}'))`, `the ${name}`)
      await until(`!document.querySelector('[data-starting-style]')`, `the ${name} open`)
      const rect = await run(`(() => { const c = document.querySelector('${card}'); if (!c) return undefined; const r = c.getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.left) - 24), y: 0, width: Math.ceil(r.width) + 48, height: Math.ceil(r.bottom) + 24 } })()`)
      console.log(`${name}:`, rect ? JSON.stringify(rect) : 'none', await run(`document.querySelector('${card}')?.textContent`))
      await shot(`${name}-${theme}`, rect ?? bar)
      await shot(`window-${name}-${theme}`)
    }
  }
  // Clicked, the model's mark shows the thread's details, and again hides them.
  await t.mouse('.threads-model')
  await until(`Boolean(document.querySelector('.threads-details')) && document.querySelector('.threads-model').classList.contains('is-on')`, 'the details, from the model')
  await shot('titlebar-details-on', bar)
  await t.mouse('.threads-model')
  await until(`!document.querySelector('.threads-details')`, 'the details hidden again')
  // Pointed at, the sidebar's heading shows the key that goes anywhere.
  const head = await run(`(() => { const r = document.querySelector('.threads__head').getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2), rect: { x: Math.floor(r.left) - 8, y: Math.floor(r.top) - 8, width: Math.ceil(r.width) + 16, height: Math.ceil(r.height) + 16 } } })()`)
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    win().webContents.sendInputEvent({ type: 'mouseMove', x: head.x, y: head.y + 300 })
    await until(`!document.querySelector('.threads__head:hover')`, 'the pointer off the heading')
    win().webContents.sendInputEvent({ type: 'mouseMove', x: head.x, y: head.y })
    await until(`Boolean(document.querySelector('.threads__head:hover'))`, 'the pointer on the heading')
    await shot(`threads-head-${theme}`, head.rect)
  }
})
