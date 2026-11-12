import { expect, it } from 'vitest'
import { filter, newestFirst, short, type Link } from '../src/links.ts'

const link = (text: string, target: string, kind: Link['kind'] = 'web'): Link => ({ text, target, kind, open() {} })

it('lists the newest first, each place once', () => {
  const list = newestFirst([link('docs', 'https://a.dev'), link('plan', 'notes/plan.md', 'file'), link('the docs again', 'https://a.dev')])
  expect(list.map((l) => l.text)).toEqual(['the docs again', 'plan'])
})

it('narrows by what a link says or where it goes, best first, keeping order on ties', () => {
  const list = [link('Pull request', 'https://github.com/x/y/pull/4'), link('plan', 'notes/plan.md', 'file'), link('Preview', 'http://localhost:5173')]
  expect(filter(list, '').map((l) => l.text)).toEqual(['Pull request', 'plan', 'Preview'])
  expect(filter(list, 'pr').map((l) => l.text)).toEqual(['Preview', 'Pull request'])
  expect(filter(list, 'localhost').map((l) => l.text)).toEqual(['Preview'])
  expect(filter(list, 'zzz')).toEqual([])
})

it('shows web addresses without their scheme', () => {
  expect(short('https://www.example.com/a/')).toBe('example.com/a')
})
