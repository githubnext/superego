import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildStamp, bundleSources, BUILD_EVENT, BUILD_MODULE, hashSources } from '../src/main-build.ts'
import { buildsDiffer, readMainBuild } from '../src/main/build.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'superego-main-build-')); dirs.push(dir); return dir }

const chunk = (name: string, moduleIds: string[], { isEntry = false, imports = [] as string[], dynamicImports = [] as string[] } = {}) =>
  ({ type: 'chunk' as const, name, isEntry, imports, dynamicImports, moduleIds })

/** A plugin hook, called as Vite would (each is a plain function here). */
const hook = (plugin: object, name: string) => (plugin as Record<string, (...args: unknown[]) => unknown>)[name]!.bind({})

describe('bundleSources', () => {
  it("follows an entry's chunks, and keeps the workspace's own files", () => {
    const bundle = {
      'main.js': chunk('main', ['/w/app/src/main.ts', '\0virtual', '/w/node_modules/react/index.js'], { isEntry: true, imports: ['shared.js'], dynamicImports: ['lazy.js'] }),
      'shared.js': chunk('shared', ['/w/packages/protocol/src/index.ts?raw']),
      'lazy.js': chunk('lazy', ['/w/packages/app/src/main/lazy.ts']),
      'daemon.js': chunk('daemon', ['/w/packages/daemon/src/serve.ts'], { isEntry: true, imports: ['shared.js'] }),
      'icon.png': { type: 'asset' as const },
    }
    expect(bundleSources(bundle, 'main')).toEqual(['/w/app/src/main.ts', '/w/packages/app/src/main/lazy.ts', '/w/packages/protocol/src/index.ts'])
    expect(bundleSources(bundle)).toContain('/w/packages/daemon/src/serve.ts')
  })
})

describe('the window against the main process', () => {
  /** Main and preload built from two files into `out`, as electron-vite builds them: the stamp, and the window's module. */
  function built() {
    const dir = tmp()
    const [main, preload] = [join(dir, 'main.ts'), join(dir, 'preload.ts')]
    writeFileSync(main, 'export const a = 1\n')
    writeFileSync(preload, 'export const b = 1\n')
    const out = join(dir, 'out')
    mkdirSync(join(out, 'main'), { recursive: true })
    mkdirSync(join(out, 'preload'))
    const stamp = buildStamp()
    hook(stamp.main, 'generateBundle')({}, { 'main.js': chunk('main', [main], { isEntry: true }) })
    hook(stamp.preload, 'generateBundle')({}, { 'preload.js': chunk('preload', [preload], { isEntry: true }) })
    hook(stamp.preload, 'writeBundle')({ dir: join(out, 'preload') })
    hook(stamp.renderer, 'configResolved')({ command: 'build' })
    const windowBuild = () => {
      const code = hook(stamp.renderer, 'load')(BUILD_MODULE) as string
      return JSON.parse(/export const build = (.*)\n/.exec(code)![1]!) as string
    }
    return { main, preload, out, windowBuild }
  }

  it('agree when built together, and differ once a source of the main process or its preload changes', () => {
    const { main, preload, out, windowBuild } = built()
    const mainBuild = readMainBuild(join(out, 'main'))
    expect(mainBuild).toBe(hashSources([main, preload]))
    expect(buildsDiffer(windowBuild(), mainBuild)).toBe(false)

    writeFileSync(preload, 'export const b = 2\n')
    expect(buildsDiffer(windowBuild(), mainBuild)).toBe(true)
    writeFileSync(preload, 'export const b = 1\n')
    expect(buildsDiffer(windowBuild(), mainBuild)).toBe(false)
    rmSync(main)
    expect(buildsDiffer(windowBuild(), mainBuild)).toBe(true)
  })

  it("never differ while either is unknown: a packaged app's main process, a window without a main build", () => {
    expect(buildsDiffer(undefined, 'abc')).toBe(false)
    expect(buildsDiffer('abc', undefined)).toBe(false)
    expect(buildsDiffer('abc', 'abd')).toBe(true)
    const stamp = buildStamp()
    hook(stamp.renderer, 'configResolved')({ command: 'serve' })
    const code = hook(stamp.renderer, 'load')(BUILD_MODULE) as string
    expect(code).toContain('export const build = undefined')
    expect(code).toContain('import.meta.hot')
  })

  it("doesn't look in a packaged app", () => {
    const error = vi.spyOn(console, 'error')
    expect(readMainBuild('/Applications/Superego.app/Contents/Resources/app.asar/out/main')).toBeUndefined()
    expect(error).not.toHaveBeenCalled()
  })

  it("says so when the main process's stamp is missing", () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(readMainBuild(tmp())).toBeUndefined()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('build.json'))
  })

  it('writes the stamp next to the main process', () => {
    const { out } = built()
    expect(JSON.parse(readFileSync(join(out, 'main/build.json'), 'utf8'))).toEqual({ build: expect.stringMatching(/^[0-9a-f]{12}$/) })
  })
})

describe('in dev', () => {
  it("tells the window as soon as the main process's sources change, and gives a reload the new build", async () => {
    const dir = tmp()
    const main = join(dir, 'main.ts')
    writeFileSync(main, 'export const a = 1\n')
    mkdirSync(join(dir, 'out/main'), { recursive: true })
    mkdirSync(join(dir, 'out/preload'))
    const stamp = buildStamp()
    hook(stamp.main, 'generateBundle')({}, { 'main.js': chunk('main', [main], { isEntry: true }) })
    hook(stamp.preload, 'generateBundle')({}, {})
    hook(stamp.preload, 'writeBundle')({ dir: join(dir, 'out/preload') })
    const server = await createServer({ root: dir, logLevel: 'silent', configFile: false, server: { port: 0, ws: false }, plugins: [stamp.renderer] })
    try {
      const loaded = async () => /export const build = "(\w+)"/.exec((await server.transformRequest(BUILD_MODULE))!.code)?.[1]
      const before = await loaded()
      expect(before).toBe(readMainBuild(join(dir, 'out/main')))
      const told = new Promise<unknown>((resolve) => { server.ws.send = ((payload: unknown) => resolve(payload)) as never })
      writeFileSync(main, 'export const a = 2\n')
      const after = hashSources([main])
      expect(await told).toEqual({ type: 'custom', event: BUILD_EVENT, data: { build: after } })
      expect(await loaded()).toBe(after)
    } finally { await server.close() }
  })
})
