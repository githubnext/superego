// `pnpm dev`: electron-vite's dev server, on the app's own development bundle (named Superego, with Superego's icon) instead of
// the stock Electron.app, so macOS shows "Superego" in the menu bar, the Dock and Activity Monitor.
//
// `--home <dir>` runs it on another data dir: its own daemon, settings, keys, machines and window state, beside the one
// in ~/.superego (the same as SUPEREGO_HOME). `--fresh` does so in a new empty dir, to see the app as it comes.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { devApp } from '@superego/cli'
import { envName } from '@superego/protocol'
import app from '../superego.config.ts'

const root = new URL('..', import.meta.url).pathname
const args = process.argv.slice(2)
let home: string | undefined
const at = args.findIndex((arg) => arg === '--home' || arg.startsWith('--home='))
if (at >= 0) {
  const [arg] = args.splice(at, 1)
  const value = arg!.includes('=') ? arg!.slice('--home='.length) : args.splice(at, 1)[0]
  if (!value || value.startsWith('--')) {
    console.error('usage: pnpm dev --home <dir>')
    process.exit(2)
  }
  home = resolve(value.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
  mkdirSync(home, { recursive: true })
}
const fresh = args.indexOf('--fresh')
if (fresh >= 0) {
  args.splice(fresh, 1)
  if (home) {
    console.error('pnpm dev: --fresh or --home, not both')
    process.exit(2)
  }
  home = mkdtempSync(join(tmpdir(), `${app.id}-fresh-`))
}
if (home) console.log(`${app.name} data in ${home}`)

const child = spawn('electron-vite', ['dev', ...args], {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, ELECTRON_EXEC_PATH: devApp(root, app), ...(home ? { [envName(app, 'HOME')]: home } : {}) },
})
child.on('exit', (code) => process.exit(code ?? 0))
