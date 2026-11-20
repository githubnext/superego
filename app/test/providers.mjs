// Screenshots of providers and models (run by test/look.sh <dir> providers): Settings → Providers with some signed in,
// one added, the rest searched; Settings → Favourite models; ⌘N's model menu, its favourites first, one starred and
// one signed out.
import { openApp } from './harness.mjs'

await openApp({ name: 'providers', timeout: 180_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1100, 760)
  await until(`!!document.querySelector('.onboarding')`, 'the first-launch page')
  const signIn = (provider, key) => run(`new Promise((done, fail) => {
    window.superego.call('local', 'auth.signIn', { provider: '${provider}', type: 'api_key', key: '${key}' }).then(() => setTimeout(done, 300), fail)
  })`)
  await signIn('openai', 'sk-look')
  await signIn('groq', 'gsk-look')
  await signIn('mistral', 'mistral-look')
  await run(`window.superego.call('local', 'providers.save', { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', models: ['llama3.1:8b', 'qwen3:32b', 'gpt-oss:20b'] })`)
  await run(`window.superego.call('local', 'settings.set', { key: 'agent.favourites', value: ['openai/gpt-6.1-sol', 'ollama/qwen3:32b', 'mistral/mistral-large-latest', 'anthropic/claude-opus-5-5'] })`)

  await t.click('.app__settings')
  await until(`[...document.querySelectorAll('.settings__nav button')].some((b) => b.textContent.trim() === 'This computer')`, 'Settings')
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent.trim() === 'This computer').click()`)
  await until(`!!document.querySelector('.providers__find')`, 'Providers')
  const providers = `document.querySelector('.providers').closest('section, .settings-section')?.scrollIntoView() ?? document.querySelector('.providers').scrollIntoView()`
  await t.both('favourites', `document.querySelector('.favourites').scrollIntoView({ block: 'center' })`)
  await t.both('providers', providers)
  await run(`(() => { const input = document.querySelector('.providers__find input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, 'goo'); input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await until(`document.querySelectorAll('.provider.is-compact').length < 5`, 'searched')
  await t.both('providers-search', providers)
  await t.click('.providers__find .superego-button')
  await until(`!!document.querySelector('.provider-form')`, 'the add form')
  await t.both('providers-add', providers)
  t.key('Escape', [])

  await t.click('.app__rail [aria-label="Threads"]')
  t.key('n')
  await until(`!!document.querySelector('.new-thread .model-picker__button:not(:disabled)')`, 'the new thread dialog')
  await t.click('.new-thread .model-picker__button')
  await until(`document.querySelectorAll('.model-picker__item').length > 10`, 'the model menu')
  await t.both('model-menu')
  await until(`document.activeElement?.getAttribute('aria-label') === 'Search Model'`, 'the search field focused')
  t.key('Down', [])
  await until(`document.querySelector('.model-picker__item[data-highlighted]')?.textContent.includes('GPT-6.1 Sol')`, 'GPT-6.1 Sol highlighted')
  t.key('d', ['meta'])
  await until(`document.querySelectorAll('.model-picker__group:nth-child(2) .model-picker__item').length === 3`, 'one unstarred with ⌘D')
  await t.both('model-menu-unstarred')
  console.log('providers: done')
})
