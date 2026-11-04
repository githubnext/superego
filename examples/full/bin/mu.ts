#!/usr/bin/env node
// `mu`: mu's command line.
import { fileURLToPath } from 'node:url'
import { runCli } from '@mu/cli'
import app from '../mu.config.ts'

// mu's own command also makes new apps (`mu new <dir>`), from the examples in this checkout.
runCli(app, {
  appDir: fileURLToPath(new URL('..', import.meta.url)),
  bin: fileURLToPath(import.meta.url),
  generator: { root: fileURLToPath(new URL('../../..', import.meta.url)) },
})
