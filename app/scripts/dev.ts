// `pnpm dev`: electron-vite's dev server, on the app's own development bundle (named mu, with mu's icon) instead of
// the stock Electron.app, so macOS shows "mu" in the menu bar, the Dock and Activity Monitor.
import { spawn } from 'node:child_process'
import { devApp } from '@mu/cli'
import app from '../mu.config.ts'

const root = new URL('..', import.meta.url).pathname
const child = spawn('electron-vite', ['dev', ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_EXEC_PATH: devApp(root, app) },
})
child.on('exit', (code) => process.exit(code ?? 0))
