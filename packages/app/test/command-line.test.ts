// Settings → Command line: the app's command put on the PATH (a script from a packaged app, a link from a checkout),
// told apart from whatever else is there, replaced and removed.
import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineApp } from '@superego/protocol'
import { commandLine, script } from '../src/main/command-line.ts'

const app = defineApp({ name: 'Test App', id: 'testapp' })
let root: string
let home: string
let appPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'command-line-'))
  home = join(root, 'home')
  appPath = join(root, "the app's")
  mkdirSync(join(appPath, 'out', 'main'), { recursive: true })
  mkdirSync(join(appPath, 'bin'), { recursive: true })
  writeFileSync(join(appPath, 'package.json'), JSON.stringify({ bin: { testapp: './bin/testapp.ts' } }))
  writeFileSync(join(appPath, 'bin/testapp.ts'), '#!/usr/bin/env node\n', { mode: 0o755 })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('from a checkout', () => {
  it('links the bin, and removes only its own link', async () => {
    const cli = commandLine({ app, appPath, packaged: false, executable: '/unused', home })
    expect(await cli.info()).toEqual({ path: join(home, '.local/bin/testapp'), kind: 'link', state: 'missing' })
    cli.install()
    expect(readlinkSync(cli.path)).toBe(join(appPath, 'bin/testapp.ts'))
    expect((await cli.info()).state).toBe('installed')
    cli.uninstall()
    expect((await cli.info()).state).toBe('missing')
  })

  it('tells something else at the path apart, leaves it on remove, and replaces it on install', async () => {
    const cli = commandLine({ app, appPath, packaged: false, executable: '/unused', home })
    mkdirSync(join(home, '.local/bin'), { recursive: true })
    writeFileSync(cli.path, '#!/bin/sh\necho mine\n')
    expect((await cli.info()).state).toBe('other')
    cli.uninstall()
    expect(readFileSync(cli.path, 'utf8')).toContain('mine')
    cli.install()
    expect(lstatSync(cli.path).isSymbolicLink()).toBe(true)
  })

  it('has nothing to offer without a bin', async () => {
    writeFileSync(join(appPath, 'package.json'), '{}')
    const cli = commandLine({ app, appPath, packaged: false, executable: '/unused', home })
    expect((await cli.info()).kind).toBeNull()
    expect(() => cli.install()).toThrow(/no bin/)
  })
})

describe('packaged', () => {
  it('writes a script that runs the built CLI on the app as Node', async () => {
    writeFileSync(join(appPath, 'out/main/cli.js'), '')
    // The app's executable, standing in: prints what it was run with.
    const executable = join(root, 'Test App')
    writeFileSync(executable, '#!/bin/sh\necho "$ELECTRON_RUN_AS_NODE" "$@"\n')
    chmodSync(executable, 0o755)
    const cli = commandLine({ app, appPath, packaged: true, executable, home })
    expect((await cli.info()).kind).toBe('script')
    cli.install()
    expect(statSync(cli.path).mode & 0o111).toBeTruthy()
    expect((await cli.info()).state).toBe('installed')
    expect(execFileSync(cli.path, ['threads', "it's"], { encoding: 'utf8' }).trim()).toBe(`1 ${join(appPath, 'out/main/cli.js')} threads it's`)
  })

  it('is out of date once the app moves', async () => {
    writeFileSync(join(appPath, 'out/main/cli.js'), '')
    commandLine({ app, appPath, packaged: true, executable: '/Applications/Old.app/Contents/MacOS/Test App', home }).install()
    const moved = commandLine({ app, appPath, packaged: true, executable: '/Applications/Test App.app/Contents/MacOS/Test App', home })
    expect((await moved.info()).state).toBe('other')
    expect(script(app, '/x', '/y')).toContain(`ELECTRON_RUN_AS_NODE=1 exec '/x' '/y' "$@"`)
  })
})

describe('translocated', () => {
  it('says so, and installs nothing that would point into the temporary copy', async () => {
    writeFileSync(join(appPath, 'out/main/cli.js'), '')
    const executable = '/private/var/folders/xy/T/AppTranslocation/1/d/Test App.app/Contents/MacOS/Test App'
    const cli = commandLine({ app, appPath, packaged: true, executable, translocated: true, home })
    expect(await cli.info()).toMatchObject({ kind: 'script', state: 'missing', translocated: true })
    expect(() => cli.install()).toThrow(/Move Test App to Applications first/)
    expect(() => lstatSync(cli.path)).toThrow()
  })
})

describe('the shell', () => {
  it("says when a login shell doesn't find it, or finds another", async () => {
    // A stand-in shell that answers `command -v` with what PATH it's given.
    const shell = join(root, 'sh')
    writeFileSync(shell, `#!/bin/sh\nexec /bin/sh -c "$2"\n`)
    chmodSync(shell, 0o755)
    const cli = commandLine({ app, appPath, packaged: false, executable: '/unused', home, shell })
    cli.install()
    const path = process.env.PATH
    try {
      process.env.PATH = `/usr/bin:/bin`
      expect((await cli.info()).shadowed).toBeNull()
      // Asked again after a change.
      process.env.PATH = `${join(home, '.local/bin')}:/usr/bin:/bin`
      cli.install()
      expect((await cli.info()).shadowed).toBeUndefined()
    } finally {
      process.env.PATH = path
    }
  })
})
