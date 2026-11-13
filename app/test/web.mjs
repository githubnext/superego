// Screenshots of Settings → Web access (run by `test/look.sh <dir> web`): pairing a device, the devices paired, and each
// state Tailscale can be in, light and dark. A stub `tailscale` stands in for the real one (test/showcase/tailscale.sh).
import { app, BrowserWindow, nativeTheme } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'

const fail = (message) => { console.error(`look: FAIL ${message}`); app.exit(1) }
process.on('uncaughtException', (error) => fail(`uncaught: ${error.stack ?? error}`))
setTimeout(() => fail('timed out'), 180_000)

await import('../out/main/main.js')
void (async () => {
  await app.whenReady()
  const home = process.env.SUPEREGO_HOME
  const out = process.env.SUPEREGO_SHOWCASE_OUT
  const win = () => BrowserWindow.getAllWindows()[0]
  const run = (js) => win().webContents.executeJavaScript(js)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (js, label, ms = 30_000) => {
    for (let i = 0; i < ms / 100; i++) {
      if (win() && !win().webContents.isLoading()) { const value = await run(js).catch(() => undefined); if (value) return value }
      await sleep(100)
    }
    fail(`waiting for ${label}`)
    throw new Error(label)
  }
  const http = (port, path, headers, body) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', headers }, (res) => { res.resume(); res.on('end', () => resolve(res)) })
    req.on('error', reject)
    req.end(body)
  })
  const call = (method, params = {}) => run(`window.superego.call('local', ${JSON.stringify(method)}, ${JSON.stringify(params)})`)
  const set = (key, value) => call('settings.set', { key, value })
  const both = async (name) => {
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme
      await sleep(400)
      await run(`document.querySelector('.web-access')?.scrollIntoView({ block: 'end' })`)
      await sleep(150)
      writeFileSync(`${out}/${name}-${theme}.png`, (await win().webContents.capturePage()).toPNG())
    }
  }

  // Never the machine's own tailscale: only the stub may be on PATH (look.sh sees to it).
  const real = (process.env.PATH ?? '').split(':').filter((dir) => dir && dir !== `${home}/bin` && existsSync(`${dir}/tailscale`))
  if (real.length) return fail(`a real tailscale is on PATH (${real.join(', ')}): run this through test/look.sh <dir> web`)
  await until(`window.superego.machines().then((list) => list.find((m) => m.id === 'local')?.state === 'connected')`, 'local machine')
  win().setContentSize(1100, 760)
  const port = 20000 + Math.floor(Math.random() * 20000)
  await set('web.port', port)
  await set('web.access', 'local')
  // Two devices paired, as a phone and a laptop would.
  const agents = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0',
  ]
  for (const agent of agents) {
    const { link } = await call('web.pair')
    const ticket = new URL(link).hash.slice('#pair='.length)
    await http(port, '/pair', { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'user-agent': agent }, JSON.stringify({ ticket }))
  }
  const [phone] = (await call('web.devices')).filter((d) => d.name.includes('iPhone'))
  await call('web.rename', { id: phone.id, name: 'Phone' })

  await run(`document.querySelector('.app__settings').click()`)
  await until(`Boolean(document.querySelector('.settings__nav'))`, 'Settings')
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent.includes('This computer')).click()`)
  await until(`document.querySelectorAll('.web-device').length === 2`, 'the devices')
  await both('web-devices')
  await run(`[...document.querySelectorAll('.web-access button')].find((b) => b.textContent === 'Pair a device').click()`)
  await until(`Boolean(document.querySelector('.web-pair__qr svg'))`, 'the pairing QR code')
  await both('web-pair')
  await run(`[...document.querySelectorAll('.web-pair button')].find((b) => b.textContent === 'Done').click()`)

  // Tailscale, in each state it can be in.
  const status = {
    BackendState: 'Running', CertDomains: ['studio.tail1234.ts.net'],
    Self: { DNSName: 'studio.tail1234.ts.net.', HostName: 'studio', UserID: 1, TailscaleIPs: ['100.64.0.1'] },
    Peer: { a: { HostName: 'iphone', TailscaleIPs: ['100.64.0.7'] } },
    User: { 1: { LoginName: 'me@example.com' } },
  }
  const tailscale = async (state, statusJson) => {
    writeFileSync(`${home}/tailscale-status.json`, JSON.stringify(statusJson))
    await set('web.access', 'off')
    await set('web.access', 'tailscale')
    await until(`window.superego.call('local', 'settings.watch', {}).then((r) => r.value.sections.find((s) => s.id === 'web').data?.tailscale?.state === ${JSON.stringify(state)})`, `Tailscale ${state}`)
  }
  await tailscale('logged-out', { ...status, BackendState: 'NeedsLogin' })
  await both('web-tailscale-logged-out')
  await tailscale('no-https', { ...status, CertDomains: null })
  await both('web-tailscale-no-https')
  await tailscale('serving', status)
  // The owner, from their phone, through serve.
  const proxy = JSON.parse(readFileSync(`${home}/tailscale-serve.json`, 'utf8')).Web['studio.tail1234.ts.net:443'].Handlers['/'].Proxy
  await http(port, `${new URL(proxy).pathname}/rpc`, { host: 'studio.tail1234.ts.net', 'x-forwarded-for': '100.64.0.7', 'tailscale-user-login': 'me@example.com' })
  await until(`[...document.querySelectorAll('.web-device')].some((d) => d.textContent.includes('via Tailscale'))`, 'the owner via Tailscale')
  await both('web-tailscale-serving')
  renameSync(`${home}/bin/tailscale`, `${home}/bin/tailscale-gone`)
  await tailscale('missing', status)
  await both('web-tailscale-missing')
  nativeTheme.themeSource = 'system'
  writeFileSync(`${home}/passed`, '')
  app.exit(0)
})()
