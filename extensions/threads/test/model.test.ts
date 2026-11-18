// The model in the title bar: its provider's mark, and its card.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import threads, { modelCard } from '../src/ui.tsx'

let ui: TestWindow
beforeEach(async () => { ui = await mountUi({ extensions: [threads] }) })
afterEach(async () => { await ui.unmount() })

const opus = testThread({ id: '1', title: 't', model: 'claude-opus-4-5', provider: 'anthropic', thinking: 'high', cost: 0.4218, modelFrom: 'machine' })

it("says the model, its provider, thinking, whose choice it is and what it's cost", () => {
  expect(modelCard(opus)).toEqual({
    title: 'claude-opus-4-5',
    rows: [['Provider', 'Anthropic'], ['Thinking', 'high'], ['Chosen by', "This machine's settings"], ['Cost', '$0.42']],
  })
  const own = modelCard(testThread({ id: '1', title: 't', model: 'deepseek-v4', provider: 'deepseek', modelFrom: 'thread' }))
  expect(own.rows).toEqual([['Provider', 'deepseek'], ['Thinking', 'off'], ['Chosen by', 'This thread'], ['Cost', '$0.00']])
  const profiled = modelCard(testThread({ ...opus, profile: { name: 'reviewer', scope: 'user', dir: '/p' }, modelFrom: 'profile' }))
  expect(profiled.rows).toContainEqual(['Chosen by', 'Profile reviewer'])
  // Before its first turn, nothing to say but that.
  expect(modelCard(testThread({ id: '2', title: 't' }))).toEqual({ title: 'No model yet', rows: [] })
})

it("shows the provider's mark, not the model's name; a sparkle for a provider without one", async () => {
  const drawn = await ui.render({ view: 'threads.model', place: 'header', thread: opus })
  const button = drawn.find('.threads-model')!
  expect(button.textContent).toBe('')
  expect(button.querySelector('svg')?.getAttribute('aria-label')).toBe('Anthropic')
  expect(button.getAttribute('aria-label')).toBe('claude-opus-4-5: show thread details')
  await drawn.unmount()
  const other = await ui.render({ view: 'threads.model', place: 'header', thread: testThread({ id: '3', title: 't', model: 'deepseek-v4', provider: 'deepseek' }) })
  expect(other.find('.threads-model svg')?.getAttribute('aria-label')).toBe('deepseek')
  expect(other.find('.threads-model svg path')?.getAttribute('d')).not.toBe(drawn.container.querySelector('path')?.getAttribute('d'))
  await other.unmount()
})
