// A machine's extensions as setup and Settings say them: Core, Full, or Custom (the preset and what's changed), the
// experimental ones in neither and never making it Custom; what each preset turns on, in a line; and the groups.
import { expect, it } from 'vitest'
import { extensionSwitch, type SettingsSnapshot } from '@superego/protocol'
import { changes, customLine, extensionsOf, grouped, picked, presetLine, type ExtensionRow, type Extensions } from '../src/renderer/extension-presets.ts'

const ABOUTS = [
  { name: 'panes', title: 'Panes', group: 'beside', core: true },
  { name: 'git', title: 'Git', group: 'beside', core: true },
  { name: 'terminal', title: 'Terminal', group: 'beside' },
  { name: 'github', title: 'GitHub', group: 'beside' },
  { name: 'browser', title: 'Browser', group: 'beside' },
  { name: 'coding-tools', title: 'Coding tools', group: 'agent', core: true },
  { name: 'schedules', title: 'Schedules', group: 'agent' },
  { name: 'skills', title: 'Skills', group: 'agent' },
  { name: 'ego', title: 'Ego', group: 'around', core: true },
  { name: 'images', title: 'Images', group: 'thread', core: true },
  { name: 'mine', title: 'Mine' },
  { name: 'claude-agent', title: 'Claude Agent', experimental: true },
] as const

/** The machine as its settings say: `preset`, and the switches the user changed. */
function machine(preset: 'core' | 'full', changed: Record<string, boolean> = {}): Extensions {
  const presetOf = (about: (typeof ABOUTS)[number]) => !('experimental' in about) && (preset === 'full' || 'core' in about)
  const snapshot: SettingsSnapshot = {
    sections: [{
      id: 'extensions', title: 'Extensions', order: 70, ui: 'extensions', data: ABOUTS.map((about) => ({ ...about })),
      settings: [
        { key: 'extensions.preset', title: 'Start from', type: 'choice', options: [{ value: 'core', label: 'Core' }, { value: 'full', label: 'Full' }], default: 'full', hidden: true },
        ...ABOUTS.map((about) => ({ key: extensionSwitch(about.name), title: about.title, type: 'boolean' as const, default: presetOf(about), hidden: true })),
      ],
    }],
    values: {
      'extensions.preset': preset,
      ...Object.fromEntries(ABOUTS.map((about) => [extensionSwitch(about.name), changed[about.name] ?? presetOf(about)])),
    },
  }
  return extensionsOf(snapshot)!
}

it('reads each switch against its preset from the settings', () => {
  const { preset, rows } = machine('core', { terminal: true })
  expect(preset).toBe('core')
  expect(rows.find((r) => r.name === 'terminal')).toMatchObject({ title: 'Terminal', on: true, preset: false, group: 'beside' })
  expect(rows.find((r) => r.name === 'git')).toMatchObject({ on: true, preset: true, core: true })
  expect(changes(rows).map((r) => r.name)).toEqual(['terminal'])
  expect(extensionsOf(undefined)).toBeUndefined()
})

it('is the preset until a switch differs from it, then Custom, saying what changed', () => {
  expect(picked(machine('full'))).toBe('full')
  expect(picked(machine('core'))).toBe('core')
  const github = machine('full', { github: false })
  expect(picked(github)).toBe('custom')
  expect(customLine(github)).toBe('Full without GitHub')
  expect(customLine(machine('full', { github: false, terminal: false }))).toBe('Full without Terminal and GitHub')
  expect(customLine(machine('core', { terminal: true }))).toBe('Core with Terminal')
  expect(customLine(machine('core', { terminal: true, git: false }))).toBe('Core without Git, with Terminal')
  expect(customLine(machine('full', { github: false, terminal: false, skills: false }))).toBe('Full, 3 changed')
})

it('keeps an experimental extension out of it: on or off, the preset stays as it was', () => {
  expect(picked(machine('full', { 'claude-agent': true }))).toBe('full')
  expect(picked(machine('core', { 'claude-agent': true }))).toBe('core')
  expect(customLine(machine('full', { 'claude-agent': true, github: false }))).toBe('Full without GitHub')
})

it("says what each preset turns on: Core's own by name, Full's past Core's, counting the rest", () => {
  const { rows } = machine('full')
  expect(presetLine('core', rows)).toBe('Coding tools, Git, Panes, Ego and 1 more')
  expect(presetLine('full', rows)).toBe('Adds Terminal, Browser, GitHub, Schedules and 2 more')
  // Fewer than it names: all of them.
  const few: ExtensionRow[] = [{ name: 'git', title: 'Git', core: true, on: true, preset: true }, { name: 'ego', title: 'Ego', core: true, on: true, preset: true }]
  expect(presetLine('core', few)).toBe('Git and Ego')
})

it('groups them by what each is for, those that say none after, the experimental last', () => {
  expect(grouped(machine('full').rows).map((g) => [g.title, g.rows.map((r) => r.name)])).toEqual([
    ['Beside a thread', ['panes', 'git', 'terminal', 'github', 'browser']],
    ['The agent', ['coding-tools', 'schedules', 'skills']],
    ['In the thread', ['images']],
    ['Getting around', ['ego']],
    ['Other', ['mine']],
    ['Experimental', ['claude-agent']],
  ])
})
