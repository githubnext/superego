// Packaging the app: `<name>.app` and a zip in the app's dist/. Run after `electron-vite build`.
//
// The build bundles everything into out/ (native modules beside it, in out/node_modules, unpacked from the archive),
// so the app ships only out/, resources/ and a package.json with no dependencies: it's staged in dist/app and electron-builder packs that (never the workspace's node_modules), on the
// Electron already installed (nothing is downloaded). electron-builder runs through npx, outside the workspace, so its
// own dependencies stay out of the lockfile. The daemon runs from inside the bundle, on the app's own Electron as Node.
//
// The icon: an Icon Composer document, resources/<id>.icon, is compiled with actool into an Assets.car that
// electron-builder copies into the bundle, named by CFBundleIconName, so macOS draws its light, dark, tinted and clear
// variants itself. resources/icon.icns is the fallback older macOS shows.
//
// Signing: with an identity ("Developer ID Application: …"), electron-builder signs every nested piece of code, inside
// out, with the hardened runtime and the entitlements Electron needs (its JIT, and the daemon on it as Node). Without
// one, the bundle is signed ad hoc, for this computer. Notarizing (which needs an identity) submits the signed app to
// Apple, waits for it, and staples the ticket into the bundle before it's zipped, so it opens offline too.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AppConfig } from '@superego/protocol'

/** How notarytool signs in: a profile it stored in the keychain (`notarytool store-credentials`), or an API key. */
export type NotaryAuth = { profile: string } | { key: string; keyId: string; issuer: string }

export type PackageOptions = {
  /** Reverse-DNS bundle id; defaults to `dev.superego.<id>`. */
  bundleId?: string
  /** Code signing identity ("Developer ID Application: …"); unset signs ad hoc, for this computer. */
  identity?: string | null
  /** Notarize and staple the signed app; needs `identity`. */
  notarize?: NotaryAuth | null
  /** The version the app says it is (and its zip is named by); defaults to the package.json's. */
  version?: string
  /** Where the app looks for updates (a release's build: the app config's `updateFeed`); unset, it never updates itself. */
  updateFeed?: string
}

const BUILDER = 'electron-builder@26'

/**
 * Electron's V8 writes executable memory, in the app and in the daemon it runs as Node; and a page in a Browser pane may use
 * the camera and microphone once the user allows it (and macOS does: the hardened runtime refuses them without these).
 */
const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.device.camera</key><true/>
  <key>com.apple.security.device.audio-input</key><true/>
</dict></plist>
`

/** What macOS says as it first asks to let the app use the camera or microphone: for a site the user allowed in a Browser pane. */
const USAGE = {
  NSCameraUsageDescription: 'So a site you allow in a Browser pane can use the camera.',
  NSMicrophoneUsageDescription: 'So a site you allow in a Browser pane can use the microphone.',
}

export async function packageApp(root: string, app: AppConfig, options: PackageOptions = {}): Promise<string[]> {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string; description?: string }
  if (!existsSync(join(root, 'out/main/main.js'))) throw new Error('Nothing built: run electron-vite build first')
  if (options.notarize && !options.identity) throw new Error('Notarizing needs a signing identity')
  const version = options.version ?? pkg.version ?? '0.0.0'

  // Stage: what the app is, and nothing else.
  const stage = join(root, 'dist/app')
  const output = join(root, 'dist')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  cpSync(join(root, 'out'), join(stage, 'out'), { recursive: true })
  if (existsSync(join(root, 'resources'))) cpSync(join(root, 'resources'), join(stage, 'resources'), { recursive: true, filter: (path) => !path.endsWith('.icon') && !path.includes('.icon/') })
  writeFileSync(join(stage, 'package.json'), JSON.stringify({
    name: app.id, productName: app.name, version, description: pkg.description ?? app.name, main: 'out/main/main.js', type: 'module',
    ...(options.updateFeed ? { updateFeed: options.updateFeed } : {}),
  }, null, 2))
  const entitlements = join(stage, 'entitlements.plist')
  writeFileSync(entitlements, ENTITLEMENTS)

  // The .icon, compiled for electron-builder to copy in, so it's inside what gets signed.
  const iconDoc = join(root, 'resources', `${app.id}.icon`)
  const icons = join(stage, 'icon')
  if (existsSync(iconDoc)) {
    mkdirSync(icons)
    compileIcon(iconDoc, icons, app.id)
  }

  // The Electron this app runs on, as installed: its version and its unpacked dist.
  const electron = dirname(createRequire(join(root, 'package.json')).resolve('electron/package.json'))
  const electronVersion = (JSON.parse(readFileSync(join(electron, 'package.json'), 'utf8')) as { version: string }).version
  // Electron fetches its binary when first run, which a fresh install (a release's own worktree) hasn't been yet.
  if (!existsSync(join(electron, 'dist'))) execFileSync('node', ['install.js'], { cwd: electron, stdio: 'inherit' })
  const config = {
    appId: options.bundleId ?? app.bundleId ?? `dev.superego.${app.id}`,
    productName: app.name,
    electronVersion,
    electronDist: join(electron, 'dist'),
    directories: { output, buildResources: join(stage, 'resources') },
    // The author types (out/types) and TypeScript's compiler with its lib.*.d.ts (out/node_modules/@typescript) on
    // their own: electron-builder leaves every *.d.ts out of the app's files, but not out of a set of files from
    // elsewhere. A set's walk skips any node_modules it meets, so the compiler's starts inside.
    files: [
      'out/**', '!out/types{,/**}', '!out/node_modules/@typescript{,/**}', 'resources/**', 'package.json',
      { from: 'out', to: 'out', filter: ['types/**'] },
      { from: 'out/node_modules/@typescript', to: 'out/node_modules/@typescript', filter: ['**/*'] },
    ],
    asar: true,
    // Native modules (copied into out/node_modules by the build) are loaded from the disk, not the archive; the skill
    // (out/skill) is read there by agents, whose shells can't read the archive.
    asarUnpack: ['out/node_modules/**', 'out/skill/**'],
    npmRebuild: false,
    mac: {
      target: ['dir'],
      category: 'public.app-category.developer-tools',
      ...(existsSync(join(root, 'resources/icon.icns')) ? { icon: join(root, 'resources/icon.icns') } : {}),
      extendInfo: { ...USAGE, ...(existsSync(icons) ? { CFBundleIconName: app.id } : {}) },
      ...(existsSync(icons) ? { extraResources: [{ from: icons, to: '.' }] } : {}),
      ...(options.identity
        ? { identity: builderIdentity(options.identity), hardenedRuntime: true, gatekeeperAssess: false, entitlements, entitlementsInherit: entitlements, notarize: false }
        : { identity: null }),
    },
  }
  writeFileSync(join(stage, 'electron-builder.json'), JSON.stringify(config, null, 2))
  execFileSync('npx', ['--yes', BUILDER, '--mac', '--projectDir', stage, '--config', join(stage, 'electron-builder.json')], {
    stdio: 'inherit',
    // Only the identity given: no certificate electron-builder might otherwise find in the environment.
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  })

  // electron-builder names the folder by architecture (mac-arm64, mac): find the bundle it made.
  const folder = readdirSync(output).map((name) => join(output, name)).find((path) => existsSync(join(path, `${app.name}.app`)))
  if (!folder) throw new Error(`No ${app.name}.app in ${output}`)
  const bundle = join(folder, `${app.name}.app`)

  // Unsigned, Electron's own ad hoc signature no longer matches what was changed around it: sign it again.
  if (!options.identity) execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' })
  if (options.notarize) notarize(bundle, options.notarize)

  const zip = join(output, `${app.name}-${version}-${folder.split('-').at(-1)}.zip`)
  rmSync(zip, { force: true })
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, zip])
  return [bundle, zip]
}

/**
 * The feed Squirrel.Mac reads (`serverType: 'json'`): the newest release, and where its zip is. The app updates when
 * `currentRelease` isn't its own version (CFBundleVersion, which is the version), and shows `name` as the version ready.
 */
export function updateFeedJson({ version, zipUrl, notes, date = new Date() }: { version: string; zipUrl: string; notes: string; date?: Date }): string {
  const updateTo = { version, pub_date: date.toISOString(), notes, name: version, url: zipUrl }
  return `${JSON.stringify({ currentRelease: version, releases: [{ version, updateTo }] }, null, 2)}\n`
}

/** electron-builder takes a Developer ID by the name after its kind ("Name (TEAM)"), and picks the kind itself. */
function builderIdentity(identity: string): string {
  return identity.replace(/^Developer ID Application:\s*/, '')
}

/** Submit a signed bundle to Apple's notary service, wait for its verdict, and staple the ticket into the bundle. */
export function notarize(bundle: string, auth: NotaryAuth) {
  const credentials = 'profile' in auth
    ? ['--keychain-profile', auth.profile]
    : ['--key', auth.key, '--key-id', auth.keyId, '--issuer', auth.issuer]
  const work = mkdtempSync(join(tmpdir(), 'superego-notary-'))
  try {
    const upload = join(work, 'upload.zip')
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, upload])
    console.log('Notarizing… (this usually takes a few minutes)')
    const result = JSON.parse(execFileSync('xcrun', ['notarytool', 'submit', upload, '--wait', '--output-format', 'json', ...credentials], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    })) as { id: string; status: string }
    if (result.status !== 'Accepted') {
      const log = execFileSync('xcrun', ['notarytool', 'log', result.id, ...credentials], { encoding: 'utf8' })
      throw new Error(`Notarization ${result.status} (${result.id}):\n${log}`)
    }
    execFileSync('xcrun', ['stapler', 'staple', bundle], { stdio: 'inherit' })
    execFileSync('spctl', ['--assess', '--type', 'execute', '-vv', bundle], { stdio: 'inherit' })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
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
