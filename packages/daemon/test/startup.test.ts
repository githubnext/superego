import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

// What the daemon loads as it starts: sucrase (some 60 modules) only once a profile's JSX is read.
it("doesn't load sucrase as it starts", () => {
  const script = `
    import { registerHooks } from 'node:module'
    const loaded = []
    registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context) } })
    await import(${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)})
    console.log(JSON.stringify(loaded))
  `
  const loaded = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })) as string[]
  expect(loaded.length).toBeGreaterThan(50)
  expect(loaded.filter((url) => url.includes('/sucrase/'))).toEqual([])
})
