// `pnpm package`: Superego.app (and a zip) in dist/, signed ad hoc for this computer, or by SUPEREGO_SIGN_IDENTITY.
// `pnpm bundle` (`--notarize`): signed with a Developer ID and notarized, for anyone's Mac. See notary.ts for what that
// needs on this machine.
import { packageApp } from '@superego/app/package'
import app from '../superego.config.ts'
import { developerId, notaryAuth } from './notary.ts'

const notarize = process.argv.includes('--notarize')
const built = await packageApp(new URL('..', import.meta.url).pathname, app, notarize
  ? { identity: developerId(), notarize: notaryAuth() }
  : { identity: process.env.SUPEREGO_SIGN_IDENTITY || null })
for (const path of built) console.log(path)
