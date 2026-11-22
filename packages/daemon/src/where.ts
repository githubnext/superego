// Where an agent runs and where the user is: on one computer it goes without saying; when the user's window is on
// another, `localhost` here isn't theirs, and the agent is told so (the core's `where` section, in every request, so
// short). The app's Browser pane forwards a localhost address from here; a browser can't, and nothing else does: so the
// agent gives the user no localhost address anywhere but the pane. Where it must give one, it has this machine's real
// names on its tailnets (the OS hostname is none of them), and which is the user's where that's known: the tailnet a
// browser came in through, or the one their computer is on.
import type { Windows } from './clients.ts'
import type { Tailnet } from './tailscale.ts'

/** What the agent is told of where it runs, or nothing when the user's windows are all on this computer. */
export function whereYouRun(windows: Windows, tailnets: Tailnet[] = []): string | undefined {
  const { here, elsewhere, browser, reached } = windows
  if (!elsewhere.length && !browser) return undefined
  const computers = [...elsewhere, ...(browser ? ['a browser'] : [])].join(', ')
  const lines = [
    here
      ? `The user may be in a window on this machine or on another computer (${computers}), where \`localhost\` isn't this machine.`
      : `The user's window is on another computer (${computers}), so \`localhost\` here isn't \`localhost\` for them.`,
    elsewhere.length
      ? 'Never give the user a localhost address: not in messages, links or commands for them. The one place for one is the browser pane\'s `url`, which Superego forwards to their window.'
      : 'Never give the user a localhost address: not in messages, links or commands for them.',
    'Testing with curl here shows what this machine reaches, not what they can.',
  ]
  const named = (t: Tailnet) => t.tailnet ? `${t.name} (${t.tailnet})` : t.name
  // Theirs: the one a browser reached this machine by, or one their computer is on.
  const computersThere = elsewhere.map((c) => c.toLowerCase())
  const theirs = tailnets.filter((t) => reached.includes(t.name) || computersThere.some((c) => t.peers.has(c)))
  const others = tailnets.filter((t) => !theirs.includes(t))
  // In a browser there's no pane to forward an address: any address they need is one of these.
  const need = `If they need an address${elsewhere.length ? ' beyond the browser pane' : ''}`
  if (theirs.length) {
    const also = others.length ? `; also ${others.map(named).join(', ')}` : ''
    lines.push(`This machine on their tailnet: ${theirs.map(named).join(', ')}${also}. ${need}, use ${theirs.length > 1 ? 'one of those names' : 'that name'} exactly; never make one up.`)
  } else if (tailnets.length) {
    lines.push(`This machine's tailnet names: ${tailnets.map(named).join(', ')}. ${need}, use one of these exactly; never make one up.`)
  } else {
    lines.push(`${need}, ask how they reach this machine (a Tailscale name, an ssh tunnel); never guess one.`)
  }
  return lines.join('\n')
}
