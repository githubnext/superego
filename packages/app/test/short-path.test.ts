// How a thread's file is named in the editor's bar: by its path in the thread's folder, or whole when it's elsewhere.
import { expect, it } from 'vitest'
import { filePath } from '../src/renderer/short-path.ts'

it('shows a file in the thread’s folder by its path there, and one elsewhere whole, home as ~', () => {
  expect(filePath('/Users/me/dev/x', 'docs/a.md')).toBe('docs/a.md')
  expect(filePath('/Users/me/dev/x', '/Users/me/dev/x/docs/a.md')).toBe('docs/a.md')
  expect(filePath('/Users/me/dev/x', '/Users/me/.superego/draft.md')).toBe('~/.superego/draft.md')
  expect(filePath('/Users/me/dev/x', '/Users/me/dev/xy/a.md')).toBe('~/dev/xy/a.md')
  expect(filePath('/home/me/x', '/etc/hosts')).toBe('/etc/hosts')
  expect(filePath('/home/me/x', '~/notes.md')).toBe('~/notes.md')
})
