// The second machine's profile UI: the thread works without it, and the window asks; it runs once allowed here, stops
// when its sources change, and is taken out when revoked, with a reload offered. A Browser pane at its localhost, forwarded
// here. Then Ego on each machine.
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { home, openNotice, openRow, pageAt } from './common.mjs'

export default async function remote(t, s) {
  const onSecond = (await t.call('thread.start', { title: '' }, s.second)).id
  await t.call('thread.send', { thread: onSecond, text: 'over on second' }, s.second)
  await t.until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('over on second'))`, 'the remote thread in the sidebar', 30_000)
  await openRow(t, 'over on second')
  await t.until(`document.querySelector('.transcript')?.textContent.includes('echo: over on second')`, 'the remote thread works')
  // A dev server on the second machine's localhost (this computer's too, here): its port is taken here, so the page is
  // forwarded at another, and loads in the Browser pane's own view through the machine's link.
  const devServer = await new Promise((resolve) => { const server = createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end('<title>on second</title>') }).listen(0, '127.0.0.1', () => resolve(server)) })
  const devUrl = `http://127.0.0.1:${devServer.address().port}/`
  await t.call('pane.open', { thread: onSecond, kind: 'browser', params: { url: devUrl } }, s.second)
  await t.until(`document.querySelector('.panes__column:has(.web-view) .browser-address')?.textContent.includes('here at 127.0.0.1:')`, 'the page forwarded at another port')
  const forwarded = await t.run(`document.querySelector('.panes__column:has(.web-view) a[aria-label="Open in browser"]').href`)
  await t.until(() => pageAt(forwarded)?.isLoading() === false && pageAt(forwarded).getTitle() === 'on second', "the second machine's page, through the forward")
  const previewPane = (await t.call('thread.list', {}, s.second)).find((x) => x.id === onSecond).panes.find((p) => p.kind === 'browser').id
  await t.call('pane.close', { thread: onSecond, pane: previewPane }, s.second)
  devServer.close()
  await t.until(`document.querySelector('.profile-ui-notice')?.textContent.includes('Second’s profile default has UI code')`, 'asked to allow the remote profile UI')
  await t.check(`!document.querySelector('.remote-badge')`, 'remote profile UI ran before it was allowed')
  await t.run(`[...document.querySelectorAll('.profile-ui-notice button')].find((b) => /files?,/.test(b.textContent)).click()`)
  await t.until(`document.querySelector('.profile-ui-notice__files')?.textContent.includes('ui/label.ts')`, 'its files listed')
  await t.click('.profile-ui-notice__file', 'ui/label.ts')
  await t.until(`document.querySelector('.profile-source')?.textContent.includes("remote ui")`, 'its source shown, read-only, in a pane')
  await t.click('.profile-ui-notice button', 'Allow')
  await t.until(`document.querySelector('.remote-badge')?.textContent === 'remote ui' && !document.querySelector('.profile-ui-notice')`, 'the remote profile UI runs once allowed')
  // The same profile on both machines, each styling one class its way: each one's rule reaches only its own threads.
  const scopedColours = `[...document.querySelectorAll('.app__sidebar .superego-list-item')].flatMap((li) => [...li.querySelectorAll('.smoke-scoped')].map((el) => (li.textContent.includes('over on second') ? 'second ' : 'local ') + getComputedStyle(el).color))`
  await t.until(`(() => { const seen = ${scopedColours}; return seen.includes('second rgb(255, 0, 0)') && seen.some((c) => c.startsWith('local ')) && seen.every((c) => c === 'second rgb(255, 0, 0)' || c === 'local rgb(0, 128, 0)') })()`, "each machine's profile styles only its own threads")
  // Changed there: it stops, and the window asks again.
  writeFileSync(`${home}/second/profiles/default/ui/label.ts`, "export const label: string = 'changed ui'\n")
  await t.call('thread.send', { thread: onSecond, text: 'after the change' }, s.second)
  await t.until(`!document.querySelector('.remote-badge') && Boolean(document.querySelector('.profile-ui-notice'))`, 'a changed profile UI stops until allowed again')
  await t.check(`!document.querySelector('style[data-extension="remote-badge"]')`, "a stopped profile UI's styles stayed")
  // Not now: remembered on this computer for these sources, and the header says so quietly; a click asks again.
  await t.click('.profile-ui-notice button', 'Not now')
  await t.until(`!document.querySelector('.profile-ui-notice') && document.querySelector('.profile-ui-marker')?.textContent === 'UI not allowed'`, 'put off: a marker in the header')
  if (!readFileSync(`${home}/ui-declined.json`, 'utf8').includes('"default"')) t.fail('"Not now" not kept in ui-declined.json')
  await t.click('.profile-ui-marker')
  await t.until(`Boolean(document.querySelector('.profile-ui-notice')) && !document.querySelector('.profile-ui-marker')`, 'the marker asks again')
  await t.click('.profile-ui-notice button', 'Allow')
  await t.until(`document.querySelector('.remote-badge')?.textContent === 'changed ui'`, 'the changed UI runs once allowed')
  // Settings lists it under its machine; Revoke takes it out.
  await t.click('.app__settings')
  await t.click('.settings__nav button', 'Machines')
  await t.until(`document.querySelector('.machine-row__ui-summary')?.textContent === 'UI from 1 profile runs here'`, 'allowed profile UI summed up in Settings')
  await t.click('.machine-row__ui-summary')
  await t.until(`document.querySelector('.machine-row__ui')?.textContent.includes('default')`, 'allowed profile UI listed in Settings')
  await t.click('.machine-row__ui button', 'Revoke')
  await t.until(`!document.querySelector('.machine-row__ui') && !document.querySelector('.remote-badge')`, 'revoked: the remote profile UI stops')
  // Its code ran here: a reload is offered, to stop anything it left going.
  await t.until(`document.querySelector('.machine-row__revoked')?.textContent.includes('Reload the window')`, 'revoked: a reload offered in Settings')
  t.key('Escape', [])
  await t.until(`!document.querySelector('.settings')`, 'settings closed')
  await t.until(`Boolean(document.querySelector('.profile-ui-notice')) && !document.querySelector('.profile-ui-marker')`, 'revoked: asked again')
  await openNotice(t, 'revoked', 'revoked UI')
  await t.until(`[...document.querySelectorAll('.rail-notice__popup .revoked-ui-notice button')].some((b) => b.textContent === 'Reload')`, 'revoked: a reload offered in the window')
  await t.click('.rail-notice__popup .revoked-ui-notice button', 'Later')
  await t.until(`!document.querySelector('.rail-notice--revoked') && !document.querySelector('.rail-notice__popup')`, 'revoked: the reload put off')

  // Ego on each machine: its title bar says whose, and switches to another's; the rail opens the one last chosen.
  const pickEgo = (machine) => t.run(`(() => {
    const select = document.querySelector('.ego__machine')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(machine)})
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await t.click('.ego__button')
  await t.until(`document.querySelector('.thread__title')?.textContent === 'Ego' && document.querySelector('.ego__machine')?.value === 'local' && document.querySelectorAll('.ego__machine option').length === 2`, 'Ego, with a machine switch')
  await pickEgo(s.second)
  await t.until(`document.querySelector('.ego__machine')?.value === '${s.second}' && document.querySelector('.thread__title')?.textContent === 'Ego' && document.querySelector('.ego__button').classList.contains('is-on')`, "the second machine's Ego")
  if ((await t.call('thread.list', {}, s.second)).some((x) => x.facts?.ego)) t.fail('Ego listed on the second machine')
  await t.click('.app__rail [aria-label="Threads"]')
  await t.until(`[...document.querySelectorAll('.app__sidebar .superego-list-item')].some((li) => li.textContent.includes('over on second'))`, 'the sidebar, from Ego')
  await openRow(t, 'over on second')
  await t.until(`!document.querySelector('.ego__machine') && !document.querySelector('.ego__button').classList.contains('is-on')`, 'away from Ego')
  await t.click('.ego__button')
  await t.until(`document.querySelector('.ego__machine')?.value === '${s.second}'`, 'the rail opens the Ego last chosen')
  await pickEgo('local')
  await t.until(`document.querySelector('.ego__machine')?.value === 'local'`, "back to this computer's Ego")
  // Left on Threads: the window reopens as it was left, and reopening starts from the sidebar.
  await t.click('.app__rail [aria-label="Threads"]')
  await t.until(`Boolean(document.querySelector('.app__sidebar .threads'))`, 'back on Threads')
}
