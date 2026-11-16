// Commands an app adds to its command line, beside the core's: `runCli(app, { commands })`, as its daemon takes its
// extensions. Superego's bundled mcp-servers adds `superego mcp-servers` so (extensions/mcp-servers/src/cli.ts). A
// command gets the machine `-m` named and the CLI's ways to reach it and to print, so it says things as the rest do.
import type { Transport } from '@superego/client'
import type { AppConfig, Hello, MethodName, Params, Result } from '@superego/protocol'

export type { Transport }

/** An option: its flags, and what it does (`['    --lines <n>', 'How many']`). */
export type HelpOption = [flags: string, does: string]

/** A line of help: what follows the app's id (the command's words, then its arguments), and what it does. */
export type HelpEntry = {
  use: string
  /** What it does; more lines for more. */
  does: string
  options?: HelpOption[]
  examples?: string[]
}

/** A machine, as `-m` names it: this computer (`local`) unless it's one of `superego machines`. */
export type CliMachine = { id: string; label: string; remote: boolean }

export type Call = <M extends MethodName>(method: M, params: Params<M>) => Promise<Result<M>>

export type CliContext = {
  app: AppConfig
  /** The machine to work on. */
  machine: CliMachine
  /** Run `work` with typed calls on it, closing the connection after. */
  on<T>(work: (call: Call, hello: Hello) => Promise<T>): Promise<T>
  /** A connection to it of the command's own, to hear what it notifies (`auth.event`, say); close it when done. */
  connect(): Promise<{ transport: Transport; hello: Hello }>
  /** `value` as JSON with `--json`, else what `human` prints. */
  print(value: unknown, human: () => void): void
  /** Rows in columns, the last left ragged. */
  table(rows: string[][]): void
  /** A secret, asked for without echoing it, or read from stdin when that isn't a terminal. */
  readSecret(prompt: string): Promise<string>
}

export type CliCommand = {
  /** Its name: `superego <name> …`. Not one of the core's. */
  name: string
  /** Its help, each entry's `use` starting with the name. */
  help: HelpEntry[]
  /** Options it takes beyond those every command does (`-m`, `--json`, `-h`), as `node:util`'s parseArgs takes them. */
  options?: Record<string, { type: 'string' | 'boolean'; short?: string }>
  /** Run it: `sub` and `rest` are the words after its name, `values` the options given. */
  run(cli: CliContext, sub: string | undefined, rest: string[], values: Record<string, string | boolean | undefined>): Promise<void>
}
