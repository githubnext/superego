// Where an agent runs and where the user is: on one computer it goes without saying; when the user's window is on
// another, `localhost` here isn't theirs, and the agent is told so (the core's `where` section, in every request, so
// short). The window's Preview forwards a localhost address from here (web-panes); a browser can't.
import type { Windows } from './clients.ts'

/** What the agent is told of where it runs, or nothing when the user's windows are all on this computer. */
export function whereYouRun(hostname: string, windows: Windows): string | undefined {
  const { here, elsewhere, browser } = windows
  if (!elsewhere.length && !browser) return undefined
  const computers = [...elsewhere, ...(browser ? ['a browser'] : [])].join(', ')
  const lines = [
    here
      ? `You run on ${hostname}. The user may be in a window here or on another computer (${computers}), where \`localhost\` isn't this machine.`
      : `You run on ${hostname}. The user's window is on another computer (${computers}), so \`localhost\` here isn't \`localhost\` for them.`,
    'Testing with curl here shows what this machine reaches, not what their browser can.',
  ]
  lines.push(elsewhere.length
    ? 'To show them a server running here, open the preview pane on its localhost address: Superego forwards it to their window. For anything else, ask how they reach this machine (a Tailscale name, an ssh tunnel) before giving them an address.'
    : 'Before giving them an address of a server running here, ask how they reach this machine (a Tailscale name, an ssh tunnel).')
  return lines.join('\n')
}
