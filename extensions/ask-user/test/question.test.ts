import { expect, it } from 'vitest'
import { answerOf, keyMove, partsOf } from '../src/question.ts'

it('takes the last paragraph as the question, the rest as context', () => {
  expect(partsOf('Which colour?')).toEqual({ context: '', ask: 'Which colour?' })
  expect(partsOf('I looked.\n\nTwo ways:\nfast, or slow.\n\n  Which should I do?  ')).toEqual({ context: 'I looked.\n\nTwo ways:\nfast, or slow.', ask: 'Which should I do?' })
})

it('leaves it all as context when it ends on a list or code', () => {
  expect(partsOf('Pick one:\n\n- red\n- blue')).toEqual({ context: 'Pick one:\n\n- red\n- blue', ask: '' })
  expect(partsOf('Run this?\n\n```sh\nrm -rf x\n```')).toEqual({ context: 'Run this?\n\n```sh\nrm -rf x\n```', ask: '' })
})

it('picks an option by its number', () => {
  const options = [{ label: 'red' }, { label: 'blue' }]
  expect(answerOf('2', options)).toBe('blue')
  expect(answerOf(' 1 ', options)).toBe('red')
  expect(answerOf('3', options)).toBe('3')
  expect(answerOf('2 please', options)).toBe('2 please')
})

it('picks with ⌃digit, and moves a highlight with ↑/↓ while nothing is typed', () => {
  const key = (key: string, more: Partial<{ code: string; ctrlKey: boolean; shiftKey: boolean }> = {}) =>
    ({ key, code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...more })
  expect(keyMove(key('2', { code: 'Digit2', ctrlKey: true }), 'typing', undefined, 3)).toEqual({ pick: 1 })
  expect(keyMove(key('5', { code: 'Digit5', ctrlKey: true }), '', undefined, 3)).toBeUndefined()
  expect(keyMove(key('ArrowUp'), '', undefined, 3)).toEqual({ active: 2 })
  expect(keyMove(key('ArrowUp'), '', 0, 3)).toEqual({ active: 0 })
  expect(keyMove(key('ArrowDown'), '', 1, 3)).toEqual({ active: 2 })
  expect(keyMove(key('ArrowDown'), '', 2, 3)).toEqual({ active: undefined })
  expect(keyMove(key('ArrowDown'), '', undefined, 3)).toBeUndefined()
  expect(keyMove(key('Enter'), '', 1, 3)).toEqual({ pick: 1 })
  expect(keyMove(key('Enter'), '', undefined, 3)).toBeUndefined()
  expect(keyMove(key('Enter', { shiftKey: true }), '', 1, 3)).toBeUndefined()
  expect(keyMove(key('ArrowUp'), 'some text', undefined, 3)).toBeUndefined()
  expect(keyMove(key('Escape'), '', 1, 3)).toEqual({ active: undefined })
})
