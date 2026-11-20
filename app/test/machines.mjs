// Screenshots of Settings → Machines (run by `test/look.sh <dir> machines`): this computer and two other machines, `mbp`
// behind this computer's Superego, its daemon with no service, and two of its profiles' UI allowed here; `workbox` as it
// should be. In light and dark, wide and narrow; then mbp's menu and its profile UIs opened. Into $SUPEREGO_SHOWCASE_OUT.
//
// The two machines are made up on their way to the window, as states.mjs makes up its workbox: calls to them answer
// nothing.
import { ipcMain, app } from 'electron'
import { openApp } from './harness.mjs'

const HOUR = 3_600_000
const MACHINES = [
  {
    id: 'mbp', label: 'mbp', state: 'connected', features: [], extensions: [], machine: { id: 'mbp-id', hostname: 'Mikkels-MBP.localdomain' },
    keepsRunning: { service: null, afterLogout: null }, remote: { route: 'ssh mbp ~/.local/bin/superego connect --start', enabled: true, ssh: true },
    drift: { state: 'behind', commit: '27785fc0aa', by: 14 * HOUR },
  },
  {
    id: 'workbox', label: 'workbox', state: 'connected', features: [], extensions: [], machine: { id: 'workbox-id', hostname: 'mikker-workbox' },
    keepsRunning: { service: 'systemd', afterLogout: true }, remote: { route: 'ssh workbox ~/.local/bin/superego connect', enabled: true, ssh: true },
    drift: { state: 'current' },
  },
]
const profile = (name, files) => ({
  machine: 'mbp', profile: { scope: 'user', name, dir: `/Users/me/.superego/profiles/${name}` }, hash: name, at: 0,
  files: files.map((size, i) => ({ path: `ui/${i}.ts`, size })),
})
const ALLOWED = [profile('default', [9_000, 8_000, 4_200]), profile('chief-of-staff', [20_000, 12_000, 9_000, 9_000, 7_900])]
const withMachines = (list) => [...list.filter((m) => !MACHINES.some((made) => made.id === m.id)), ...MACHINES]

const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, run) => handle(channel, channel === 'superego:machines'
  ? async (...args) => withMachines(await run(...args))
  : channel === 'superego:call'
    ? async (event, machine, method, params) => {
      if (MACHINES.some((m) => m.id === machine)) return { ok: true, result: method.endsWith('.watch') ? { sub: `${machine}-${method}`, value: null } : null }
      if (machine === 'app' && method === 'profileUi.allowed') return { ok: true, result: ALLOWED }
      return run(event, machine, method, params)
    }
    : run)
app.on('web-contents-created', (_event, contents) => {
  const send = contents.send.bind(contents)
  contents.send = (channel, message, ...rest) => {
    if (channel === 'superego:event' && message?.method === '$machines') message = { ...message, params: withMachines(message.params) }
    return send(channel, message, ...rest)
  }
})

await openApp({ name: 'machines', timeout: 180_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1100, 760)
  await t.click('.app__settings')
  await until(`Boolean(document.querySelector('.settings__nav'))`, 'Settings')
  await t.click('.settings__nav button', 'Machines')
  await until(`document.querySelectorAll('.machine-row').length === 3 && (document.querySelector('.settings')?.textContent.includes('chief-of-staff') || Boolean(document.querySelector('.machine-row__ui-summary')))`, 'three machines, mbp\'s profile UIs')
  const section = `document.querySelector('.machine-row').closest('.settings-section')`
  const both = async (file) => {
    for (const theme of ['light', 'dark']) {
      await t.theme(theme)
      await t.shot(`${file}-${theme}`, section)
    }
  }
  await both('machines')
  await t.resize(620, 760)
  await both('machines-narrow')
  await t.resize(1100, 760)
  // mbp's ··· menu, and its profile UIs listed (where this page has them).
  if (await run(`Boolean(document.querySelector('.machine-row__menu'))`)) {
    await t.theme('light')
    await t.click('.machine-row__ui-summary')
    await until(`document.querySelectorAll('.machine-row__ui').length === 2`, 'mbp\'s profile UIs listed')
    await t.mouse(`[data-machine="mbp"] .machine-row__menu`)
    await until(`Boolean(document.querySelector('.superego-menu'))`, 'mbp\'s menu')
    await t.shot('machines-menu-light')
    t.key('Escape', [])
    await until(`!document.querySelector('.superego-menu')`, 'menu closed')
  }
  await t.theme('system')
})
