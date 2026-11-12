// In a browser without the daemon's token: a form for it, over everything. A page added to the home screen (Safari's
// standalone mode) keeps its own storage, apart from the browser's, and opens at the address it was added with, which
// no longer carries the token; so it asks.
import './token-gate.css'

/** The token from what was typed or pasted: the token itself, or the whole address with `#token=…` in it. */
export function tokenFrom(text: string): string {
  const value = text.trim()
  const match = /[#?&]token=([^&#\s]+)/.exec(value)
  return match ? decodeURIComponent(match[1]!) : value
}

/** Ask for the token; resolves once `check` accepts one. */
export function askToken(check: (token: string) => Promise<boolean>, rejected = false): Promise<string> {
  return new Promise((resolve) => {
    const gate = document.createElement('form')
    gate.className = 'token-gate'
    gate.innerHTML = `
      <div class="token-gate__card">
        <h1 class="token-gate__title"></h1>
        <p class="token-gate__hint">Paste the token, or the address from Settings → Web access.</p>
        <input class="superego-field token-gate__input" name="token" type="password" autocomplete="current-password"
          autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Token" />
        <p class="token-gate__error" role="alert"></p>
        <button class="superego-button superego-button--primary token-gate__go" type="submit">Connect</button>
      </div>`
    gate.querySelector('.token-gate__title')!.textContent = location.hostname
    const input = gate.querySelector('input')!
    const error = gate.querySelector<HTMLElement>('.token-gate__error')!
    const button = gate.querySelector('button')!
    const say = (message: string) => { error.textContent = message }
    if (rejected) say('That token isn’t this machine’s.')
    gate.addEventListener('submit', async (event) => {
      event.preventDefault()
      const token = tokenFrom(input.value)
      if (!token) return input.focus()
      button.disabled = true
      say('')
      const ok = await check(token).catch(() => { say('Can’t reach the machine.'); return undefined })
      button.disabled = false
      if (ok) { gate.remove(); return resolve(token) }
      if (ok === false) say('That token isn’t this machine’s.')
      input.select()
    })
    document.body.append(gate)
    input.focus()
  })
}
