import { describe, expect, it } from 'vitest'
import { firstLine, firstSentence, lastParagraph, plainText, shorten } from '../src/index.ts'

describe('plainText', () => {
  it('reads Markdown as the text it shows: links and code as their text, no marks', () => {
    expect(plainText('Merged **the** `notices` change into [main](thread:12), see <https://x.test/a>')).toBe('Merged the notices change into main, see https://x.test/a')
    expect(plainText('# Done\n\n- [x] _one_ thing\n1. ~~two~~ three\n> quoted')).toBe('Done\n\none thing\ntwo three\nquoted')
    expect(plainText('Keep snake_case_names and 2*3*4 as they are')).toBe('Keep snake_case_names and 2*3*4 as they are')
    expect(plainText('Before\n\n```ts\nconst x = 1\n```\n\nAfter')).toBe('Before\n\n\n\nAfter')
    expect(plainText('![a chart](chart.png) drawn')).toBe('a chart drawn')
  })
})

describe('shorten', () => {
  it('leaves short text alone, on one line', () => {
    expect(shorten('  Fixed\nthe   build ')).toBe('Fixed the build')
  })

  it('cuts long text at a word, with an ellipsis, within the limit', () => {
    const long = 'Moved the notification copy to the daemon so every client gets the same recap, and tested it all'
    const cut = shorten(long, 40)
    expect(cut).toBe('Moved the notification copy to the…')
    expect(cut.length).toBeLessThanOrEqual(40)
    expect(shorten('Rewrote everything, then some more', 21)).toBe('Rewrote everything…')
    expect(shorten('x'.repeat(150)).length).toBe(100)
  })
})

describe('firstSentence', () => {
  it("is an answer's first sentence, past a heading, as plain text", () => {
    expect(firstSentence('Merged to `main`. Two tests were flaky.')).toBe('Merged to main.')
    expect(firstSentence('## Summary\n\nThe **build** passes again! More below.')).toBe('The build passes again!')
    expect(firstSentence('- Fixed the [rows](thread:3)\n- Added tests')).toBe('Fixed the rows')
    expect(firstSentence('Version 1.2 is out: see the notes')).toBe('Version 1.2 is out: see the notes')
    expect(firstSentence('```\ncode only\n```')).toBeUndefined()
    expect(firstSentence('# Only a heading')).toBe('Only a heading')
  })

  it('is shortened', () => {
    expect(firstSentence(`${'word '.repeat(40)}end.`)!.endsWith('…')).toBe(true)
  })
})

it("says a question by its last paragraph, and an error by its first line", () => {
  expect(lastParagraph('Two ways to go:\n\n- one\n- two\n\nWhich **one** should I take?')).toBe('Which one should I take?')
  expect(lastParagraph('Deploy now?')).toBe('Deploy now?')
  expect(firstLine('\n429 Too Many Requests\n{"error": "…"}')).toBe('429 Too Many Requests')
  expect(firstLine('')).toBeUndefined()
})
