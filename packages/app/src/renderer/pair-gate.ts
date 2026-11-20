// In a browser that isn't paired with the daemon: a form for a pairing code, over everything. A page added to the home
// screen (Safari's standalone mode) keeps its own cookies, apart from the browser's, so it is a device of its own, and
// pairs with the code Settings → Web access shows beside the link. On one of the user's own tailnet devices, which
// waits to be approved there instead (see the daemon's web-devices.ts), it says which to approve, and goes once it is.
import { autoFocusOnOpen } from '@superego/ui/touch'
import './pair-gate.css'

export type Pairing = 'ok' | 'wrong' | 'limited'

export const LIMITED = 'Too many tries. Wait a few minutes.'
/** How often a device waiting to be approved asks whether it is. */
const WAITING_POLL = 3_000

/**
 * Ask for a pairing code until `pair` takes one; `why` says why it asks, when that's news. A device `waiting` to be
 * approved (by the name Settings lists it under) is told so too, and the gate goes as soon as `admitted` says it's in.
 */
export function askPairing(pair: (code: string) => Promise<Pairing>, { why, waiting }: {
  why?: string
  waiting?: { name: string; admitted(): Promise<boolean> }
} = {}): Promise<void> {
  return new Promise((resolve) => {
    const gate = document.createElement('form')
    gate.className = 'pair-gate'
    gate.innerHTML = `
      <div class="pair-gate__card">
        ${waiting ? `
        <h1 class="pair-gate__title">Approve this device</h1>
        <p class="pair-gate__hint">On <span class="pair-gate__host"></span>, approve <strong class="pair-gate__name"></strong> in
          Settings → Web access, from the app or a browser that’s in. Or enter a pairing code from there.</p>` : `
        <h1 class="pair-gate__title">Pair this device</h1>
        <p class="pair-gate__hint">Enter the code from Settings → Web access → Pair a device, on <span class="pair-gate__host"></span>.</p>`}
        <input class="superego-field pair-gate__input" name="code" autocomplete="one-time-code" placeholder="ABCD-EFGH"
          autocapitalize="characters" autocorrect="off" spellcheck="false" aria-label="Pairing code" />
        <p class="pair-gate__error" role="alert"></p>
        <button class="superego-button superego-button--primary pair-gate__go" type="submit">Pair</button>
      </div>`
    gate.querySelector('.pair-gate__host')!.textContent = location.hostname
    if (waiting) gate.querySelector('.pair-gate__name')!.textContent = waiting.name
    const input = gate.querySelector('input')!
    const error = gate.querySelector<HTMLElement>('.pair-gate__error')!
    const button = gate.querySelector('button')!
    const say = (message: string) => { error.textContent = message }
    if (why) say(why)
    let poll: ReturnType<typeof setTimeout> | undefined
    const done = () => { clearTimeout(poll); gate.remove(); resolve() }
    // Waiting: in as soon as it's approved. A check that fails (the network, the daemon restarting) is said, and tried again.
    const check = () => {
      if (!waiting) return
      poll = setTimeout(() => {
        void waiting.admitted().then((ok) => {
          if (!gate.isConnected) return
          if (ok) return done()
          if (error.textContent === 'Can’t reach the machine.') say('')
          check()
        }, (failure: unknown) => {
          console.error('Checking whether this device is approved:', failure)
          say('Can’t reach the machine.')
          check()
        })
      }, WAITING_POLL)
    }
    gate.addEventListener('submit', async (event) => {
      event.preventDefault()
      const code = input.value.trim()
      if (!code) return input.focus()
      button.disabled = true
      say('')
      const result = await pair(code).catch(() => { say('Can’t reach the machine.'); return undefined })
      button.disabled = false
      if (result === 'ok') return done()
      if (result === 'wrong') say('That code isn’t right, or it has expired.')
      if (result === 'limited') say(LIMITED)
      input.select()
    })
    document.body.append(gate)
    check()
    if (autoFocusOnOpen()) input.focus()
  })
}
