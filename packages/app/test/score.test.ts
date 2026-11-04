import { expect, it } from 'vitest'
import { score } from '../src/renderer/score.ts'

it('ranks a prefix over a word start over a substring over letters in order', () => {
  const titles = ['Add a git diff extension', 'Why does the smoke test flake on fonts?', 'Refactor the settings registry', 'Settings']
  const ranked = (query: string) => titles.map((t) => [t, score(t, query)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([t]) => t)
  expect(ranked('set')).toEqual(['Settings', 'Refactor the settings registry'])
  expect(ranked('smoke')).toEqual(['Why does the smoke test flake on fonts?'])
  expect(ranked('gde')).toEqual(['Add a git diff extension'])
  expect(ranked('wdts')).toEqual(['Why does the smoke test flake on fonts?'])
  expect(ranked('zzz')).toEqual([])
  expect(score('anything', '  ')).toBe(1)
  // Special characters are matched literally, not as patterns.
  expect(score('a (b)', '(b')).toBe(2)
  expect(score('a.b', '.*')).toBe(0)
})
