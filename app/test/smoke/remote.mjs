// The second machine's profile UI: the thread works without it, and the window asks; it runs once allowed here, stops
// when its sources change, and is taken out when revoked, with a reload offered. Then Ego on each machine.
import { readFileSync, writeFileSync } from 'node:fs'
import { home, openNotice, openRow } from './common.mjs'

export default async function remote(t, s) {
  const onSecond = (await t.call('thread.start', { title: '' }, s.second)).id
  await t.call('thread.send', { thread: onSecond, text: 'over on second' }, s.second)
  await t.until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('over on second'))`, 'the remote thread in the sidebar', 30_000)
  await openRow(t, 'over on second')
  await t.until(`document.querySelector('.transcript')?.textContent.includes('echo: over on second')`, 'the remote thread works')
  await t.until(`document.querySelector('.profile-ui-notice')?.textContent.includes('Second’s profile default has UI code')`, 'asked to allow the remote profile UI')
  await t.check(`!document.querySelector('.remote-badge')`, 'remote profile UI ran before it was allowed')
  await t.run(`[...document.querySelectorAll('.profile-ui-notice button')].find((b) => /files?,/.test(b.textContent)).click()`)
  await t.until(`document.querySelector('.profile-ui-notice__files')?.textContent.includes('ui/label.ts')`, 'its files listed')
  await t.click('.profile-ui-notice__file', 'ui/label.ts')
  await t.until(`document.querySelector('.profile-source')?.textContent.includes("remote ui")`, 'its source shown, read-only, in a pane')
  await t.click('.profile-ui-notice button', 'Allow')
  await t.until(`document.querySelector('.remote-badge')?.textContent === 'remote ui' && !document.querySelector('.profile-ui-notice')`, 'the remote profile UI runs once allowed')
  // Changed there: it stops, and the window asks again.
  writeFileSync(`${home}/second/profiles/default/ui/label.ts`, "export const label: string = 'changed ui'\n")
  await t.call('thread.send', { thread: onSecond, text: 'after the change' }, s.second)
  await t.until(`!document.querySelector('.remote-badge') && Boolean(document.querySelector('.profile-ui-notice'))`, 'a changed profile UI stops until allowed again')
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
