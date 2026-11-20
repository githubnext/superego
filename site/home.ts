// The home page: what Superego is, one configured workbench (the Chief of Staff) with marker rings on the parts that
// were asked for, what's built in, and what an extension can add. The screenshot is `app/test/look.sh <dir> staff`'s
// staff-wide frame, 1440×900; rings are in that frame's points.

/** A part of the screenshot, ringed and numbered, and what was asked for to get it. */
type Callout = { ring: [cx: number, cy: number, rx: number, ry: number]; asked: string }

const callouts: Callout[] = [
  {
    ring: [190, 195, 125, 62],
    asked: '…hands each part of the work to a thread of its own, four at most at a time, and tells me as each one finishes.',
  },
  {
    ring: [1145, 282, 300, 62],
    asked: '…puts decisions on a board for me to answer when I get to them, instead of stopping to ask.',
  },
  {
    ring: [569, 720, 285, 105],
    asked: "…asks me in the thread only when it can't go on without an answer.",
  },
  {
    ring: [1145, 600, 300, 150],
    asked: "…shows a board beside the thread: the plan in waves, how each thread is doing, and what's waiting on me.",
  },
]

const builtIn: [string, string][] = [
  ['Threads that keep going', 'A daemon on each machine runs them, with the window closed too.'],
  ['Every machine', 'Projects on any machine you reach over ssh, beside this Mac’s.'],
  ['Phone and browser', 'The same window, over Tailscale or your own network.'],
  ['Any model', 'Claude, GPT and the rest, with an API key or your ChatGPT subscription.'],
  ['Worktrees', 'A thread can work in a git worktree of its own.'],
  ['MCP servers', 'Linear, GitHub, Sentry and the like, signed in to once per machine.'],
]

/** What a profile is made of. */
const profileHas = [
  'A prompt: who the agent is and how it works',
  'A model, and how hard it thinks',
  'The extensions it uses, and the built-ins it goes without',
  'Its MCP servers',
  'Another profile to start from',
]

/** What an extension can add. */
const extensionHas = [
  'Tools for the agent, and lines in its prompt',
  'Panes beside the thread',
  'Ways for the agent to ask and show: questions, forms, cards',
  'What happens as a thread starts, finishes or is archived',
  'Threads that start and look after other threads',
  'Marks in the sidebar, commands, shortcuts, settings',
]

/** Where profiles live, and so who has them. */
const profileHome: [string, string][] = [
  ['Yours', 'In <code>~/.superego/profiles</code>, for every project on that machine.'],
  ['Your team’s', 'In a project’s <code>.superego/profiles</code>, in the repo: everyone who clones it gets it, once they allow it.'],
  ['Someone else’s', 'Installed from a git repo, like mine above.'],
]

/**
 * A ring drawn with a marker: one confident stroke going round once and a bit more, the second pass drifting off the
 * first, thin where the pen lands and lifts and full in between. Drawn as a filled outline so the width can vary.
 * Seeded, so every build draws the same rings.
 */
function ring([cx, cy, rx, ry]: Callout['ring'], seed: number): string {
  let state = seed * 9301 + 49297
  const random = () => ((state = (state * 16807) % 2147483647) / 2147483647)
  const turns = 1.25 + random() * 0.35
  const start = Math.PI * (0.7 + random() * 0.5)
  const tilt = (random() - 0.5) * 0.08
  const drift = 0.04 + random() * 0.04 // how far the second pass wanders from the first
  const shift = [(random() - 0.5) * 0.06 * rx, (random() - 0.5) * 0.12 * ry]
  const phase = random() * Math.PI * 2
  const steps = 180
  const centre: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const p = i / steps
    const t = start + p * turns * Math.PI * 2
    const k = 1 + 0.03 * Math.sin(2 * t + phase) + drift * p
    const x = rx * k * Math.cos(t)
    const y = ry * k * Math.sin(t)
    centre.push([
      cx + shift[0]! * p + x * Math.cos(tilt) - y * Math.sin(tilt),
      cy + shift[1]! * p + x * Math.sin(tilt) + y * Math.cos(tilt),
    ])
  }
  // Each point pushed out to either side by half the pen's width there, along the curve's normal.
  const width = (p: number) => 1 + 3.6 * Math.pow(Math.sin(Math.PI * p), 0.5)
  const left: string[] = []
  const right: string[] = []
  centre.forEach(([x, y], i) => {
    const [ax, ay] = centre[Math.max(0, i - 1)]!
    const [bx, by] = centre[Math.min(steps, i + 1)]!
    const length = Math.hypot(bx - ax, by - ay) || 1
    const [nx, ny] = [-(by - ay) / length, (bx - ax) / length]
    const half = width(i / steps) / 2
    left.push(`${(x + nx * half).toFixed(1)} ${(y + ny * half).toFixed(1)}`)
    right.push(`${(x - nx * half).toFixed(1)} ${(y - ny * half).toFixed(1)}`)
  })
  return `M${left.join(' L')} L${right.reverse().join(' L')}Z`
}

export function homeBody(o: { base: string; download: string }) {
  const W = 1440
  const H = 900
  const pc = (v: number, of: number) => `${((v / of) * 100).toFixed(2)}%`
  const rings = callouts.map((c, i) => `<path d="${ring(c.ring, i + 1)}"/>`).join('')
  const numbers = callouts
    .map((c, i) => {
      const [cx, cy, rx, ry] = c.ring
      return `<span class="mark" style="left:${pc(cx - rx * 0.92, W)};top:${pc(cy - ry * 0.92, H)}" aria-hidden="true">${i + 1}</span>`
    })
    .join('')
  return `<main class="home">
<h1>Superego</h1>
<p class="tagline">An agent workbench you make your own.</p>
<p class="sub">A small shell for running agents: threads, panes beside them, and machines to run them on. The rest is profiles and extensions, which you get by asking an agent for them.</p>
<p class="links"><a class="button" href="${o.download}">Download</a><a href="${o.base}docs/">Docs</a></p>

<figure class="shot">
<picture><source media="(prefers-color-scheme: dark)" srcset="${o.base}screenshot-dark.webp"><img src="${o.base}screenshot-light.webp" alt="The Superego window: a lead thread with its child threads in the sidebar, a question over the composer, and a board of the work beside it" width="2880" height="1800"></picture>
<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">${rings}</svg>
${numbers}
</figure>
<p class="asked-intro">I wanted something like a <em>chief of staff</em>, so I asked it “Make a new extension that…”</p>
<ol class="asked">
${callouts.map((c) => `<li>${c.asked}</li>`).join('\n')}
</ol>
<p class="take">Take it with <code>superego profile install git:github.com/mikker/superego-profiles</code>, or ask for your own.</p>

<section>
<h2>Built in</h2>
<dl class="grid">
${builtIn.map(([t, d]) => `<div><dt>${t}</dt><dd>${d}</dd></div>`).join('\n')}
</dl>
</section>

<section>
<h2>Profiles and extensions</h2>
<div class="columns">
<div>
<h3>A profile is an agent</h3>
<ul class="adds">
${profileHas.map((a) => `<li>${a}</li>`).join('\n')}
</ul>
<p><a href="${o.base}docs/profiles/">Profiles</a></p>
</div>
<div>
<h3>An extension is what it can do</h3>
<ul class="adds">
${extensionHas.map((a) => `<li>${a}</li>`).join('\n')}
</ul>
<p>The sidebar, worktrees and the terminal are extensions too. <a href="${o.base}docs/extensions/">Extensions</a></p>
</div>
</div>
<p class="where-intro">Share one with your team, or build your own dream house.</p>
<dl class="grid">
${profileHome.map(([t, d]) => `<div><dt>${t}</dt><dd>${d}</dd></div>`).join('\n')}
</dl>
</section>
</main>`
}
