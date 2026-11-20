// The home page: what Superego is, one configured workbench (the Chief of Staff) with marker rings on the parts that
// were asked for, what's built in, and what an extension can add. The screenshot is `app/test/look.sh <dir> staff`'s
// staff-wide frame, 1440×900; rings are in that frame's points.

/** A part of the screenshot, ringed and numbered, and what was asked for to get it. */
type Callout = { ring: [cx: number, cy: number, rx: number, ry: number]; asked: string }

const callouts: Callout[] = [
  {
    ring: [190, 195, 125, 62],
    asked: "Don't do the work yourself: start a thread for each part, four at most at a time, and tell me as each one finishes.",
  },
  {
    ring: [1145, 282, 300, 62],
    asked: 'Put decisions on a board for me to answer when I get to them, instead of stopping to ask.',
  },
  {
    ring: [569, 720, 285, 105],
    asked: "Ask me in the thread only when you can't go on without an answer.",
  },
  {
    ring: [1145, 600, 300, 150],
    asked: "Give me a board beside the thread: the plan in waves, how each thread is doing, and what's waiting on me.",
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

const extensionsAdd = [
  'Tools for the agent, and what its prompt says',
  'Panes beside the thread',
  'Skills',
  'Ways for the agent to ask and show: questions, forms, cards in the thread',
  'What happens as a thread starts, finishes or is archived',
  'Threads that start and look after other threads',
  'Marks and badges in the sidebar',
  'Commands, shortcuts and settings',
]

/** An ellipse drawn by hand: a little tilted, a little uneven, overshooting where it closes. Deterministic. */
function ring([cx, cy, rx, ry]: Callout['ring'], seed: number): string {
  const wobble = (n: number) => ((Math.sin(n * 12.9898) * 43758.5453) % 1) * 2 - 1
  const tilt = -0.06 + wobble(seed) * 0.04
  const points: string[] = []
  for (let i = 0; i <= 44; i++) {
    const t = Math.PI * 0.85 + (i / 40) * Math.PI * 2
    const k = 1 + wobble(seed + i) * 0.025 + i * 0.0012
    points.push(`${(cx + rx * k * Math.cos(t + tilt)).toFixed(1)} ${(cy + ry * k * Math.sin(t)).toFixed(1)}`)
  }
  return `M${points.join(' L')}`
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
<svg viewBox="0 0 ${W} ${H}" aria-hidden="true"><filter id="rough"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="4"/><feDisplacementMap in="SourceGraphic" scale="3.2"/></filter>${rings}</svg>
${numbers}
</figure>
<p class="asked-intro">My Chief of Staff, and what I asked for to get it:</p>
<ol class="asked">
${callouts.map((c) => `<li>“${c.asked}”</li>`).join('\n')}
</ol>
<p class="take">Take it with <code>superego profile install git:github.com/mikker/superego-profiles</code>, or ask for your own.</p>

<section>
<h2>Built in</h2>
<dl class="grid">
${builtIn.map(([t, d]) => `<div><dt>${t}</dt><dd>${d}</dd></div>`).join('\n')}
</dl>
</section>

<section>
<h2>What an extension can add</h2>
<ul class="adds">
${extensionsAdd.map((a) => `<li>${a}</li>`).join('\n')}
</ul>
<p class="take">The sidebar, worktrees and the terminal are extensions too. <a href="${o.base}docs/extensions/">Making one</a></p>
</section>
</main>`
}
