// Put in the window's page before anything of its own runs (test/profile.mjs), as `window.__profile`: what React
// rendered, each commit (as React DevTools hears it), the page's long tasks, DOM mutations, and the timers, frames and
// observers it ran, by where they were set up. `take()` gives what's counted since the last `take()` and starts again.
(() => {
  const fresh = () => ({ commits: 0, renders: 0, mounts: 0, components: new Map(), longTasks: [], mutations: 0, callbacks: new Map(), errors: 0 })
  let stats = fresh()

  // ── React: a commit, and which components rendered in it ──
  // Function, class, forwardRef, memo and simple memo components.
  const COMPONENT = new Set([0, 1, 11, 14, 15])
  const PERFORMED_WORK = 1
  const nameOf = (fiber) => {
    const type = fiber.type
    if (!type || typeof type === 'string') return 'Anonymous'
    return type.displayName || type.name || type.render?.displayName || type.render?.name || type.type?.displayName || type.type?.name || 'Anonymous'
  }
  const count = (fiber) => {
    if (!COMPONENT.has(fiber.tag)) return
    stats.renders++
    const name = nameOf(fiber)
    stats.components.set(name, (stats.components.get(name) ?? 0) + 1)
  }
  const mounted = (fiber) => {
    count(fiber)
    stats.mounts++
    for (let child = fiber.child; child; child = child.sibling) mounted(child)
  }
  // As DevTools does: a subtree whose children are the ones it had didn't render; a component that did work did.
  const visit = (fiber) => {
    const before = fiber.alternate
    if (!before) return mounted(fiber)
    if (fiber.flags & PERFORMED_WORK) count(fiber)
    if (fiber.child !== before.child) for (let child = fiber.child; child; child = child.sibling) visit(child)
  }
  const renderers = new Map()
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers, supportsFiber: true,
    inject(renderer) { const id = renderers.size + 1; renderers.set(id, renderer); return id },
    onScheduleFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      stats.commits++
      try { visit(root.current) } catch { stats.errors++ }
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  }

  // ── Long tasks, DOM mutations ──
  const Original = { MutationObserver: window.MutationObserver }
  new PerformanceObserver((list) => { for (const e of list.getEntries()) stats.longTasks.push(Math.round(e.duration)) }).observe({ type: 'longtask', buffered: false })
  const watchDom = () => new Original.MutationObserver((records) => { stats.mutations += records.length }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  if (document.documentElement) watchDom()
  else document.addEventListener('readystatechange', watchDom, { once: true })

  // ── Timers, frames and observers: each callback run, by where it was set up ──
  const ours = /page\.js|__profile/
  const site = () => {
    const lines = new Error().stack.split('\n').slice(2)
    const line = lines.find((l) => !ours.test(l) && !l.includes('<anonymous>')) ?? lines[0] ?? '?'
    return line.trim().replace(/^at /, '').replace(/file:\/\/\S*\/(out-profile|out)\/renderer\//, '').replace(/\(?file:\/\/\S*\//, '(')
  }
  const ran = (where, kind) => {
    const key = `${kind} ${where}`
    stats.callbacks.set(key, (stats.callbacks.get(key) ?? 0) + 1)
  }
  // Where each callback was first set up: a loop setting up the same one each frame is read once, not every frame.
  const sites = new WeakMap()
  for (const [name, kind] of [['setTimeout', 'timeout'], ['setInterval', 'interval'], ['requestAnimationFrame', 'frame'], ['requestIdleCallback', 'idle']]) {
    const original = window[name]
    if (!original) continue
    window[name] = function (callback, ...rest) {
      if (typeof callback !== 'function') return original.call(this, callback, ...rest)
      let where = sites.get(callback)
      if (!where) sites.set(callback, where = site())
      return original.call(this, function (...args) { ran(where, kind); return callback.apply(this, args) }, ...rest)
    }
  }
  for (const [name, kind] of [['ResizeObserver', 'resize'], ['IntersectionObserver', 'intersection'], ['MutationObserver', 'mutation']]) {
    const Original = window[name]
    window[name] = class extends Original {
      constructor(callback, options) {
        const where = site()
        super(function (...args) { ran(where, kind); return callback.apply(this, args) }, options)
      }
    }
  }

  window.__profile = {
    take() {
      const taken = stats
      stats = fresh()
      const top = (map, n) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n)
      return {
        commits: taken.commits, renders: taken.renders, mounts: taken.mounts, errors: taken.errors,
        components: top(taken.components, 25),
        longTasks: { count: taken.longTasks.length, totalMs: taken.longTasks.reduce((a, b) => a + b, 0), maxMs: Math.max(0, ...taken.longTasks) },
        mutations: taken.mutations,
        callbacks: top(taken.callbacks, 20),
      }
    },
    /** The animations running now that never end, and what they animate. */
    animations() {
      return document.getAnimations().filter((a) => a.playState === 'running' && !Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)).map((a) => {
        const target = a.effect?.target
        const props = [...new Set((a.effect?.getKeyframes?.() ?? []).flatMap((k) => Object.keys(k).filter((p) => !['offset', 'computedOffset', 'easing', 'composite'].includes(p))))]
        return { name: a.animationName ?? a.id ?? '', target: target ? `${target.tagName.toLowerCase()}.${[...target.classList].join('.')}` : '', props, visible: Boolean(target?.checkVisibility?.()) }
      })
    },
  }
})()
