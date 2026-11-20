import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defineApp } from '@superego/protocol'
import { devBundleId, devLauncher, staleDevBundles } from '../src/dev-app.ts'

const app = defineApp({ name: 'Superego', id: 'superego', bundleId: 'com.example.superego' })
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'superego-dev-app-')))

describe('devBundleId', () => {
  it("is the app's id, .dev and a hash of the checkout, the same each time", () => {
    const dir = temp()
    expect(devBundleId(dir, app)).toMatch(/^com\.example\.superego\.dev\.[0-9a-f]{10}$/)
    expect(devBundleId(dir, app)).toBe(devBundleId(join(dir, '.'), app))
  })

  it('differs between checkouts', () => {
    expect(devBundleId(temp(), app)).not.toBe(devBundleId(temp(), app))
  })

  it("is a checkout's own, whatever path it is reached by", () => {
    const dir = temp()
    const link = join(temp(), 'link')
    symlinkSync(dir, link)
    expect(devBundleId(link, app)).toBe(devBundleId(dir, app))
  })

  it('makes one up from the app id without a bundle id', () => {
    expect(devBundleId(temp(), defineApp({ name: 'Mine', id: 'mine' }))).toMatch(/^dev\.superego\.mine\.dev\.[0-9a-f]{10}$/)
  })
})

describe('devLauncher', () => {
  // The bundle's Resources: the launcher in app/, and a stand-in for Electron's default app that says what it was given.
  const resources = temp()
  mkdirSync(join(resources, 'app'))
  writeFileSync(join(resources, 'app', 'main.js'), devLauncher('/checkout/app'))
  mkdirSync(join(resources, 'default_app.asar'))
  writeFileSync(join(resources, 'default_app.asar', 'main.js'), 'console.log(JSON.stringify(process.argv.slice(1)))\n')
  // Electron's argv has the arguments from [1]; Node's has the script there.
  const electronArgv = 'data:text/javascript,process.argv.splice(1,1)'
  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ['--import', electronArgv, join(resources, 'app', 'main.js'), ...args], {
    encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  })) as string[]

  it("runs the checkout's app when started with nothing to run, as macOS starts it", () => {
    expect(run()).toEqual(['/checkout/app'])
    expect(run('--inspect')).toEqual(['/checkout/app', '--inspect'])
  })

  it('runs the app it is given, as Electron would', () => {
    expect(run('.', '--watch')).toEqual(['.', '--watch'])
    expect(run('/elsewhere/app', '--superego-open=local/t1')).toEqual(['/elsewhere/app', '--superego-open=local/t1'])
    expect(run('--app=/elsewhere/app')).toEqual(['--app=/elsewhere/app'])
  })
})

describe('staleDevBundles', () => {
  const entry = (path: string) => `bundle id:   Superego (0x1)\npath:                       ${path} (0x3d14)\nidentifier:  com.example.superego.dev\n`
  const dump = [
    entry('/gone/app/node_modules/.superego-dev/Superego.app'),
    entry('/gone/app/node_modules/.superego-dev/Superego.app'),
    entry('/here/app/node_modules/.superego-dev/Superego.app'),
    entry('/cut-short/app/node_modules/.superego-dev.4242/Superego.app'),
    entry('/Applications/Superego.app'),
    entry('/other/node_modules/.other-dev/Other.app'),
    entry('/gone/app/node_modules/.superego-dev/Superego.app/Contents/Frameworks/Superego Helper.app'),
  ].join('-'.repeat(80) + '\n')

  it("picks the app's development bundles that are gone, once each", () => {
    expect(staleDevBundles(dump, app, (path) => path.startsWith('/here/'))).toEqual([
      '/gone/app/node_modules/.superego-dev/Superego.app',
      '/cut-short/app/node_modules/.superego-dev.4242/Superego.app',
    ])
  })
})
