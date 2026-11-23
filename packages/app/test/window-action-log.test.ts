// @vitest-environment happy-dom
// The window's action log never keeps a key: a machine's sign-in and provider actions keep theirs as `•••` (all their
// params, on a machine from before `secrets` that doesn't say which hold one), and so does setting a secret setting,
// or one a 0.1.10 machine's Settings shows masked.
import { afterEach, expect, it } from 'vitest'
import { FEATURES, type ActionInfo, type SettingInfo, type SettingsSnapshot } from '@superego/protocol'
import { fakeMachine, mountUi, type TestMachine, type TestWindow } from '../../sdk/src/testing.ts'

const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]

/** A machine's actions, saying which params hold secrets as this generation's do (`declared`), or not at all. */
const actions = (declared: boolean): ActionInfo[] => [
  { id: 'auth.signIn', title: 'Sign in', runs: 'machine', expose: ['ui'], ...(declared ? { secret: ['key'] } : {}) },
  { id: 'auth.respond', title: 'Answer', runs: 'machine', expose: ['ui'], ...(declared ? { secret: ['value'] } : {}) },
  { id: 'providers.save', title: 'Save a provider', runs: 'machine', expose: ['ui'], ...(declared ? { secret: ['key'] } : {}) },
  { id: 'settings.set', title: 'Change a setting', runs: 'machine', expose: ['ui'] },
]

const settings: SettingsSnapshot = {
  sections: [{ id: 'keys', title: 'Keys', order: 0, settings: [
    // A 0.1.10 machine's masked text field, where keys were kept before `secrets`.
    { key: 'keys.masked', title: 'Masked', type: 'string', secret: true, default: '' } as SettingInfo,
    { key: 'keys.token', title: 'Token', type: 'secret', default: false },
    { key: 'keys.name', title: 'Name', type: 'string', default: '' },
  ] }],
  values: { 'keys.masked': '', 'keys.token': false, 'keys.name': '' },
}

/** A machine (`id`) with or without `secrets`, answering every action, its settings as `settings` says. */
function machine(id: string, secrets: boolean): TestMachine {
  const fake = fakeMachine({
    id, features: FEATURES.filter((f) => secrets || f !== 'secrets'), actions: actions(secrets),
    methods: Object.fromEntries(actions(secrets).map((a) => [a.id, () => null])),
  })
  return { ...fake, call: (method, params) => method === 'settings.watch' ? Promise.resolve({ sub: 's1', value: settings }) : fake.call(method, params) }
}

let ui: TestWindow | undefined
afterEach(async () => { await ui?.unmount(); ui = undefined })

const logged = () => ui!.registry.router.router.log().map((e) => [e.id, e.params])

it.each([['from before secrets', false], ['of this generation', true]] as const)('keeps sign-in keys out of the log on a machine %s', async (_, secrets) => {
  ui = await mountUi({ window: true, machines: [machine('box', secrets)] })
  await ui.until(() => ui!.registry.router.all('box').some((a) => a.id === 'auth.signIn'), "the machine's actions")
  await ui.dispatch('auth.signIn', { provider: 'openai', type: 'api_key', key: 'sk-hush' }, { machine: 'box' })
  await ui.dispatch('auth.respond', { flow: 'f', prompt: 'p', value: 'sk-hush' }, { machine: 'box' })
  await ui.dispatch('providers.save', { name: 'Mine', baseUrl: 'http://x', key: 'sk-hush' }, { machine: 'box' })
  expect(JSON.stringify(logged())).not.toContain('sk-hush')
  expect(logged()).toEqual(secrets
    ? [['auth.signIn', { provider: 'openai', type: 'api_key', key: '•••' }], ['auth.respond', { flow: 'f', prompt: 'p', value: '•••' }], ['providers.save', { name: 'Mine', baseUrl: 'http://x', key: '•••' }]]
    : [['auth.signIn', undefined], ['auth.respond', undefined], ['providers.save', undefined]])
})

it("keeps a secret setting's value out of the log, and any while the window doesn't have the machine's settings", async () => {
  ui = await mountUi({ window: true, machines: [machine('box', false)] })
  await ui.until(() => ui!.registry.router.all('box').some((a) => a.id === 'settings.set'), "the machine's actions")
  await ui.dispatch('settings.set', { key: 'keys.name', value: 'unknown yet' }, { machine: 'box' })
  // Settings, at the machine's tab: the window has its settings.
  $$('.app__settings')[0]!.click()
  await ui.until(() => $$('.settings__nav button').some((b) => b.textContent?.includes('box')), 'Settings')
  $$('.settings__nav button').find((b) => b.textContent?.includes('box'))!.click()
  await ui.until(() => $$('[data-key="keys.name"]').length > 0, "the machine's settings")
  for (const key of ['keys.masked', 'keys.token', 'keys.name']) await ui.dispatch('settings.set', { key, value: 'sk-hush' }, { machine: 'box' })
  expect(logged()).toEqual([
    ['settings.set', { key: 'keys.name', value: '•••' }],
    ['settings.set', { key: 'keys.masked', value: '•••' }],
    ['settings.set', { key: 'keys.token', value: '•••' }],
    ['settings.set', { key: 'keys.name', value: 'sk-hush' }],
  ])
})
