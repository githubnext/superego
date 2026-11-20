// An html block's frame (frame.html) keeps the page off the network: its policy lets nothing load from outside, and the
// page is put in a frame of its own beneath it, so going anywhere is a navigation that policy refuses too. A browser is
// what enforces it; this holds the page to what it relies on.
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const page = readFileSync(new URL('../src/renderer/blocks/frame.html', import.meta.url), 'utf8')
const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/i.exec(page)?.[1]
const directives = new Map((policy ?? '').split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([name, ...sources]) => [name!, sources]))

it('has a policy of its own, ahead of anything it loads', () => {
  expect(policy).toBeDefined()
  expect(page.indexOf('Content-Security-Policy')).toBeLessThan(page.indexOf('<script'))
})

it('lets the page load nothing from outside itself', () => {
  expect(directives.get('default-src')).toEqual(["'none'"])
  for (const [name, sources] of directives) {
    // Only what's in the page: inline, data: and blob:. No scheme or host to reach, no 'self' (the window's origin).
    for (const source of sources) expect(["'none'", "'unsafe-inline'", 'data:', 'blob:'], `${name} ${source}`).toContain(source)
  }
  // Not left to default-src: these don't fall back to it.
  expect(directives.get('form-action')).toEqual(["'none'"])
})

it("puts the page in a sandboxed frame of its own, whose navigations its frame-src refuses", () => {
  expect(directives.get('frame-src')).toEqual(["'none'"])
  expect(page).toMatch(/\.srcdoc\s*=/)
  expect(page).toMatch(/setAttribute\('sandbox', 'allow-scripts'\)/)
  // Written into this page, a page could navigate it, and take what it knows along in the address.
  expect(page).not.toMatch(/document\.write\(/)
})
