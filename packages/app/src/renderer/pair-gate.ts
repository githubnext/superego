// In a browser this machine doesn't know yet: a form for a pairing code, over everything. Settings → Web access makes
// the code (or an address carrying it); the page trades it for a credential of this browser's own, kept in its
// localStorage. A page added to the home screen (Safari's standalone mode) keeps its own storage, apart from the
// browser's, so it pairs on its own.
import './pair-gate.css'

/** The code from what was typed or pasted: the code itself, or the whole address with `#pair=…` in it. */
export function codeFrom(text: string): string {
  const value = text.trim()
  const match = /[#?&]pair=([^&#\s]+)/.exec(value)
  return match ? decodeURIComponent(match[1]!) : value
}

/** What a pairing attempt came to: paired, or why not. */
export type Paired = { ok: true } | { ok: false; error: string }

/** Ask for a code until `pair` takes one. `message` says why it's asking (a code that didn't work, a revoked browser). */
export function askToPair(pair: (code: string, name: string) => Promise<Paired>, message = ''): Promise<void> {
  return new Promise((resolve) => {
    const gate = document.createElement('form')
    gate.className = 'pair-gate'
    gate.innerHTML = `
      <div class="pair-gate__card">
        <h1 class="pair-gate__title"></h1>
        <p class="pair-gate__hint">Enter a pairing code from Settings → Web access on that machine.</p>
        <input class="superego-field pair-gate__input pair-gate__code" name="code" autocomplete="one-time-code"
          autocapitalize="characters" autocorrect="off" spellcheck="false" aria-label="Pairing code" placeholder="XXXX-XXXX" />
        <input class="superego-field pair-gate__input" name="name" autocomplete="off" aria-label="This device's name"
          placeholder="This device's name (optional)" />
        <p class="pair-gate__error" role="alert"></p>
        <button class="superego-button superego-button--primary pair-gate__go" type="submit">Pair</button>
      </div>`
    gate.querySelector('.pair-gate__title')!.textContent = location.hostname
    const [input, name] = gate.querySelectorAll('input')
    const error = gate.querySelector<HTMLElement>('.pair-gate__error')!
    const button = gate.querySelector('button')!
    const say = (text: string) => { error.textContent = text }
    say(message)
    gate.addEventListener('submit', async (event) => {
      event.preventDefault()
      const code = codeFrom(input!.value)
      if (!code) return input!.focus()
      button.disabled = true
      say('')
      const result = await pair(code, name!.value.trim()).catch((): Paired => ({ ok: false, error: 'Can’t reach the machine.' }))
      button.disabled = false
      if (result.ok) { gate.remove(); return resolve() }
      say(result.error)
      input!.select()
    })
    document.body.append(gate)
    input!.focus()
  })
}

/** Turned away by who we are, not by a missing code (Tailscale says this login isn't allowed): say so, and offer to try again. */
export function refused(message: string): Promise<void> {
  return new Promise((resolve) => {
    const gate = document.createElement('form')
    gate.className = 'pair-gate'
    gate.innerHTML = `
      <div class="pair-gate__card">
        <h1 class="pair-gate__title"></h1>
        <p class="pair-gate__error" role="alert"></p>
        <button class="superego-button superego-button--primary pair-gate__go" type="submit">Try again</button>
      </div>`
    gate.querySelector('.pair-gate__title')!.textContent = location.hostname
    gate.querySelector('.pair-gate__error')!.textContent = message
    gate.addEventListener('submit', (event) => { event.preventDefault(); gate.remove(); resolve() })
    document.body.append(gate)
  })
}
