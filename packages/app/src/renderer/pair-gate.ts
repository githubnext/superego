// In a browser that isn't paired with the daemon: a form for a pairing code, over everything. A page added to the home
// screen (Safari's standalone mode) keeps its own cookies, apart from the browser's, so it is a device of its own, and
// pairs with the code Settings → Web access shows beside the link.
import './pair-gate.css'

export type Pairing = 'ok' | 'wrong' | 'limited'

export const LIMITED = 'Too many tries. Wait a few minutes.'

/** Ask for a pairing code until `pair` takes one; `why` says why it asks, when that's news. */
export function askPairing(pair: (code: string) => Promise<Pairing>, why?: string): Promise<void> {
  return new Promise((resolve) => {
    const gate = document.createElement('form')
    gate.className = 'pair-gate'
    gate.innerHTML = `
      <div class="pair-gate__card">
        <h1 class="pair-gate__title">Pair this device</h1>
        <p class="pair-gate__hint">Enter the code from Settings → Web access → Pair a device, on <span class="pair-gate__host"></span>.</p>
        <input class="superego-field pair-gate__input" name="code" autocomplete="one-time-code" placeholder="ABCD-EFGH"
          autocapitalize="characters" autocorrect="off" spellcheck="false" aria-label="Pairing code" />
        <p class="pair-gate__error" role="alert"></p>
        <button class="superego-button superego-button--primary pair-gate__go" type="submit">Pair</button>
      </div>`
    gate.querySelector('.pair-gate__host')!.textContent = location.hostname
    const input = gate.querySelector('input')!
    const error = gate.querySelector<HTMLElement>('.pair-gate__error')!
    const button = gate.querySelector('button')!
    const say = (message: string) => { error.textContent = message }
    if (why) say(why)
    gate.addEventListener('submit', async (event) => {
      event.preventDefault()
      const code = input.value.trim()
      if (!code) return input.focus()
      button.disabled = true
      say('')
      const result = await pair(code).catch(() => { say('Can’t reach the machine.'); return undefined })
      button.disabled = false
      if (result === 'ok') { gate.remove(); return resolve() }
      if (result === 'wrong') say('That code isn’t right, or it has expired.')
      if (result === 'limited') say(LIMITED)
      input.select()
    })
    document.body.append(gate)
    input.focus()
  })
}
