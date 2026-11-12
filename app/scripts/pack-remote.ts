// The daemon as one thing to copy to another machine: `out/remote/<id>-remote.tgz`, holding the CLI and daemon bundles
// (main/cli.js, main/daemon.js and their chunks, all dependencies inside), the window's web build for Web access and the
// skill pages `superego --skill` prints.
// Needs only Node 22.18+ on the far side. Run after `electron-vite build`.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import app from '../superego.config.ts'

const root = new URL('..', import.meta.url).pathname
const out = join(root, 'out')
if (!existsSync(join(out, 'main/cli.js')) || !existsSync(join(out, 'renderer/index.html'))) throw new Error('Nothing built: run electron-vite build first')

const stage = join(out, 'remote-stage')
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, 'main'), { recursive: true })
// Everything in main but the Electron entry (it would need Electron).
for (const name of readdirSync(join(out, 'main'))) if (name !== 'main.js') cpSync(join(out, 'main', name), join(stage, 'main', name))
cpSync(join(out, 'renderer'), join(stage, 'renderer'), { recursive: true })
// `superego --skill` reads its pages from ../skill, beside main/.
cpSync(join(root, '../packages/cli/skill'), join(stage, 'skill'), { recursive: true })
writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: `${app.id}-remote`, private: true, type: 'module' }) + '\n')

mkdirSync(join(out, 'remote'), { recursive: true })
const tarball = join(out, 'remote', `${app.id}-remote.tgz`)
// COPYFILE_DISABLE: no AppleDouble files from macOS in the archive.
execFileSync('tar', ['-czf', tarball, '-C', stage, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
rmSync(stage, { recursive: true, force: true })
console.log(tarball)
