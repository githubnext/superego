// The Picker's keys beyond the Autocomplete's own (↑↓, ⏎): ⌃N/⌃P, ⌘⏎ and ⌃1–⌃9.
import { describe, expect, it } from 'vitest'
import { pickerKey, type PickerKey } from '../src/renderer/picker.tsx'

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
