// `pnpm dev`: electron-vite's dev server, on the app's own development bundle (named Superego, with Superego's icon) instead of
// the stock Electron.app, so macOS shows "Superego" in the menu bar, the Dock and Activity Monitor.
import { spawn } from 'node:child_process'
import { devApp } from '@superego/cli'
import app from '../superego.config.ts'

const root = new URL('..', import.meta.url).pathname
const child = spawn('electron-vite', ['dev', ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_EXEC_PATH: devApp(root, app) },
})
child.on('exit', (code) => process.exit(code ?? 0))
