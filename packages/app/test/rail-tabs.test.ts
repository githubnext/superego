// ⌘1–⌘9: the rail's tabs in order, through actions the keymap can rebind.
import { describe, expect, it, vi } from 'vitest'
import { defineApp } from '@superego/protocol'
import { coreActions, type WindowContext } from '../src/renderer/actions.tsx'
import { conflicts } from '../src/renderer/shortcuts.ts'
import { RAIL_TABS, railTabs, tabAction, type RailTab } from '../src/renderer/rail-tabs.ts'

const app = defineApp({ name: 'superego', id: 'superego' })
const actions = coreActions(app)
const tabsAction = (n: number) => actions.find((a) => a.id === tabAction(n))!

describe("the rail's tabs", () => {
  it('are ⌘1 to ⌘9, an action each, with no clash among the shell\'s own shortcuts', () => {
    expect(Array.from({ length: RAIL_TABS }, (_, i) => tabsAction(i + 1).keys)).toEqual(['mod+1', 'mod+2', 'mod+3', 'mod+4', 'mod+5', 'mod+6', 'mod+7', 'mod+8', 'mod+9'])
    expect(tabsAction(1).title).toBe('Go to rail tab 1')
    expect(conflicts(actions, undefined)).toEqual(new Map())
  })

  it('go to the rail buttons that say what they do, then the spaces, in order', () => {
    const run = vi.fn()
    const show = vi.fn()
    const rail = [{ id: 'ego.button', action: 'ego.open' }, { id: 'unread.bell' }, { id: 'other.button', action: 'other.open' }]
    const spaces = [{ id: 'threads.list' }, { id: 'files.folder' }]
    const tabs = railTabs(rail, spaces, { offered: (action) => action !== 'other.open', run, show })
    expect(tabs.map((t) => t.id)).toEqual(['ego.button', 'threads.list', 'files.folder'])
    tabs[0]!.open()
    expect(run).toHaveBeenCalledWith('ego.open')
    tabs[2]!.open()
    expect(show).toHaveBeenCalledWith(spaces[1])
  })

  it('number nine at most', () => {
    const spaces = Array.from({ length: 12 }, (_, i) => ({ id: `s.v${i}` }))
    const tabs = railTabs([], spaces, { offered: () => true, run() {}, show() {} })
    expect(tabs.map((t) => t.id)).toEqual(spaces.slice(0, 9).map((s) => s.id))
  })

  it('a number opens its tab, and is offered only while there is one', () => {
    const open = [vi.fn(), vi.fn()]
    const tabs: RailTab[] = open.map((fn, i) => ({ id: `t.${i}`, open: fn }))
    const context = { railTabs: () => tabs } as unknown as WindowContext
    void tabsAction(2).run({} as never, context)
    expect(open[1]).toHaveBeenCalledOnce()
    expect(open[0]).not.toHaveBeenCalled()
    expect(tabsAction(2).when?.(context)).toBe(true)
    expect(tabsAction(3).when?.(context)).toBe(false)
  })
})
