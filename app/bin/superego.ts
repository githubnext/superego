#!/usr/bin/env node
// `superego`: Superego's command line.
import { fileURLToPath } from 'node:url'
import { runCli } from '@superego/cli'
import { mcpServersCommand } from '@superego/mcp-servers/cli'
import app from '../superego.config.ts'

runCli(app, {
  appDir: fileURLToPath(new URL('..', import.meta.url)),
  bin: fileURLToPath(import.meta.url),
  daemon: fileURLToPath(new URL('../src/daemon.ts', import.meta.url)),
  // The bundled extensions' own commands, as src/daemon.ts sets up their daemon halves.
  commands: [mcpServersCommand],
})
