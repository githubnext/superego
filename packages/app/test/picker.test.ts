// The Picker's keys beyond the Autocomplete's own (↑↓, ⏎): ⌃N/⌃P, ⌘⏎ and ⌃1–⌃9; its runs by group; the navigator's toggles.
import { describe, expect, it } from 'vitest'
import { pickerKey, pickerRuns, type PickerKey } from '../src/renderer/picker.tsx'
import { navigatorToggle } from '../src/renderer/Navigator.tsx'

const key = (key: string, more: Partial<PickerKey> = {}): PickerKey => ({ key, code: '', ctrlKey: false, metaKey: false, altKey: false, ...more })
const digit = (n: number, more: Partial<PickerKey> = {}) => key(String(n), { code: `Digit${n}`, ctrlKey: true, ...more })

describe('picker keys', () => {
  it('moves with ⌃N/⌃P as with ↓/↑, leaving those to the Autocomplete', () => {
    expect(pickerKey(key('n', { ctrlKey: true }))).toEqual({ as: 'ArrowDown' })
    expect(pickerKey(key('p', { ctrlKey: true }))).toEqual({ as: 'ArrowUp' })
    expect(pickerKey(key('n'))).toBeUndefined()
    expect(pickerKey(key('n', { ctrlKey: true, metaKey: true }))).toBeUndefined()
    expect(pickerKey(key('ArrowDown'))).toBeUndefined()
  })

  it('picks the lit row beside with ⌘⏎, leaving ⏎ to the Autocomplete', () => {
    expect(pickerKey(key('Enter', { metaKey: true }))).toEqual({ lit: true, beside: true })
    expect(pickerKey(key('Enter'))).toBeUndefined()
  })

  it('picks by ⌃1–⌃9 (⌃⌘ beside) only with digits, by the key and not what it types', () => {
    expect(pickerKey(digit(3), { digits: true })).toEqual({ pick: 2, beside: false })
    expect(pickerKey({ ...digit(1, { metaKey: true }), key: '¡' }, { digits: true })).toEqual({ pick: 0, beside: true })
    expect(pickerKey(digit(3, { altKey: true }), { digits: true })).toBeUndefined()
    expect(pickerKey(digit(3))).toBeUndefined()
  })
})

describe('picker runs', () => {
  it('runs each group together where its first item is, named; ungrouped, one run', () => {
    const items = ['a', 'T1', 'b', 'V1', 'T2']
    const group = (item: string) => item.startsWith('T') ? 'This thread' : item.startsWith('V') ? 'Views' : undefined
    expect(pickerRuns(items, group)).toEqual([{ items: ['a', 'b'] }, { group: 'This thread', items: ['T1', 'T2'] }, { group: 'Views', items: ['V1'] }])
    expect(pickerRuns(items)).toEqual([{ items }])
  })
})

describe('navigator keys', () => {
  const press = (key: string, more: Partial<Parameters<typeof navigatorToggle>[0]> = {}) =>
    navigatorToggle({ key, code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...more })
  it('flips the archived threads on ⌥A, by the key and not what it types', () => {
    expect(press('å', { code: 'KeyA', altKey: true })).toBe('archived')
    expect(press('a', { code: 'KeyA', altKey: true, metaKey: true })).toBeUndefined()
    expect(press('a', { code: 'KeyA' })).toBeUndefined()
  })
  it('shows one kind on ⌃P ⌃T ⌃G, everything on ⌃A', () => {
    expect(press('p', { ctrlKey: true })).toEqual({ only: 'project' })
    expect(press('t', { ctrlKey: true })).toEqual({ only: 'thread' })
    expect(press('g', { ctrlKey: true })).toEqual({ only: 'pane' })
    expect(press('a', { code: 'KeyA', ctrlKey: true })).toBe('all')
    expect(press('t', { ctrlKey: true, metaKey: true })).toBeUndefined()
  })
})
