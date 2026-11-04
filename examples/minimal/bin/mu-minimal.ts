#!/usr/bin/env node
// `mu-minimal`: mu minimal's command line.
import { fileURLToPath } from 'node:url'
import { runCli } from '@mu/cli'
import app from '../mu.config.ts'

runCli(app, { appDir: fileURLToPath(new URL('..', import.meta.url)), bin: fileURLToPath(import.meta.url) })
