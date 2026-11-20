// The colour tokens' list (tokens.ts) and their values (styles.css) in step: each listed is declared, and every colour
// declared is listed.
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { colourTokens } from '../src/tokens.ts'

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const root = css.match(/:root\s*\{([^}]*)\}/)![1]!
const declared = new Map([...root.matchAll(/(--superego-[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]))
const listed = Object.values(colourTokens).flatMap((group) => Object.keys(group))

it('declares every listed colour token', () => {
  expect(listed.filter((name) => !declared.has(name))).toEqual([])
})

it('lists every colour it declares', () => {
  const colour = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|light-dark\(|color-mix\(|color\(|\b(white|black)\b/i
  const unlisted = [...declared].filter(([name, value]) => !listed.includes(name) && colour.test(value)).map(([name]) => name)
  expect(unlisted).toEqual([])
})

it('lists each token once', () => {
  expect(new Set(listed).size).toBe(listed.length)
})
