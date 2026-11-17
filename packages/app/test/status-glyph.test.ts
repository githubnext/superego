// The one mark and word for a thread's status (@superego/ui's StatusGlyph, StatusWord), as every place draws it: a
// shape for each state, so none is told apart by colour alone, and a quiet thread's finished run not shown as unread.
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { Status } from '@superego/protocol'
import { Glyph, StatusGlyph, StatusWord } from '@superego/ui'

const glyph = (status: Status, quiet = false) => renderToStaticMarkup(h(StatusGlyph, { status, quiet }))
const word = (status: Status, quiet = false) => renderToStaticMarkup(h(StatusWord, { status, quiet }))
/** What's drawn, without the label: the shape alone. */
const shape = (html: string) => html.replace(/ (class|aria-label|role|title)="[^"]*"/g, '')

it('draws each state in a shape of its own, named for screen readers', () => {
  const states: Status[] = [
    { state: 'idle' }, { state: 'working' }, { state: 'done' }, { state: 'blocked', kind: 'question' },
    { state: 'blocked', kind: 'auth' }, { state: 'error' },
  ]
  const drawn = states.map((s) => shape(glyph(s)))
  expect(new Set(drawn).size).toBe(states.length)
  expect(glyph({ state: 'blocked', kind: 'permission' })).toContain('superego-status--permission')
  expect(glyph({ state: 'blocked', kind: 'permission' })).toContain('aria-label="Permission"')
  expect(glyph({ state: 'error', msg: 'Out of credits' })).toContain('aria-label="Failed: Out of credits"')
  expect(glyph({ state: 'working' })).toContain('superego-glyph__wave')
})

it("draws a quiet thread's work grey and its finished run as nothing new", () => {
  expect(glyph({ state: 'working' }, true)).toContain('is-quiet')
  expect(shape(glyph({ state: 'done' }, true))).toBe(shape(glyph({ state: 'idle' })))
  expect(glyph({ state: 'blocked', kind: 'question' }, true)).toContain('superego-status--question')
})

it('says the word in its colour, and nothing when idle', () => {
  expect(word({ state: 'blocked', kind: 'question' })).toBe('<span class="superego-status-word superego-status-word--question" title="Question">Question</span>')
  expect(word({ state: 'blocked', kind: 'auth' })).toContain('>Sign in<')
  expect(word({ state: 'done' })).toContain('>Done<')
  expect(word({ state: 'idle' })).toBe('')
  expect(word({ state: 'done' }, true)).toBe('')
})

it("draws a board's and a machine's marks with the same set", () => {
  for (const s of ['queued', 'stalled', 'landed', 'offline', 'connecting'] as const) expect(renderToStaticMarkup(h(Glyph, { shape: s }))).toContain(`superego-status--${s}`)
  expect(renderToStaticMarkup(h(Glyph, { shape: 'stalled' }))).toContain('is-still')
})
