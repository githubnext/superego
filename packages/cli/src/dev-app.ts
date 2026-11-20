// The app as macOS sees it while it runs from source. Run on the stock Electron.app, it would be "Electron" in the menu
// bar, the Dock, ⌘-Tab, notifications and Activity Monitor: macOS names an app by its bundle, not by anything the app
// says. So this makes a copy of Electron.app named for the app (an APFS clone, instantly and without the disk space),
// with the app's name, a bundle id of its checkout's own (see devBundleId) and icon (the `<id>.icon` compiled in, so its
// light, dark, tinted and clear variants too), its helpers renamed to match, signed again ad hoc. It is remade when
// Electron, the app's name, id, icon or launcher change. Elsewhere than macOS: Electron as it is.
//
// macOS finds an app by its bundle id: a notification's click goes to the app with the id that posted it, launching it
// if it isn't running. So each checkout's bundle has an id of its own (one shared by every worktree's had clicks start
// whichever copy LaunchServices liked best), and the bundle carries a launcher: started with no app to run (by a
// notification, Finder or the Dock), it runs its checkout's app, never Electron's default page. Once made, it's
// registered with LaunchServices, and the copies of it that are gone (worktrees removed) unregistered.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { AppConfig } from '@superego/protocol'

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

/**
 * The bundle id of the development bundle of the app at `appDir`: `<bundleId>.dev` (never taken for an installed copy)
 * and a short hash of the checkout's path, so no two checkouts' bundles share one.
 */
export function devBundleId(appDir: string, app: AppConfig): string {
  const hash = createHash('sha256').update(realpathSync(resolve(appDir))).digest('hex').slice(0, 10)
  return `${app.bundleId ?? `dev.superego.${app.id}`}.dev.${hash}`
}

/**
 * The bundle's launcher (`Contents/Resources/app/main.js`), which Electron runs in place of its default app: it hands
 * the arguments on to Electron's default app (`default_app.asar`), which runs the app they name, as it would without it.
 * Given none to run (no argument but flags), as macOS starts an app, it names the checkout's app at `appDir` first.
 */
export function devLauncher(appDir: string): string {
  return `// Made by @superego/cli's dev-app.ts: runs ${JSON.stringify(appDir)} when started with no app to run.
const args = process.argv.slice(1)
if (!args.some((arg) => !arg.startsWith('-') || arg.startsWith('--app='))) process.argv.splice(1, 0, ${JSON.stringify(appDir)})
await import(new URL('../default_app.asar/main.js', import.meta.url).href)
`
}

/** The executable to run the app at `appDir` with: its own development bundle on macOS, else Electron's. */
export function devApp(dir: string, app: AppConfig): string {
  const appDir = resolve(dir)
  const electron = createRequire(join(appDir, 'package.json'))('electron') as string
  if (process.platform !== 'darwin') return electron
  const source = join(dirname(dirname(dirname(electron))))
  if (!source.endsWith('.app')) return electron
  const bundleId = devBundleId(appDir, app)
  const launcher = devLauncher(appDir)
  const icon = join(appDir, 'resources', `${app.id}.icon`)
  const icns = join(appDir, 'resources', 'icon.icns')
  const home = join(appDir, 'node_modules', `.${app.id}-dev`)
  const bundle = join(home, `${app.name}.app`)
  const executable = join(bundle, 'Contents', 'MacOS', app.name)
  const stamp = createHash('sha256').update(JSON.stringify([
    electron, statSync(electron).mtimeMs, app.name, bundleId, launcher, filesOf(icon), existsSync(icns) ? statSync(icns).mtimeMs : 0,
  ])).digest('hex')
  // The stamp is written last, so a bundle without one (a build cut short) is made again too.
  const current = () => existsSync(executable) && existsSync(join(home, 'stamp')) && readFileSync(join(home, 'stamp'), 'utf8').trim() === stamp
  if (current()) return executable

  // Made beside it and swapped in whole, so a build that fails, or two at once (the app and the CLI both start one),
  // never leave a half-made bundle where the next run looks.
  const work = `${home}.${process.pid}`
  rmSync(work, { recursive: true, force: true })
  try {
    build(work)
    // Another run may have finished first, and be running from it: keep that one.
    if (!current()) {
      rmSync(home, { recursive: true, force: true })
      renameSync(work, home)
      register(bundle, app)
    }
  } catch (error) {
    if (!current()) throw error
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return executable

  function build(home: string) {
    const bundle = join(home, `${app.name}.app`)
    // `cp -c` clones on APFS: a copy that shares the original's blocks until one is written.
    execFileSync('mkdir', ['-p', home])
    execFileSync('cp', ['-cR', source, bundle])
    const contents = join(bundle, 'Contents')
    const plist = (file: string, key: string, value: string) => execFileSync('plutil', ['-replace', key, '-string', value, file])
    renameSync(join(contents, 'MacOS', 'Electron'), join(contents, 'MacOS', app.name))
    for (const [key, value] of [['CFBundleExecutable', app.name], ['CFBundleName', app.name], ['CFBundleDisplayName', app.name], ['CFBundleIdentifier', bundleId]]) {
      plist(join(contents, 'Info.plist'), key!, value!)
    }
    // The helpers (renderer, GPU, …) show in Activity Monitor too: "<name> Helper (Renderer)".
    const frameworks = join(contents, 'Frameworks')
    for (const helper of readdirSync(frameworks).filter((name) => name.startsWith('Electron Helper') && name.endsWith('.app'))) {
      const old = helper.slice(0, -'.app'.length)
      const named = old.replace('Electron', app.name)
      renameSync(join(frameworks, helper), join(frameworks, `${named}.app`))
      renameSync(join(frameworks, `${named}.app`, 'Contents', 'MacOS', old), join(frameworks, `${named}.app`, 'Contents', 'MacOS', named))
      const info = join(frameworks, `${named}.app`, 'Contents', 'Info.plist')
      const id = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', info], { encoding: 'utf8' }).trim()
      for (const [key, value] of [['CFBundleExecutable', named], ['CFBundleName', named], ['CFBundleIdentifier', id.replace(/^com\.github\.Electron/, bundleId)]]) plist(info, key!, value!)
    }
    // The icon: the .icns for older macOS, the compiled .icon (Assets.car, CFBundleIconName) for its variants.
    const resources = join(contents, 'Resources')
    // Electron runs Resources/app ahead of its default app: the launcher, which hands on to it.
    mkdirSync(join(resources, 'app'))
    writeFileSync(join(resources, 'app', 'package.json'), JSON.stringify({ name: `${app.id}-dev`, productName: app.name, main: 'main.js', type: 'module' }, null, 2) + '\n')
    writeFileSync(join(resources, 'app', 'main.js'), launcher)
    if (existsSync(icns)) cpSync(icns, join(resources, 'electron.icns'))
    if (existsSync(icon)) {
      const partial = join(home, 'icon-partial.plist')
      execFileSync('xcrun', [
        'actool', icon, '--compile', resources, '--app-icon', app.id, '--enable-on-demand-resources', 'NO', '--development-region', 'en',
        '--target-device', 'mac', '--platform', 'macosx', '--minimum-deployment-target', '26.0', '--output-partial-info-plist', partial,
      ], { stdio: 'pipe' })
      plist(join(contents, 'Info.plist'), 'CFBundleIconName', app.id)
    }
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'pipe' })
    writeFileSync(join(home, 'stamp'), stamp + '\n')
  }
}

/**
 * Register `bundle` with LaunchServices (so a notification's click finds it to launch), and unregister the app's
 * development bundles that are no longer there (removed worktrees'). Saying so when it can't: the bundle runs all the
 * same.
 */
function register(bundle: string, app: AppConfig) {
  try {
    execFileSync(LSREGISTER, ['-f', bundle], { stdio: 'pipe' })
    const dump = execFileSync(LSREGISTER, ['-dump'], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    const gone = staleDevBundles(dump, app, existsSync)
    if (gone.length) execFileSync(LSREGISTER, ['-u', ...gone], { stdio: 'pipe' })
  } catch (error) {
    console.warn(`Couldn't register ${bundle} with LaunchServices: ${(error as Error).message}`)
  }
}

/**
 * The app's development bundles registered in an `lsregister -dump` (any checkout's `node_modules/.<id>-dev/<name>.app`,
 * or one cut short while being made, in `.<id>-dev.<pid>`) that `exists` says are gone.
 */
export function staleDevBundles(dump: string, app: AppConfig, exists: (path: string) => boolean): string[] {
  const home = `.${app.id}-dev`
  const ours = (path: string) => {
    const [modules, dir = '', name] = path.split('/').slice(-3)
    const made = dir === home || (dir.startsWith(`${home}.`) && /^\d+$/.test(dir.slice(home.length + 1)))
    return modules === 'node_modules' && made && name === `${app.name}.app`
  }
  const paths = [...dump.matchAll(/^path:\s+(.+?) \(0x[0-9a-f]+\)$/gm)].map((match) => match[1]!)
  return [...new Set(paths)].filter((path) => ours(path) && !exists(path))
}

/** A fingerprint of a folder's files (names and modification times), or '' if it isn't there. */
function filesOf(dir: string): string {
  if (!existsSync(dir)) return ''
  const walk = (at: string): string[] => readdirSync(at, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(at, entry.name)) : [`${join(at, entry.name)}:${statSync(join(at, entry.name)).mtimeMs}`])
  return walk(dir).sort().join('\n')
}
