// The Picker's keys: what moves through its list and what picks from it.
import { describe, expect, it } from 'vitest'
import { pickerKey, type PickerKey } from '../src/renderer/picker.tsx'

const key = (key: string, more: Partial<PickerKey> = {}): PickerKey => ({ key, code: '', ctrlKey: false, metaKey: false, altKey: false, ...more })
const digit = (n: number, more: Partial<PickerKey> = {}) => key(String(n), { code: `Digit${n}`, ctrlKey: true, ...more })

describe('picker keys', () => {
  it('moves with ↑↓ and ⌃P/⌃N, staying in the list', () => {
    expect(pickerKey(key('ArrowDown'), { active: 0, count: 3 })).toEqual({ move: 1 })
    expect(pickerKey(key('n', { ctrlKey: true }), { active: 1, count: 3 })).toEqual({ move: 2 })
    expect(pickerKey(key('ArrowDown'), { active: 2, count: 3 })).toEqual({ move: 2 })
    expect(pickerKey(key('ArrowUp'), { active: 1, count: 3 })).toEqual({ move: 0 })
    expect(pickerKey(key('p', { ctrlKey: true }), { active: 0, count: 3 })).toEqual({ move: 0 })
    // An empty list never lights a row before the first.
    expect(pickerKey(key('ArrowDown'), { active: 0, count: 0 })).toEqual({ move: 0 })
    expect(pickerKey(key('n'), { active: 0, count: 3 })).toBeUndefined()
  })

  it('picks with ⏎, beside with ⌘⏎', () => {
    expect(pickerKey(key('Enter'), { active: 2, count: 3 })).toEqual({ pick: 2, beside: false })
    expect(pickerKey(key('Enter', { metaKey: true }), { active: 0, count: 3 })).toEqual({ pick: 0, beside: true })
  })

  it('picks by ⌃1–⌃9 (⌃⌘ beside) only with digits, by the key and not what it types', () => {
    expect(pickerKey(digit(3), { active: 0, count: 5, digits: true })).toEqual({ pick: 2, beside: false })
    expect(pickerKey({ ...digit(1, { metaKey: true }), key: '¡' }, { active: 0, count: 5, digits: true })).toEqual({ pick: 0, beside: true })
    expect(pickerKey(digit(3, { altKey: true }), { active: 0, count: 5, digits: true })).toBeUndefined()
    expect(pickerKey(digit(3), { active: 0, count: 5 })).toBeUndefined()
  })
})
