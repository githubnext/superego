// Tool-row descriptors: a tool describes its row (icon, verbs, subject, body), the core draws it and says what a run of
// calls did. The core describes its own tools the same way.
import { createElement, memo } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { defineApp, type ThreadInfo } from '@superego/protocol'
import { createRegistry, defineUiExtension, toolRow, toolView, unfoldedTool, type ToolRowCall, type WorkBlock } from '../src/renderer/extension.tsx'
import { DescribedCall, describeRun, mainKind, registerToolRows, statOf } from '../src/renderer/tool-rows.tsx'

const app = defineApp({ name: 'superego', id: 'superego' })
const thread: ThreadInfo = { id: '1', title: 't', cwd: '/', createdAt: 0, activeAt: 0, session: { root: '/', name: '/' }, status: { state: 'idle' } }
const where = { machine: 'local', thread }
const machine = { id: 'local', label: 'This Mac', state: 'connected' } as never
const call = (name: string, args: Record<string, unknown>, more: Partial<ToolRowCall> = {}): ToolRowCall =>
  ({ machine, thread, call: { id: 'c', name, arguments: args }, state: 'done', ...more })
const tool = (name: string, args: Record<string, unknown> = {}): WorkBlock => ({ type: 'toolCall', id: name, name, arguments: args })

describe('tool rows', () => {
  const registry = createRegistry(app, [], registerToolRows)
  const rowOf = (name: string) => toolRow(registry, name, where)

  it('keeps a row apart from a component, memo and all', () => {
    const View = () => null
    const Memo = memo(View)
    const orders = defineUiExtension({
      name: 'orders',
      setup(superego) {
        superego.tool('find_order', { verbs: ['Found', 'Finding', 'Not found'] }, { fold: false })
        superego.tool('drawn', View)
        superego.tool('memo', Memo)
      },
    })
    const registry = createRegistry(app, [orders], () => {})
    expect(toolView(registry, 'find_order', where)).toBeUndefined()
    expect(toolRow(registry, 'find_order', where).verbs).toEqual(['Found', 'Finding', 'Not found'])
    expect(unfoldedTool(registry, 'find_order', where)).toBe(true)
    expect(toolView(registry, 'drawn', where)).toBe(View)
    expect(toolView(registry, 'memo', where)).toBe(Memo)
    expect(toolRow(registry, 'drawn', where)).toEqual({})
  })

  it("matches a prefix (`mcp__*`) where a tool has no row of its own: its own name first, then the longest prefix", () => {
    const Drawn = () => null
    const servers = defineUiExtension({
      name: 'servers',
      setup(superego) {
        superego.tool('mcp__*', { verbs: ['Called', 'Calling', 'Failed'] })
        superego.tool('mcp__linear__*', Drawn, { fold: false })
        superego.tool('mcp__linear__search', { verbs: ['Searched', 'Searching', 'Search failed'] })
        // A * anywhere but the end is refused.
        superego.tool('mcp__*__x', { verbs: ['No', 'No', 'No'] })
      },
    })
    const registry = createRegistry(app, [servers], () => {})
    expect(toolRow(registry, 'mcp__sentry__find', where).verbs).toEqual(['Called', 'Calling', 'Failed'])
    expect(toolView(registry, 'mcp__linear__create_issue', where)).toBe(Drawn)
    expect(unfoldedTool(registry, 'mcp__linear__create_issue', where)).toBe(true)
    expect(toolRow(registry, 'mcp__linear__search', where).verbs).toEqual(['Searched', 'Searching', 'Search failed'])
    expect(toolView(registry, 'mcp__linear__search', where)).toBeUndefined()
    expect(toolRow(registry, 'mcp__sentry__x', where).verbs).toEqual(['Called', 'Calling', 'Failed'])
    expect(toolRow(registry, 'bash', where)).toEqual({})
  })

  it("lets a call say its own verb, and counts a prefix's tools as one kind in a run's line", () => {
    const servers = defineUiExtension({
      name: 'servers',
      setup(superego) {
        superego.tool('mcp__*', { verbs: ['Called', 'Calling', 'Failed'], verb: (c) => c.result?.text === 'cut' ? 'Cut off' : undefined, phrase: (k) => `called ${k} tools` })
      },
    })
    const registry = createRegistry(app, [servers], registerToolRows)
    const rowOf = (name: string) => toolRow(registry, name, where)
    const draw = (c: ToolRowCall) => renderToStaticMarkup(createElement(DescribedCall, { row: rowOf(c.call.name), call: c }))
    expect(draw(call('mcp__a__x', {}, { state: 'error', result: { text: 'cut', isError: true } }))).toContain('>Cut off<')
    expect(draw(call('mcp__a__x', {}, { state: 'error', result: { text: 'no', isError: true } }))).toContain('>Failed<')
    expect(describeRun([tool('mcp__a__x'), tool('mcp__b__y'), tool('read')], rowOf)).toEqual(['Read a file and called 2 tools'])
  })

  it('says what a run did, the weightiest first, naming the file of a lone one', () => {
    expect(describeRun([tool('read', { path: 'a' }), tool('read', { path: 'b' }), tool('bash', { command: 'ls' })], rowOf)).toEqual(['Ran a command and read 2 files'])
    expect(describeRun([tool('read', { path: 'a' }), tool('edit', { path: 'src/a.ts' })], rowOf)).toEqual(['Edited ', 'src/a.ts', ' and read a file'])
    expect(describeRun([tool('bash'), tool('find_order'), tool('find_order')], rowOf)).toEqual(['Ran a command and used find_order 2×'])
    expect(describeRun([{ type: 'thinking', thinking: 'hm' }], rowOf)).toEqual(['Thought'])
    expect(mainKind([tool('read'), tool('write'), tool('bash')], rowOf)).toBe('write')
    expect(mainKind([tool('find_order'), tool('read')], rowOf)).toBe('read')
  })

  it('draws a row from its parts, and the defaults for the rest', () => {
    const read = renderToStaticMarkup(createElement(DescribedCall, { row: rowOf('read'), call: call('read', { path: 'src/a.ts' }, { result: { text: 'hello', isError: false } }) }))
    expect(read).toContain('>Read<')
    expect(read).toContain('title="src/a.ts"')
    expect(read).toContain('hello')
    const failed = renderToStaticMarkup(createElement(DescribedCall, { row: rowOf('find_order'), call: call('find_order', { id: 7 }, { state: 'error', result: { text: '<harness>[error] gone</harness>', isError: true } }) }))
    expect(failed).toContain('find_order failed')
    expect(failed).toContain('{&quot;id&quot;:7}')
    expect(failed).toContain('>gone<')
    const written = renderToStaticMarkup(createElement(DescribedCall, { row: rowOf('write'), call: call('write', { path: 'a', content: 'x\ny\n' }) }))
    expect(written).toContain('2 lines')
    const listed = renderToStaticMarkup(createElement(DescribedCall, { row: { subject: () => null }, call: call('list_orders', {}) }))
    expect(listed).not.toContain('row__arg')
  })

  it("sums a call's lines from its diff, unless it failed or says otherwise", () => {
    const edited = call('edit', { path: 'a' }, { result: { text: '', isError: false, details: { diff: '+1 a\n+2 b\n-1 c' } } })
    expect(statOf(rowOf('edit'), edited)).toEqual({ added: 2, removed: 1 })
    expect(statOf(rowOf('edit'), { ...edited, state: 'error' })).toBeUndefined()
    expect(statOf({ stat: () => ({ added: 9, removed: 0 }) }, edited)).toEqual({ added: 9, removed: 0 })
  })
})
