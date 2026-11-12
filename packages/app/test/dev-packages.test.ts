import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import { linkedPackages, newPackages, packagesChange, RELOAD_PATH } from '../src/dev-packages.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** An app folder with src/main.ts importing `@demo/late`, and that package's source beside it, not yet linked. */
function app() {
  const root = mkdtempSync(join(tmpdir(), 'superego-dev-packages-'))
  dirs.push(root)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
  mkdirSync(join(root, 'node_modules/@demo'), { recursive: true })
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/main.ts'), "import late from '@demo/late'\nexport default late\n")
  mkdirSync(join(root, 'late'))
  writeFileSync(join(root, 'late/package.json'), JSON.stringify({ name: '@demo/late', type: 'module', exports: { '.': './index.js' } }))
  writeFileSync(join(root, 'late/index.js'), "export default 'late'\n")
  return root
}

const until = async (check: () => Promise<boolean>, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await check()) return true
  return false
}

describe('new packages in dev', () => {
  it('lists linked packages with scopes opened, and sees what was added', () => {
    const root = app()
    expect(linkedPackages(join(root, 'node_modules'))).toEqual([])
    symlinkSync(join(root, 'late'), join(root, 'node_modules/@demo/late'))
    expect(linkedPackages(join(root, 'node_modules'))).toEqual(['@demo/late'])
    expect(packagesChange({ linked: [], installed: 1 }, { linked: ['@demo/late'], installed: 1 })).toEqual({ added: ['@demo/late'] })
    expect(packagesChange({ linked: ['a'], installed: 1 }, { linked: ['a'], installed: 2 })).toEqual({ added: [] })
    expect(packagesChange({ linked: ['a'], installed: 1 }, { linked: ['a'], installed: 1 })).toBeNull()
  })

  it('restarts the dev server when a package is linked after it started, so its import resolves', async () => {
    const root = app()
    const server = await createServer({ root, configFile: false, logLevel: 'silent', server: { port: 0, ws: false }, optimizeDeps: { noDiscovery: true }, plugins: [newPackages(root, { every: 100 })] })
    await server.listen()
    try {
      await expect(server.transformRequest('/src/main.ts')).rejects.toThrow(/Failed to resolve import "@demo\/late"/)
      symlinkSync(join(root, 'late'), join(root, 'node_modules/@demo/late'))
      // `server` stays the same object across a restart; its resolver is a new one.
      expect(await until(() => server.transformRequest('/src/main.ts').then((r) => Boolean(r?.code.includes('late')), () => false))).toBe(true)
    } finally {
      await server.close()
    }
  }, 20_000)

  it('restarts when the window asks', async () => {
    const root = app()
    const server = await createServer({ root, configFile: false, logLevel: 'silent', server: { port: 0, ws: false }, optimizeDeps: { noDiscovery: true }, plugins: [newPackages(root, { every: 60_000 })] })
    await server.listen()
    try {
      await expect(server.transformRequest('/src/main.ts')).rejects.toThrow(/Failed to resolve import/)
      symlinkSync(join(root, 'late'), join(root, 'node_modules/@demo/late'))
      // Too soon for the poll: still cached as missing, until the window asks.
      await expect(server.transformRequest('/src/main.ts')).rejects.toThrow(/Failed to resolve import/)
      const url = server.resolvedUrls!.local[0]!.replace(/\/$/, '')
      expect((await fetch(url + RELOAD_PATH)).status).toBe(405)
      expect(await (await fetch(url + RELOAD_PATH, { method: 'POST' })).text()).toBe('restarting')
      expect(await until(() => server.transformRequest('/src/main.ts').then((r) => Boolean(r?.code.includes('late')), () => false))).toBe(true)
    } finally {
      await server.close()
    }
  }, 20_000)
})
