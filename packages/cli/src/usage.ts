// What the command line takes, as one table: `superego --help` prints all of it, and `superego <command> --help` (or
// `superego help <command>`) the entries of that command, with their options and examples. Both come from here, so
// they say the same.
import type { AppConfig } from '@superego/protocol'

/** An option: its flags, and what it does. */
type Option = [flags: string, does: string]

type Entry = {
  /** What follows the command's name: its words, then its arguments and options. */
  use: string
  /** What it does; more lines for more. */
  does: string
  options?: Option[]
  examples?: string[]
}

/** Options that work on every command that talks to a machine. */
const GLOBAL: Option[] = [
  ['-m, --machine <name>', 'Work on another machine (default: this computer)'],
  ['    --json', 'Print JSON'],
  ['-h, --help', 'This help; after a command, that command\'s'],
]

/** The table, in groups (a blank line apart in the full help). `id` is the command's name, `name` the app's. */
function groups(id: string, name: string): Entry[][] {
  const threadProfile: Option = ['-P, --profile <name>', "Start with this profile (default: the folder's default, the project's before yours)"]
  const worktree: Option = ['-w, --worktree', `In a git repository, work in a worktree of its own (~/.${id}/worktrees) instead of the checkout`]
  const prompt: Option = ['-p, --prompt <text>', 'Its first message']
  const extensionProfile: Option = ['-P, --profile <name>', "The profile (default: the one whose folder you're in, else the folder's default)"]
  const user: Option = ['    --user', `Yours (~/.${id}/profiles), not this project's`]
  return [
    [
      { use: '[dir] [-p prompt] [-P profile] [-w]', does: 'Start a thread in dir (default: here) and open it in the app', options: [prompt, threadProfile, worktree] },
      { use: 'open <thread>', does: 'Open a thread in the app' },
      { use: 'threads [--archived]', does: `List threads, or the archived ones (also: ${id} ls)` },
      {
        use: 'unread [--count]', does: "Threads that finished, failed or need you, unseen, on every machine this\ncomputer reaches: the app icon's count. 0 while the daemon isn't running.\n--json: { count, threads: [{ machine, id, title, state }] }",
        options: [['    --count', 'Just how many']],
        examples: [`${id} unread --count`, `${id} unread --json | jq .count`],
      },
      {
        use: 'start [dir] [-p prompt] [-P profile] [-w]', does: 'Start a thread without opening the app; prints its id (also: new)', options: [prompt, threadProfile, worktree],
        examples: [`${id} start . -p "Summarise the open TODOs"`],
      },
      { use: 'send <thread> <text...>', does: 'Send a message to a thread', examples: [`${id} send <thread> "Now the tests" && ${id} read <thread> --wait`] },
      {
        use: 'read <thread> [--wait]', does: 'Where a thread stands, and its last answer;\n--wait: once it has stopped working (on a message just sent too)',
        options: [['    --wait', 'Wait while it works, then print its answer']],
        examples: [`id=$(${id} start . -p "Summarise the open TODOs")`, `${id} read "$id" --wait`],
      },
    ],
    [
      { use: 'profile', does: 'List the profiles a thread here could start with' },
      { use: 'profile new [name] [--user]', does: `Make a profile in this project's .superego/profiles (or yours, ~/.${id}/profiles)`, options: [user], examples: [`${id} profile new support`] },
      {
        use: 'profile types [name] [--user]', does: `Give this project's profiles (or one, or yours) types for an editor: a tsconfig.json,\nand node_modules linked to this computer's ~/.${id}/types`,
        options: [user],
      },
      { use: 'profile allow [name]', does: "Let this project's profile run (again, after it changed)" },
      { use: 'profile allow-ui <name|dir> -m <machine>', does: "Let that machine's profile UI run in this computer's window, as it is now" },
      { use: 'profile revoke-ui <name|dir> -m <machine>', does: 'Stop it running here' },
    ],
    [
      {
        use: 'extensions [--thread T]', does: "What each extension on this machine is, where it's from, how it stands and\nwhat it registered; with --thread, what that thread goes without, and why",
        options: [['    --thread <thread>', 'What that thread goes without, and why']],
      },
      {
        use: 'extension new <name> [--ui] [-P profile] [--user]', does: "Make an extension in this project's profile (or yours): data-only, or with a UI half",
        options: [['    --ui', 'With a UI half (ui.tsx) beside its daemon half'], extensionProfile, user],
        examples: [`${id} extension new weather --user`, `${id} extension new board --ui --user`],
      },
      {
        use: 'extension test [extension] [-P profile] [--user] [--timeout s]', does: "Check the profile's types and run its tests (superego/testing), or one\nextension's (its folder) or test file's. It's the type checker and runtime: no Node needed",
        options: [extensionProfile, user, ['    --timeout <seconds>', 'Stop a test file that runs longer, naming the test it was in (default: 60)']],
        examples: [`${id} extension test weather --user`, `cd ~/.${id}/profiles/default && ${id} extension test`],
      },
      {
        use: 'extension reload [-P profile] [--user]', does: "Load the profile's changes now, as its next turn would", options: [extensionProfile, user],
        examples: [`${id} extension reload --user`],
      },
    ],
    [
      { use: 'machines', does: 'List machines and whether they answer' },
      { use: 'machines add <ssh-target> [--name N] [--command C]', does: 'Add a machine reached with ssh', options: [['    --name <name>', 'What to call it'], ['    --command <cmd>', `How to run ${id} there`]] },
      { use: "machines add --via '<cmd>' [--name N]", does: 'Add a machine reached by any command piping stdio to it' },
      { use: 'machines login <machine>', does: 'Log in with ssh in this terminal (a password, a code), so connections can ride it' },
      { use: 'machines rm|enable|disable|trust <machine>', does: 'Remove it, turn it on or off, or trust whoever answers there now' },
      {
        use: 'machines update <machine> [--now]', does: `Update ${name} there (its scripts/install-machine.sh) and restart its daemon;\n--now even while agents work there (they resume after)`,
      },
    ],
    [
      { use: 'settings', does: 'List settings and their values' },
      { use: 'settings set <key> <value> [--all]', does: 'Change a setting (value is JSON, or plain text)', options: [['    --all', 'On every enabled machine']], examples: [`${id} settings set agent.model anthropic/claude-sonnet-4-5`] },
      { use: 'settings reset <key> [--all]', does: 'Back to the default', options: [['    --all', 'On every enabled machine']] },
      { use: 'layout', does: "Where the window's views go: layout.json (edit it; Edit layout… in ⌘K), with the\nviews there are and the places each fits" },
      { use: 'providers', does: 'List providers and how they are signed in (Settings → Providers)' },
      { use: 'providers key <provider>', does: 'Sign in with an API key (prompted, or read from stdin)' },
      { use: 'providers sign-out <provider>', does: 'Remove a stored credential' },
      { use: 'providers retry [provider]', does: 'Retry the threads waiting for sign-in now (they retry by themselves when the credentials change)' },
    ],
    [
      { use: 'web pair', does: 'Pair a browser or phone with this machine: a link, its QR code, and a code to type' },
      { use: 'web devices', does: 'The devices paired (and your own through Tailscale)' },
      { use: 'web revoke|rename <device> [name]', does: 'Unpair a device, or rename it' },
    ],
    [
      { use: 'actions [--all]', does: 'List the actions a machine takes from the command line (--all: every action)' },
      {
        use: "do <action> [--<param> <value>...] [--params '<json>']", does: "Run an action; values are coerced to the action's schema",
        examples: [`${id} do thread.rename --thread <thread> --title "Release notes"`],
      },
      { use: 'actions log', does: 'Its newest dispatches, from anywhere' },
      { use: 'mcp', does: "Serve a machine's actions exposed to outside agents as MCP tools, over stdio" },
      { use: 'mcp-servers', does: "The MCP servers a machine's agents use (Settings → MCP servers): how each stands" },
      { use: 'mcp-servers logs <name> [--lines N]', does: 'Its log: stderr, log messages, connection errors (secrets hidden)' },
      { use: 'mcp-servers restart <name>', does: 'Stop it, forget that it failed, and start it again to check it' },
      { use: 'mcp-servers set-secret <name> [VAR]', does: 'Store its API key, or the value of a secret env var (prompted, or read from stdin)' },
      { use: 'mcp-servers sign-in <name>', does: 'Sign in to it with OAuth: open the page it prints, or paste where the browser ends up' },
      { use: 'mcp-servers sign-out <name>', does: 'Forget its secrets and its sign-in' },
    ],
    [
      { use: 'daemon [status|stop]', does: "Run this computer's daemon in the foreground, or check on it" },
      { use: 'daemon restart [--now]', does: 'Restart it onto the installed code; --now interrupts working agents' },
      { use: 'daemon install|uninstall', does: 'Run it as a service (systemd user unit, launchd agent) that outlives logouts and reboots' },
      { use: 'connect [--start]', does: "Bridge stdio to this computer's daemon (ssh runs this)" },
    ],
    [
      { use: '--skill [topic]', does: `How to use and extend ${name}, for agents: an overview and its topics` },
    ],
  ]
}

/** The words that name an entry's command: `extension test` of `extension test [extension] …`. `a|b` is either. */
const wordsOf = (entry: Entry) => {
  const words: string[] = []
  for (const token of entry.use.split(' ')) {
    if (/^[[<'-]/.test(token)) break
    words.push(token)
  }
  return words
}

/** Other names commands go by, as the dispatch takes them. */
const ALIASES: Record<string, string> = { ls: 'threads', new: 'start', profiles: 'profile' }

/** The commands the table names, first words: what `superego <word>` runs rather than taking as a folder. */
export function commandNames(): Set<string> {
  const names = new Set(groups('', '').flat().map((entry) => wordsOf(entry)[0]).filter((word): word is string => Boolean(word) && !word!.startsWith('-')))
  for (const alias of Object.keys(ALIASES)) names.add(alias)
  return names
}

const COLUMN = 40
/** An entry's lines: its use, then what it does in a column beside it (or under it, when its use is long). */
function lines(id: string, entry: Entry): string[] {
  const head = `  ${id} ${entry.use}`
  const [first = '', ...more] = entry.does.split('\n')
  const out = head.length + 1 < COLUMN ? [`${head.padEnd(COLUMN)}${first}`] : [head, `${' '.repeat(COLUMN)}${first}`]
  return [...out, ...more.map((line) => `${' '.repeat(COLUMN)}${line}`)]
}

const optionLines = (options: Option[]) => options.map(([flags, does]) => `  ${flags.padEnd(COLUMN - 2)}${does}`)

/** Every option once, the first said of each flag. */
const distinct = (options: Option[]) => [...new Map(options.map((o) => [o[0], o])).values()]

/** The whole command line. */
export function help(app: AppConfig): string {
  const all = groups(app.id, app.name)
  const body = all.map((group) => {
    const shared = distinct(group.flatMap((entry) => entry.options ?? []))
    return [...group.flatMap((entry) => lines(app.id, entry)), ...(shared.length ? optionLines(shared) : [])].join('\n')
  })
  return `${app.id}: ${app.name}\n\nUsage:\n${body.join('\n\n')}\n\nOptions:\n${optionLines(GLOBAL).join('\n')}\n\nOne command's: ${app.id} <command> --help\n`
}

/**
 * The help of the command `words` name (`['extension', 'test']`; arguments after them are left off), or undefined for
 * no command (a folder to start a thread in).
 */
export function commandHelp(app: AppConfig, given: string[]): string | undefined {
  const entries = groups(app.id, app.name).flat()
  let words = given.map((word, i) => i === 0 ? ALIASES[word] ?? word : word)
  // `extensions test` is `extension test`, as the dispatch takes it.
  if (words[0] === 'extensions' && words.length > 1) words = ['extension', ...words.slice(1)]
  const matches = (entry: Entry, count: number) => {
    const own = wordsOf(entry)
    return own.length >= count && words.slice(0, count).every((word, i) => own[i]!.split('|').includes(word))
  }
  for (let count = words.length; count > 0; count--) {
    // The entries of exactly these words when there are some (`extension test`), else every one under them (`profile`).
    const found = entries.filter((entry) => matches(entry, count))
    if (!found.length) continue
    const exact = found.filter((entry) => wordsOf(entry).length === count)
    const shown = count > 1 && exact.length ? exact : found
    const options = distinct(shown.flatMap((entry) => entry.options ?? []))
    const examples = shown.flatMap((entry) => entry.examples ?? [])
    return [
      `Usage:\n${shown.flatMap((entry) => lines(app.id, entry)).join('\n')}`,
      `Options:\n${optionLines([...options, ...GLOBAL]).join('\n')}`,
      ...(examples.length ? [`Examples:\n${examples.map((line) => `  ${line}`).join('\n')}`] : []),
    ].join('\n\n') + '\n'
  }
  return undefined
}
