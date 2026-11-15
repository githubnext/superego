// Thinking: new turns think at medium unless chosen otherwise, `off` is a choice, and a level the model lacks moves
// to the nearest it has.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SettingsRegistry } from '@superego/settings'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models'
import { createAgentSettings, KEYS, type AgentSettings } from '../src/agent-settings.ts'
import { createAuthFlows } from '../src/auth-flows.ts'

let done: (() => Promise<void>) | undefined
afterEach(async () => { await done?.(); done = undefined })

async function signedIn() {
  const dir = await mkdtemp(join(tmpdir(), 'superego-thinking-'))
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ anthropic: { type: 'api_key', key: 'sk-ant-test' } }))
  const settings = new SettingsRegistry()
  const agent: AgentSettings = await createAgentSettings(settings, dir, { name: 'superego', id: 'thinkingtest' } as never, createAuthFlows())
  done = async () => { agent.close(); await rm(dir, { recursive: true, force: true }) }
  const thinking = async () => (await settings.snapshot()).sections.find((s) => s.id === 'model')!.settings.find((s) => s.key === KEYS.thinking)!
  return { agent, settings, thinking }
}

it('thinks at medium by default, and off when chosen', async () => {
  const { agent, settings, thinking } = await signedIn()
  // A model that can stop thinking, and think at medium.
  const can = agent.models.getModels('anthropic').find((m) => m.reasoning && ['off', 'medium'].every((l) => getSupportedThinkingLevels(m).includes(l as never)))!
  await settings.set(KEYS.model, `anthropic/${can.id}`)
  expect(agent.resolve()).toEqual({ model: { provider: 'anthropic', modelId: can.id }, thinkingLevel: 'medium' })
  expect(agent.catalog().default.thinking).toBe('medium')
  // A choice of levels, off among them, and no "default" that isn't one.
  const setting = await thinking()
  expect(setting.type).toBe('choice')
  expect(setting.type === 'choice' && setting.nullable).toBeFalsy()
  expect(setting.type === 'choice' && setting.options.map((o) => o.value)).toContain('off')

  await settings.set(KEYS.thinking, 'off')
  expect(agent.resolve().thinkingLevel).toBe('off')
  // A thread's own choice wins over the machine's.
  expect(agent.resolve({ thinking: 'high' }).thinkingLevel).toBe('high')
  await settings.set(KEYS.thinking, 'medium')
  expect(agent.resolve({ thinking: 'off' }).thinkingLevel).toBe('off')
})

it('shows a level the model lacks as the one it runs with', async () => {
  const { agent, settings, thinking } = await signedIn()
  const models = agent.models.getModels('anthropic').filter((m) => m.reasoning)
  const has = models.find((m) => getSupportedThinkingLevels(m).includes('xhigh'))!
  const lacks = models.find((m) => !getSupportedThinkingLevels(m).includes('xhigh'))!
  await settings.set(KEYS.model, `anthropic/${has.id}`)
  await settings.set(KEYS.thinking, 'xhigh')
  // Chosen on one model, then another that lacks it.
  await settings.set(KEYS.model, `anthropic/${lacks.id}`)
  const setting = await thinking()
  const options = setting.type === 'choice' ? setting.options : []
  const ran = agent.resolve().thinkingLevel!
  expect(ran).not.toBe('xhigh')
  expect(options[0]).toEqual({ value: 'xhigh', label: `xhigh (${ran} on this model)` })
})
