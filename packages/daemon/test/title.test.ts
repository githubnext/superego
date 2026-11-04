import { expect, it } from 'vitest'
import { titleOf } from '../src/daemon.ts'

it('titles a session with its first sentence, cut at a word when long', () => {
  expect(titleOf('Why does the smoke test flake on fonts? It failed once right after a build.')).toBe('Why does the smoke test flake on fonts?')
  expect(titleOf('  fix\n the   build  ')).toBe('fix the build')
  expect(titleOf('Refactor the settings registry so that fonts, colours and spacing all come from one place and every extension')).toBe('Refactor the settings registry so that fonts, colours and spacing all…')
  expect(titleOf('v1.2 is out. Ship it')).toBe('v1.2 is out.')
})
