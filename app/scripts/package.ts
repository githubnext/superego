// `pnpm package`: Superego.app (and a zip) in dist/, signed ad hoc for this computer, or by SUPEREGO_SIGN_IDENTITY.
// `pnpm bundle` (`--notarize`): signed with a Developer ID and notarized, for anyone's Mac. See notary.ts for what that
// needs on this machine. `--version <v>` names the app's version (as `pnpm release` does), else package.json's.
// `--update-feed <url>`: where the app looks for updates (a release's: the app config's `updateFeed`); else it never does.
import { parseArgs } from 'node:util'
import { packageApp } from '@superego/app/package'
import app from '../superego.config.ts'
import { developerId, notaryAuth } from './notary.ts'

const { values } = parseArgs({ options: { notarize: { type: 'boolean' }, version: { type: 'string' }, 'update-feed': { type: 'string' } } })
const signing = values.notarize
  ? { identity: developerId(), notarize: notaryAuth() }
  : { identity: process.env.SUPEREGO_SIGN_IDENTITY || null }
const built = await packageApp(new URL('..', import.meta.url).pathname, app, {
  ...signing, ...(values.version ? { version: values.version } : {}), ...(values['update-feed'] ? { updateFeed: values['update-feed'] } : {}),
})
for (const path of built) console.log(path)
