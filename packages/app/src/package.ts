// Packaging an app on mu: `<app>.app` (and a zip) in the app's dist/. Run after `electron-vite build`.
//
// The build bundles everything into out/, so the app ships only out/, resources/ and a package.json with no
// dependencies: it's staged in dist/app and electron-builder packs that (never the workspace's node_modules). The daemon
// runs from inside the bundle, on the app's own Electron as Node.
//
// The icon: an Icon Composer document, resources/<id>.icon, is compiled with actool into the bundle's Assets.car and
// named by CFBundleIconName, so macOS draws its light, dark, tinted and clear variants itself. resources/icon.icns is the
// fallback older macOS shows.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AppConfig } from '@mu/protocol'

export type PackageOptions = {
  /** Reverse-DNS bundle id; defaults to `dev.mu.<id>`. */
  bundleId?: string
  /** Code signing identity ("Developer ID Application: …"); unset signs ad hoc, for this computer. */
  identity?: string | null
}

export async function packageApp(root: string, app: AppConfig, options: PackageOptions = {}) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string; description?: string; devDependencies?: Record<string, string> }
  if (!existsSync(join(root, 'out/main/main.js'))) throw new Error('Nothing built: run electron-vite build first')

  // Stage: what the app is, and nothing else.
  const stage = join(root, 'dist/app')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  cpSync(join(root, 'out'), join(stage, 'out'), { recursive: true })
  if (existsSync(join(root, 'resources'))) cpSync(join(root, 'resources'), join(stage, 'resources'), { recursive: true, filter: (path) => !path.endsWith('.icon') && !path.includes('.icon/') })
  writeFileSync(join(stage, 'package.json'), JSON.stringify({
    name: app.id, productName: app.name, version: pkg.version ?? '0.0.0', description: pkg.description ?? app.name, main: 'out/main/main.js', type: 'module',
  }, null, 2))

  const iconDoc = join(root, 'resources', `${app.id}.icon`)
  const { build } = await import('electron-builder' as string) as { build(options: unknown): Promise<string[]> }
  const electronVersion = (pkg.devDependencies?.electron ?? '').replace(/^[^\d]*/, '')
  return build({
    projectDir: stage,
    config: {
      appId: options.bundleId ?? `dev.mu.${app.id}`,
      productName: app.name,
      ...(electronVersion ? { electronVersion } : {}),
      directories: { output: resolve(root, 'dist'), buildResources: join(stage, 'resources') },
      files: ['out/**', 'resources/**', 'package.json'],
      asar: true,
      npmRebuild: false,
      mac: {
        target: ['dir', 'zip'],
        category: 'public.app-category.developer-tools',
        ...(existsSync(join(root, 'resources/icon.icns')) ? { icon: join(root, 'resources/icon.icns') } : {}),
        identity: options.identity ?? null,
        hardenedRuntime: options.identity ? true : false,
      },
      // The .icon, compiled into the bundle before it is signed.
      afterPack: async (context: { appOutDir: string; packager: { appInfo: { productFilename: string } }; electronPlatformName: string }) => {
        if (context.electronPlatformName !== 'darwin' || !existsSync(iconDoc)) return
        const contents = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents')
        compileIcon(iconDoc, join(contents, 'Resources'), app.id)
        execFileSync('plutil', ['-replace', 'CFBundleIconName', '-string', app.id, join(contents, 'Info.plist')])
      },
    },
  })
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
