// Packaging the app: `<name>.app` and a zip in the app's dist/. Run after `electron-vite build`.
//
// The build bundles everything into out/, so the app ships only out/, resources/ and a package.json with no
// dependencies: it's staged in dist/app and electron-builder packs that (never the workspace's node_modules), on the
// Electron already installed (nothing is downloaded). electron-builder runs through npx, outside the workspace, so its
// own dependencies stay out of the lockfile. The daemon runs from inside the bundle, on the app's own Electron as Node.
//
// The icon: an Icon Composer document, resources/<id>.icon, is compiled with actool into the bundle's Assets.car and
// named by CFBundleIconName, so macOS draws its light, dark, tinted and clear variants itself. resources/icon.icns is the
// fallback older macOS shows. The bundle is then signed again (ad hoc unless an identity is given) and zipped.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { AppConfig } from '@mu/protocol'

export type PackageOptions = {
  /** Reverse-DNS bundle id; defaults to `dev.mu.<id>`. */
  bundleId?: string
  /** Code signing identity ("Developer ID Application: …"); unset signs ad hoc, for this computer. */
  identity?: string | null
}

const BUILDER = 'electron-builder@26'

export async function packageApp(root: string, app: AppConfig, options: PackageOptions = {}): Promise<string[]> {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string; description?: string }
  if (!existsSync(join(root, 'out/main/main.js'))) throw new Error('Nothing built: run electron-vite build first')

  // Stage: what the app is, and nothing else.
  const stage = join(root, 'dist/app')
  const output = join(root, 'dist')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  cpSync(join(root, 'out'), join(stage, 'out'), { recursive: true })
  if (existsSync(join(root, 'resources'))) cpSync(join(root, 'resources'), join(stage, 'resources'), { recursive: true, filter: (path) => !path.endsWith('.icon') && !path.includes('.icon/') })
  writeFileSync(join(stage, 'package.json'), JSON.stringify({
    name: app.id, productName: app.name, version: pkg.version ?? '0.0.0', description: pkg.description ?? app.name, main: 'out/main/main.js', type: 'module',
  }, null, 2))

  // The Electron this app runs on, as installed: its version and its unpacked dist.
  const electron = dirname(createRequire(join(root, 'package.json')).resolve('electron/package.json'))
  const electronVersion = (JSON.parse(readFileSync(join(electron, 'package.json'), 'utf8')) as { version: string }).version
  const config = {
    appId: options.bundleId ?? `dev.mu.${app.id}`,
    productName: app.name,
    electronVersion,
    electronDist: join(electron, 'dist'),
    directories: { output, buildResources: join(stage, 'resources') },
    files: ['out/**', 'resources/**', 'package.json'],
    asar: true,
    npmRebuild: false,
    mac: {
      target: ['dir'],
      category: 'public.app-category.developer-tools',
      ...(existsSync(join(root, 'resources/icon.icns')) ? { icon: join(root, 'resources/icon.icns') } : {}),
      identity: null,
    },
  }
  writeFileSync(join(stage, 'electron-builder.json'), JSON.stringify(config, null, 2))
  execFileSync('npx', ['--yes', BUILDER, '--mac', '--projectDir', stage, '--config', join(stage, 'electron-builder.json')], { stdio: 'inherit' })

  // electron-builder names the folder by architecture (mac-arm64, mac): find the bundle it made.
  const folder = readdirSync(output).map((name) => join(output, name)).find((path) => existsSync(join(path, `${app.name}.app`)))
  if (!folder) throw new Error(`No ${app.name}.app in ${output}`)
  const bundle = join(folder, `${app.name}.app`)

  // The .icon, compiled into the bundle, then a fresh signature over the result.
  const iconDoc = join(root, 'resources', `${app.id}.icon`)
  if (existsSync(iconDoc)) {
    compileIcon(iconDoc, join(bundle, 'Contents/Resources'), app.id)
    execFileSync('plutil', ['-replace', 'CFBundleIconName', '-string', app.id, join(bundle, 'Contents/Info.plist')])
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', options.identity ?? '-', ...(options.identity ? ['--options', 'runtime'] : []), bundle], { stdio: 'inherit' })
  const zip = join(output, `${app.name}-${pkg.version ?? '0.0.0'}-${folder.split('-').at(-1)}.zip`)
  rmSync(zip, { force: true })
  execFileSync('ditto', ['-c', '-k', '--keepParent', bundle, zip])
  return [bundle, zip]
}

/** `<name>.icon` → Assets.car (and <name>.icns) in `into`, as Xcode would. */
export function compileIcon(iconDoc: string, into: string, name: string) {
  const partial = join(into, '.icon-partial.plist')
  execFileSync('xcrun', [
    'actool', iconDoc, '--compile', into, '--app-icon', name, '--enable-on-demand-resources', 'NO', '--development-region', 'en',
    '--target-device', 'mac', '--platform', 'macosx', '--minimum-deployment-target', '26.0', '--output-partial-info-plist', partial,
  ], { stdio: 'pipe' })
  rmSync(partial, { force: true })
}

