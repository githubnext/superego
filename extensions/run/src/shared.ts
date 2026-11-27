// run: what it is. Each folder's dev command, from its `.superego/run.json`, as a process of Processes' (the folder's,
// named `run`): Processes runs it, shows it and keeps it through restarts; Run only says what it is.
import type { ExtensionAbout } from '@superego/protocol'

export const about = {
  name: 'run', version: '1.0.0', api: '^5.18', title: 'Run',
  description: "Each folder's dev command, from its .superego/run.json, run by Processes (⌃R starts or restarts it).",
} satisfies ExtensionAbout

/** The name its process has among its folder's. */
export const NAME = 'run'
