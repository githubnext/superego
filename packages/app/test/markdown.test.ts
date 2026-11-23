// Markdown as a preview: clamped to a few lines and set compact, still the same Markdown (its links claimed as ever).
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/renderer/Markdown.tsx'

const render = (props: Parameters<typeof Markdown>[0]) => renderToStaticMarkup(h(Markdown, props))

describe('Markdown', () => {
  it('is set plain, unclamped, by default', () => {
    expect(render({ text: '**hi**' })).toBe('<div class="md"><p><strong>hi</strong></p></div>')
  })

  it('clamps to `lines`, typeset all the same', () => {
    const html = render({ text: '**Done.** Merged `main`.\n\n- one\n- two', lines: 4 })
    expect(html).toMatch(/^<div class="md md--clamped" style="-webkit-line-clamp:4">/)
    expect(html).toContain('<strong>Done.</strong>')
    expect(html).toContain('<code>main</code>')
    expect(html).toContain('<li>one</li>')
  })

  it('sets compact, alone or clamped', () => {
    expect(render({ text: 'x', compact: true })).toMatch(/^<div class="md md--compact">/)
    expect(render({ text: 'x', compact: true, lines: 2 })).toMatch(/^<div class="md md--compact md--clamped" style="-webkit-line-clamp:2">/)
  })

  it('marks a table cell of prose, not one of a few words, and keeps its alignment', () => {
    const html = render({ text: '| Thread | Where it stands |\n| :-- | --: |\n| [Style](thread:1) | It compared our buttons with **COSS**, and they are identical. |' })
    expect(html).toContain('<th style="text-align:left">Thread</th>')
    expect(html).toContain('<td style="text-align:left"><a')
    expect(html).toContain('<td style="text-align:right" class="is-prose">It compared')
  })

  it('takes no clamp at 0', () => {
    expect(render({ text: 'x', lines: 0 })).toBe('<div class="md"><p>x</p></div>')
  })
})
