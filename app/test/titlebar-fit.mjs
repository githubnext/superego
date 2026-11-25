// The title bar short of room (run by `test/look.sh <dir> titlebar-fit`): three threads, from few things in the bar to
// many (a long title, a long profile name by it, its MCP chip, an extension's chip and pill, a parent, panes stacked), each at
// 700 to 1800 wide, light and dark. At each, checks that nothing in the bar overlaps anything else, spills out of it or
// wraps, and that the title and the focused tab stay; then the ··· menu, a row of it opening the chip's popover from
// there, and a contact sheet of every screenshot. Into $SUPEREGO_SHOWCASE_OUT.
import { BrowserWindow } from 'electron'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openApp } from './harness.mjs'
import { threads } from './showcase/threads.mjs'

const OUT = process.env.SUPEREGO_SHOWCASE_OUT
const WIDTHS = [700, 900, 1100, 1400, 1800]
const home = process.env.SUPEREGO_HOME

// A profile with a long name, bringing a chip and a pill of its own to the header, and MCP servers this machine hasn't.
const fleet = join(home, 'profiles', 'chief-of-staff-for-the-ledger-fleet')
mkdirSync(fleet, { recursive: true })
writeFileSync(join(fleet, 'profile.ts'), `export default { description: 'Runs the fleet', ui: ['./ui.ts'], mcpServers: ['github', 'linear'] }\n`)
writeFileSync(join(fleet, 'ui.ts'), `import { createElement as h } from 'react'
import { defineUiExtension } from 'superego/ui'
const Pill = () => h('button', { type: 'button', className: 'fleet-pill', style: { font: 'inherit', fontSize: 12, border: 0, background: 'none', color: 'inherit', padding: '0 6px', height: 24 } }, '● Running')
const Branch = () => h('span', { className: 'header__chip fleet-branch' }, 'feature/ledger-import-rewrite')
export default defineUiExtension({
  name: 'fleet',
  setup(superego) {
    superego.view('fleet.pill', { title: 'Dev command', context: 'thread', fits: ['header'], default: 'header', component: Pill })
    superego.slot('header.chips', Branch)
  },
})
`)
const reviewer = join(home, 'profiles', 'reviewer')
mkdirSync(reviewer, { recursive: true })
writeFileSync(join(reviewer, 'profile.ts'), `export default { description: 'Reviews a change', mcpServers: ['github'] }\n`)

/** In the page: what the bar shows, each box, and what's wrong with it. */
const INSPECT = `(() => {
  const bar = document.querySelector('.app__titlebar')
  const b = bar.getBoundingClientRect()
  const pad = parseFloat(getComputedStyle(bar).paddingRight)
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[data-out]') }
  const name = (el) => (el.getAttribute('aria-label') || el.title || el.textContent || el.className).trim().replace(/\\s+/g, ' ').slice(0, 40)
  const items = [...bar.querySelectorAll('.app__history .superego-icon-button, .titlebar__project, .titlebar__name > .superego-status, .titlebar__name > .thread__title, .titlebar__word, .titlebar__item, .strip__tab, .strip__map, .titlebar__more:not([hidden])')].filter(shown)
  const problems = []
  const boxes = items.map((el) => ({ el, r: el.getBoundingClientRect() }))
  for (let i = 0; i < boxes.length; i++) {
    const { el, r } = boxes[i]
    if (r.right > b.right - pad + 0.5) problems.push('spills out: ' + name(el))
    for (let j = i + 1; j < boxes.length; j++) {
      const o = boxes[j]
      if (el.contains(o.el) || o.el.contains(el)) continue
      const x = Math.min(r.right, o.r.right) - Math.max(r.left, o.r.left)
      const y = Math.min(r.bottom, o.r.bottom) - Math.max(r.top, o.r.top)
      if (x > 0.5 && y > 0.5) problems.push('overlap: ' + name(el) + ' / ' + name(o.el))
    }
  }
  // No text on two lines: each run of text in the bar on one.
  const walker = document.createTreeWalker(bar, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim() || !shown(node.parentElement)) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)))
    if (tops.size > 1) problems.push('wraps: ' + node.textContent.trim().slice(0, 40))
  }
  const title = bar.querySelector('.titlebar__name > .thread__title')
  if (title && title.getBoundingClientRect().width < 40) problems.push('the title squeezed to ' + Math.round(title.getBoundingClientRect().width) + 'px')
  const focused = bar.querySelector('.strip__tab.is-focused')
  if (focused && !shown(focused)) problems.push('the focused tab hidden')
  // The MCP chip a count, the model a mark, the profile a badge by the title.
  const chip = bar.querySelector('.mcp-chip')
  if (chip && !/^\\d+$/.test(chip.textContent.trim())) problems.push('the MCP chip says ' + chip.textContent.trim())
  const model = bar.querySelector('.threads-model')
  if (model && (model.textContent.trim() || !model.querySelector('svg'))) problems.push('the model not a mark: ' + model.textContent.trim())
  const profile = bar.querySelector('.thread__profile')
  if (profile && !profile.closest('.titlebar__crumb')) problems.push('the profile away from the title')
  const gone = [...bar.querySelectorAll('[data-out]')].map(name)
  return { problems, shown: items.map(name), gone }
})()`

await openApp({ name: 'titlebar-fit', timeout: 420_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1400, 640)
  await run(`window.addEventListener('error', (e) => (window.__errors ??= []).push(String(e.message)))`)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const start = (params) => t.call('thread.start', { cwd: project, ...params })
  const few = await start({ title: 'Fix the dates' })
  const typical = await start({ title: 'Review the ledger import', profile: 'reviewer' })
  const many = await start({ title: 'Sweatlers: chief of staff on the redesign of the onboarding flow and the billing pages', profile: 'chief-of-staff-for-the-ledger-fleet', parent: few.id })
  // A turn each, for the servers they'd have (the MCP chip says what the last turn had).
  for (const thread of [typical, many]) {
    await t.call('thread.send', { thread: thread.id, text: threads[0].prompt })
    await until(`window.superego.call('local', 'thread.list', {}).then((list) => ['done', 'error'].includes(list.find((s) => s.id === '${thread.id}')?.status.state))`, `${thread.title}: a turn`)
    await t.call('thread.seen', { thread: thread.id })
  }
  const pane = (thread, kind, params = {}) => t.call('pane.open', { thread: thread.id, kind, params })
  await pane(typical, 'diff')
  await pane(typical, 'editor', { path: 'README.md' })
  await pane(many, 'diff')
  await pane(many, 'editor', { path: 'README.md' })
  await pane(many, 'editor', { path: 'src/dates.mjs' })
  await pane(many, 'thread', { thread: typical.id })

  const select = async (thread) => {
    await t.resize(1400, 640)
    await until(`([...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes(${JSON.stringify(thread.title.slice(0, 20))}))?.click(), document.querySelector('.titlebar__title .thread__title')?.title === ${JSON.stringify(thread.title)})`, `${thread.title} shown`)
    await t.settled()
  }
  const shotBar = async (file) => {
    await t.settled()
    const rect = await run(`(() => { const r = document.querySelector('.app__titlebar').getBoundingClientRect(); return { x: 0, y: 0, width: Math.ceil(r.right), height: Math.ceil(r.bottom) } })()`)
    writeFileSync(join(OUT, `${file}.png`), (await t.contents().capturePage(rect)).toPNG())
  }

  const failures = []
  for (const [label, thread, layout] of [['few', few, 'scroll'], ['typical', typical, 'scroll'], ['many', many, 'stack']]) {
    await select(thread)
    if (thread !== few) {
      await run(`document.querySelector('.strip__layout [aria-label="${layout === 'stack' ? 'Stack' : 'Scroll'} panes"]').click()`)
      await until(`Boolean(document.querySelector('.panes${layout === 'stack' ? '.panes--stack' : ':not(.panes--stack)'}'))`, `the panes ${layout}ed`)
    }
    if (label === 'many') await until(`Boolean(document.querySelector('.fleet-pill')) && Boolean(document.querySelector('.mcp-chip'))`, 'the profile\'s pill and the MCP chip')
    for (const width of WIDTHS) {
      await t.resize(width, 640)
      for (const theme of ['light', 'dark']) {
        await t.theme(theme)
        const seen = await run(INSPECT)
        console.log(`${label} ${width} ${theme}: shown [${seen.shown.join(' | ')}] gone [${seen.gone.join(' | ')}]`)
        for (const problem of seen.problems) failures.push(`${label} at ${width} (${theme}): ${problem}`)
        await shotBar(`${label}-${width}-${theme}`)
      }
    }
  }

  // The ··· menu, at 900 with many: a row for each item gone; the MCP row opens the chip's popover from the ···.
  await select(many)
  await t.resize(900, 640)
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await t.mouse('.titlebar__more-button')
    await until(`Boolean(document.querySelector('.overflow-menu [data-item]'))`, 'the ··· menu')
    const rows = await run(`[...document.querySelectorAll('.overflow-menu [data-item]')].map((el) => el.textContent.trim())`)
    console.log(`menu (${theme}): ${rows.join(' | ')}`)
    if (!rows.some((r) => r.startsWith('MCP: 2 left out'))) failures.push(`the menu has no MCP row: ${rows.join(' | ')}`)
    if (!rows.some((r) => r.startsWith('Profile: chief-of-staff'))) failures.push(`the menu has no profile row: ${rows.join(' | ')}`)
    await until(`!document.querySelector('[data-starting-style]')`, 'the menu open')
    await t.settled()
    writeFileSync(join(OUT, `menu-${theme}.png`), (await t.contents().capturePage({ x: 300, y: 0, width: 600, height: 460 })).toPNG())
    await t.mouse('.overflow-menu [data-item="view:mcp-servers.chip"]')
    await until(`Boolean(document.querySelector('.mcp-chip__popup'))`, 'the MCP popover, from the menu')
    await until(`!document.querySelector('[data-starting-style], [data-ending-style]')`, 'the popover open, the menu gone')
    await t.settled()
    writeFileSync(join(OUT, `menu-mcp-popover-${theme}.png`), (await t.contents().capturePage({ x: 300, y: 0, width: 600, height: 300 })).toPNG())
    t.key('Escape', [])
    await until(`!document.querySelector('.mcp-chip__popup')`, 'the popover closed')
  }
  // A tab from the menu brings its pane to the front.
  await t.mouse('.titlebar__more-button')
  await until(`Boolean(document.querySelector('.overflow-menu [data-item^="tab:"]'))`, 'a tab in the ··· menu')
  const tab = await run(`document.querySelector('.overflow-menu [data-item^="tab:"]').textContent.trim()`)
  await t.mouse('.overflow-menu [data-item^="tab:"]')
  await until(`document.querySelector('.strip__tab.is-focused')?.textContent.includes(${JSON.stringify(tab)})`, `${tab} focused from the menu`)

  const errors = await run(`window.__errors ?? []`)
  for (const error of errors) failures.push(`page error: ${error}`)

  // A contact sheet: every bar, labelled, one under another.
  const shots = readdirSync(OUT).filter((f) => /^(few|typical|many)-\d+-(light|dark)\.png$/.test(f))
    .sort((a, b) => { const [la, wa, ta] = a.split(/[-.]/); const [lb, wb, tb] = b.split(/[-.]/); return ['few', 'typical', 'many'].indexOf(la) - ['few', 'typical', 'many'].indexOf(lb) || ta.localeCompare(tb) || wa - wb })
  // Each at its width in CSS pixels (the shots are at the screen's scale), so the bars line up as the window grew.
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:16px;background:#8a8a8a;font:13px -apple-system,sans-serif">${shots.map((f) => `<div style="margin:0 0 4px;color:#fff">${f.replace('.png', '')}</div><img src="${pathToFileURL(join(OUT, f))}" style="display:block;width:${f.split('-')[1]}px;margin:0 0 14px;box-shadow:0 0 0 1px #0003">`).join('')}</body>`
  writeFileSync(join(OUT, 'contact-sheet.html'), html)
  const sheet = new BrowserWindow({ show: false, width: 1840, height: 400, webPreferences: { offscreen: true } })
  await sheet.loadFile(join(OUT, 'contact-sheet.html'))
  const height = await sheet.webContents.executeJavaScript(`Promise.all([...document.images].map((i) => i.decode())).then(() => document.documentElement.scrollHeight)`)
  sheet.setContentSize(1840, Math.min(height, 16000))
  await new Promise((r) => setTimeout(r, 300))
  writeFileSync(join(OUT, 'contact-sheet.png'), (await sheet.webContents.capturePage()).toPNG())
  sheet.destroy()

  if (failures.length) t.fail(`${failures.length} problems:\n${failures.join('\n')}`)
})
