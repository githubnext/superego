#!/usr/bin/env node
// `mu`: mu's command line. `pnpm link:cli` puts it on the PATH.
import { fileURLToPath } from 'node:url'
import { runCli } from '@mu/cli'
import app from '../mu.config.ts'

runCli(app, { appDir: fileURLToPath(new URL('..', import.meta.url)), bin: fileURLToPath(import.meta.url) })
