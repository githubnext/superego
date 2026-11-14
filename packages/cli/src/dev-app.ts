// The app as macOS sees it while it runs from source. Run on the stock Electron.app, it would be "Electron" in the menu
// bar, the Dock, ⌘-Tab, notifications and Activity Monitor: macOS names an app by its bundle, not by anything the app
// says. So this makes a copy of Electron.app named for the app (an APFS clone, instantly and without the disk space),
// with the app's name, bundle id (`<bundleId>.dev`, so it is never taken for an installed copy) and icon (the
// `<id>.icon` compiled in, so its light, dark, tinted and clear variants too), its helpers renamed to match, signed again
// ad hoc. It is remade when Electron, the app's name, id or icon change. Elsewhere than macOS: Electron as it is.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { AppConfig } from '@superego/protocol'

/** The executable to run the app at `appDir` with: its own development bundle on macOS, else Electron's. */
export function devApp(appDir: string, app: AppConfig): string {
  const electron = createRequire(join(appDir, 'package.json'))('electron') as string
  if (process.platform !== 'darwin') return electron
  const source = join(dirname(dirname(dirname(electron))))
  if (!source.endsWith('.app')) return electron
  const bundleId = `${app.bundleId ?? `dev.superego.${app.id}`}.dev`
  const icon = join(appDir, 'resources', `${app.id}.icon`)
  const icns = join(appDir, 'resources', 'icon.icns')
  const home = join(appDir, 'node_modules', `.${app.id}-dev`)
  const executable = join(home, `${app.name}.app`, 'Contents', 'MacOS', app.name)
  const stamp = createHash('sha256').update(JSON.stringify([
    electron, statSync(electron).mtimeMs, app.name, bundleId, filesOf(icon), existsSync(icns) ? statSync(icns).mtimeMs : 0,
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

/** A fingerprint of a folder's files (names and modification times), or '' if it isn't there. */
function filesOf(dir: string): string {
  if (!existsSync(dir)) return ''
  const walk = (at: string): string[] => readdirSync(at, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(at, entry.name)) : [`${join(at, entry.name)}:${statSync(join(at, entry.name)).mtimeMs}`])
  return walk(dir).sort().join('\n')
}
