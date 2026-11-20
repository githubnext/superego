// A daemon runs from a snapshot of its build (see snapshot.ts): the app rebuilt under it, its chunks renamed and the old
// ones deleted, what it loads later still loads. The stand-in build here is the bundler's shape: a launcher (daemon.js),
// the daemon proper (daemon-main.js), and a chunk by a hashed name it imports lazily, as a provider is on its first use.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readBuild } from '../src/build.ts'
import { snapshotsDir, sweepSnapshots } from '../src/snapshot.ts'

let dir: string
let out: string
let data: string
const running: ChildProcess[] = []

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'superego-snapshot-')))
  out = join(dir, 'out')
  data = join(dir, 'data')
})
afterEach(() => {
  for (const child of running) child.kill()
  running.length = 0
  rmSync(dir, { recursive: true, force: true })
})

/** Build the app: out/ emptied and written anew, with its lazy chunk named `hash`, saying `says`. */
function build(hash: string, says: string) {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, 'main'), { recursive: true })
  mkdirSync(join(out, 'types'))
  writeFileSync(join(out, 'package.json'), '{ "type": "module" }\n')
  writeFileSync(join(out, 'types', 'index.d.ts'), 'export {}\n')
  writeFileSync(join(out, 'main', 'daemon.js'), `import { launchDaemon } from ${JSON.stringify(new URL('../src/snapshot.ts', import.meta.url).href)}
launchDaemon({ id: 'snaptest', name: 'Snaptest' }, import.meta.url, 'daemon-main.js')\n`)
  writeFileSync(join(out, 'main', 'daemon-main.js'), `import { createInterface } from 'node:readline'
console.log('ready ' + import.meta.dirname)
createInterface({ input: process.stdin }).on('line', async () => {
  try { console.log((await import('./provider-${hash}.js')).says) } catch (error) { console.log('error ' + error.message) }
})\n`)
  writeFileSync(join(out, 'main', `provider-${hash}.js`), `export const says = ${JSON.stringify(says)}\n`)
}

/** Start the daemon from the build, as the app does; what it says, line by line. */
async function start() {
  const child = spawn(process.execPath, [join(out, 'main', 'daemon.js')], { env: { ...process.env, SNAPTEST_HOME: data }, stdio: ['pipe', 'pipe', 'inherit'] })
  running.push(child)
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]()
  const next = async () => (await lines.next()).value as string
  const ready = await next()
  expect(ready).toMatch(/^ready /)
  /** The lazy chunk's first use. */
  const use = () => { child.stdin!.write('use\n'); return next() }
  return { from: ready.slice('ready '.length), use }
}

it('keeps loading its own code after the app is rebuilt under it', async () => {
  build('CVScjcJc', 'old')
  const built = readBuild(join(out, 'main'))
  const daemon = await start()
  build('tpN0xeJC', 'new')
  expect(existsSync(join(out, 'main', 'provider-CVScjcJc.js'))).toBe(false)
  expect(await daemon.use()).toBe('old')
  expect(daemon.from).toBe(join(snapshotsDir(data), built, 'main'))
  // Started again (a restart), it runs the new build.
  const next = await start()
  expect(next.from).toBe(join(snapshotsDir(data), readBuild(join(out, 'main')), 'main'))
  expect(await next.use()).toBe('new')
})

it('snapshots the build once, without the profile authors’ types', async () => {
  build('CVScjcJc', 'old')
  const first = await start()
  const second = await start()
  expect(second.from).toBe(first.from)
  expect(readdirSync(snapshotsDir(data))).toEqual([readBuild(join(out, 'main'))])
  expect(readdirSync(join(first.from, '..')).sort()).toEqual(['main', 'package.json'])
})

it('removes the snapshots the running daemon does not run from', () => {
  for (const name of ['aaaa/main', 'bbbb/main', '.copying-123']) mkdirSync(join(snapshotsDir(data), name), { recursive: true })
  sweepSnapshots(data, join(snapshotsDir(data), 'bbbb', 'main'))
  expect(readdirSync(snapshotsDir(data))).toEqual(['bbbb'])
  // The daemon knows where it runs by its real path; the data dir may be named through a symlink.
  symlinkSync(data, join(dir, 'link'))
  mkdirSync(join(snapshotsDir(data), 'cccc', 'main'), { recursive: true })
  sweepSnapshots(join(dir, 'link'), join(snapshotsDir(data), 'cccc', 'main'))
  expect(readdirSync(snapshotsDir(data))).toEqual(['cccc'])
  // From source, or a packaged app: none is its own.
  sweepSnapshots(data, '/elsewhere/packages/daemon/src')
  expect(readdirSync(snapshotsDir(data))).toEqual([])
})
