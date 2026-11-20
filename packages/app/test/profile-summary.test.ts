// A CPU profile boiled down (main/profile-summary.ts): self time by function and file, the time of each React component
// (the innermost on the stack as its own, each once as inclusive), idle left out of busy, and scripts' places short.
import { expect, it } from 'vitest'
import { shortUrl, summarizeProfile, type CpuProfile } from '../src/main/profile-summary.ts'

const frame = (functionName: string, url = '', lineNumber = 0) => ({ functionName, url, lineNumber, columnNumber: 0, scriptId: '1' })
const APP = 'http://localhost:5173/src/thread-body.tsx?t=1'
const REACT = 'http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=abc'

// root → (idle); root → workLoop (react) → ThreadBody → Transcript → parse; root → (garbage collector)
const profile: CpuProfile = {
  startTime: 0, endTime: 10_000,
  nodes: [
    { id: 1, callFrame: frame('(root)'), children: [2, 3, 7] },
    { id: 2, callFrame: frame('(idle)') },
    { id: 3, callFrame: frame('workLoop', REACT, 10), children: [4] },
    { id: 4, callFrame: frame('ThreadBody', APP, 20), children: [5] },
    { id: 5, callFrame: frame('Transcript', APP, 40), children: [6] },
    { id: 6, callFrame: frame('parse', 'http://localhost:5173/@fs/Users/me/superego/packages/ui/src/markdown.ts', 4) },
    { id: 7, callFrame: frame('(garbage collector)') },
  ],
  // Each sample lasts until the next: idle 5 ms, parse 2 ms, ThreadBody 1 ms, workLoop 1 ms, GC 1 ms.
  samples: [2, 6, 4, 3, 7],
  timeDeltas: [0, 5000, 2000, 1000, 1000],
}

it('splits the time by function, file and component', () => {
  const summary = summarizeProfile(profile)
  expect(summary).toMatchObject({ ms: 10, busyPercent: 50, gcPercent: 10 })
  expect(summary.functions[0]).toEqual({ name: 'parse', where: 'packages/ui/src/markdown.ts:5', ms: 2, percent: 20 })
  expect(summary.functions.map((f) => f.name)).not.toContain('(idle)')
  expect(summary.files.map((f) => [f.name, f.percent])).toEqual([
    ['packages/ui/src/markdown.ts', 20], ['src/thread-body.tsx', 10], ['react-dom_client.js', 10], ['(garbage collector)', 10],
  ])
  // Transcript's own: parse under it; ThreadBody's own: its frame's sample; both include parse.
  expect(summary.components.map((c) => [c.name, c.percent, c.inclusivePercent])).toEqual([['ThreadBody', 10, 30], ['Transcript', 20, 20]])
  // React's own functions are never components, though capitalised ones in it would look like them.
  expect(summary.components.every((c) => !c.where.includes('react-dom'))).toBe(true)
})

it('names scripts short', () => {
  expect(shortUrl(APP)).toBe('src/thread-body.tsx')
  expect(shortUrl(REACT)).toBe('react-dom_client.js')
  expect(shortUrl('file:///Applications/Superego.app/Contents/Resources/app.asar/out/renderer/assets/index-abc.js')).toBe('Applications/Superego.app/Contents/Resources/app.asar/out/renderer/assets/index-abc.js')
  expect(shortUrl('file:///x/node_modules/.pnpm/react-dom@19.0.0/node_modules/react-dom/cjs/react-dom.js')).toBe('react-dom/cjs/react-dom.js')
  expect(shortUrl('')).toBe('')
})
