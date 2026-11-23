// An API key as pasted in setup: whose it is, and whether it can be one at all, before anything is sent with it.
import { expect, it } from 'vitest'
import { keyProblem, keyProvider, pastedKey } from '../src/renderer/key-shapes.ts'

const providers = [{ id: 'anthropic', env: ['ANTHROPIC_API_KEY'] }, { id: 'openai', env: ['OPENAI_API_KEY'] }, { id: 'mistral', env: ['MISTRAL_API_KEY'] }]

it('tells whose a key is by how it starts', () => {
  expect(keyProvider('sk-ant-api03-abcdefghijklmnop', providers)).toBe('anthropic')
  expect(keyProvider('  sk-proj-abcdefghijklmnopqrst ', providers)).toBe('openai')
  expect(keyProvider('AIzaSyAbcdefghijklmnopqrstuvwxyz', providers)).toBe('google')
  expect(keyProvider('gsk_abcdefghijklmnopqrstuvwxyz', providers)).toBe('groq')
  expect(keyProvider('sk-or-v1-abcdefghijklmnopqrstuvwxyz', providers)).toBe('openrouter')
  // A bare sk- is OpenAI's, DeepSeek's, Moonshot's…: it doesn't say.
  expect(keyProvider('sk-abcdefghijklmnopqrstuvwxyz', providers)).toBeUndefined()
  expect(keyProvider('abcdefghijklmnopqrstuvwxyz012345', providers)).toBeUndefined()
})

it('takes a key pasted with its variable, saying whose it is', () => {
  expect(pastedKey('export MISTRAL_API_KEY="abcdefghijklmnopqrstuvwxyz"')).toEqual({ key: 'abcdefghijklmnopqrstuvwxyz', variable: 'MISTRAL_API_KEY' })
  expect(keyProvider('MISTRAL_API_KEY=abcdefghijklmnopqrstuvwxyz', providers)).toBe('mistral')
  expect(keyProvider("export OPENAI_API_KEY='sk-abcdefghijklmnopqrstuvwxyz'", providers)).toBe('openai')
})

it("refuses what can't be a key before sending it", () => {
  expect(keyProblem('hello')).toBe("That doesn't look like an API key.")
  expect(keyProblem('sk-ant-api03 sk-proj-two-keys-pasted')).toBe("That doesn't look like an API key.")
  expect(keyProblem('sk-ant-api03-abcdefghijklmnop')).toBeUndefined()
  expect(keyProblem('')).toBeUndefined()
})

it('takes a key out of a line from a shell file: quotes, a trailing semicolon or comment, the first of several lines', () => {
  expect(pastedKey('"sk-ant-api03-abcdefghijklmnop"').key).toBe('sk-ant-api03-abcdefghijklmnop')
  expect(pastedKey("'sk-ant-api03-abcdefghijklmnop';").key).toBe('sk-ant-api03-abcdefghijklmnop')
  expect(pastedKey('export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrst;')).toEqual({ key: 'sk-proj-abcdefghijklmnopqrst', variable: 'OPENAI_API_KEY' })
  expect(pastedKey('export OPENAI_API_KEY="sk-proj-abcdefghijklmnopqrst"; # work')).toEqual({ key: 'sk-proj-abcdefghijklmnopqrst', variable: 'OPENAI_API_KEY' })
  expect(pastedKey('MISTRAL_API_KEY=abcdefghijklmnopqrstuvwxyz  # mine').key).toBe('abcdefghijklmnopqrstuvwxyz')
  expect(pastedKey('export MISTRAL_API_KEY=abcdefghijklmnopqrstuvwxyz\nexport OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrst\n'))
    .toEqual({ key: 'abcdefghijklmnopqrstuvwxyz', variable: 'MISTRAL_API_KEY' })
  expect(keyProblem('export MISTRAL_API_KEY=abcdefghijklmnopqrstuvwxyz\nexport OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrst')).toBeUndefined()
})

it("goes by the key's start where the variable it came with says otherwise", () => {
  expect(keyProvider('ANTHROPIC_API_KEY=sk-proj-abcdefghijklmnopqrst', providers)).toBe('openai')
  // A start that doesn't say: the variable does.
  expect(keyProvider('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz', providers)).toBe('openai')
})

it("says at once that a Claude subscription token isn't an API key, without calling it Anthropic's", () => {
  const token = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz'
  expect(keyProvider(token, providers)).toBeUndefined()
  expect(keyProblem(token, { sent: false })).toBe("That's a Claude subscription token, not an API key.")
  expect(keyProblem(`export ANTHROPIC_API_KEY=${token}`)).toBe("That's a Claude subscription token, not an API key.")
  // Anything else is said only once it's sent.
  expect(keyProblem('hello', { sent: false })).toBeUndefined()
})
