// A DOM for a test that runs in Node: happy-dom's window, its globals laid over Node's for as long as a window is
// mounted, and Node's own left as they were (fetch, URL, timers). In a DOM environment already, nothing is done.
import { Window } from 'happy-dom'

let users = 0
let restore: (() => void) | undefined

/** Make sure there's a DOM; the returned function lets go of it (the last to let go takes it away). */
export function useDom(): () => void {
  if (typeof document !== 'undefined' && !restore) return () => {}
  users++
  if (!restore) {
    const window = new Window({ url: 'http://localhost/', width: 1280, height: 800 })
    const g = globalThis as Record<string, unknown>
    const added: string[] = []
    const replaced = new Map<string, PropertyDescriptor>()
    // Node's own stay; the DOM's are added. `window`, `document` and storage are the DOM's whatever Node has.
    const always = new Set(['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history', 'self'])
    for (const key of Object.getOwnPropertyNames(window)) {
      if (key.startsWith('_') || key === 'undefined' || key === 'globalThis') continue
      const ours = Object.getOwnPropertyDescriptor(g, key)
      if (ours && !always.has(key)) continue
      if (ours) replaced.set(key, ours)
      else added.push(key)
      const value = (window as unknown as Record<string, unknown>)[key]
      Object.defineProperty(g, key, { value: typeof value === 'function' && !/^[A-Z]/.test(key) ? (value as Function).bind(window) : value, configurable: true, writable: true })
    }
    Object.defineProperty(g, 'window', { value: g, configurable: true, writable: true })
    restore = () => {
      for (const key of added) delete g[key]
      for (const [key, descriptor] of replaced) Object.defineProperty(g, key, descriptor)
      void window.happyDOM.abort()
      window.close()
      restore = undefined
    }
  }
  let let_go = false
  return () => {
    if (let_go) return
    let_go = true
    if (--users === 0) restore?.()
  }
}
