import { describe, expect, it } from 'vitest'
import type { SettingsSnapshot } from '@mu/protocol'
import { mergeSettings } from '../src/renderer/merge-settings.ts'

const snapshot = (models: string[], value: string | null, fast: boolean): SettingsSnapshot => ({
  sections: [
    { id: 'model', title: 'Model', order: 10, settings: [
      { key: 'agent.model', title: 'Model', default: null, type: 'choice', nullable: true, options: models.map((m) => ({ value: m, label: m })) },
      { key: 'agent.fast', title: 'Fast', default: false, type: 'boolean' },
    ] },
    { id: 'providers', title: 'Providers', order: 20, settings: [], ui: 'providers' },
  ],
  values: { 'agent.model': value, 'agent.fast': fast },
})

describe('mergeSettings', () => {
  it('offers only choices every machine accepts, and marks disagreement', () => {
    const [section, ...rest] = mergeSettings({
      a: snapshot(['anthropic/opus', 'openai/gpt'], 'anthropic/opus', true),
      b: snapshot(['anthropic/opus'], null, true),
    })
    expect(rest).toEqual([]) // providers is per machine
    const [model, fast] = section!.settings
    expect(model).toMatchObject({ machines: ['a', 'b'], mixed: true, options: [{ value: 'anthropic/opus', label: 'anthropic/opus' }] })
    expect(fast).toMatchObject({ mixed: false, value: true })
  })

  it('keeps a setting only one machine has, for that machine', () => {
    const one = snapshot(['x/y'], null, false)
    const other: SettingsSnapshot = { sections: [{ id: 'model', title: 'Model', order: 10, settings: [] }], values: {} }
    expect(mergeSettings({ a: one, b: other })[0]!.settings.map((s) => [s.key, s.machines])).toEqual([['agent.model', ['a']], ['agent.fast', ['a']]])
  })
})
