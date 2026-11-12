// `pnpm package`: Superego.app (and a zip) in dist/. Set SUPEREGO_SIGN_IDENTITY to sign for distribution; unset signs ad hoc.
import { packageApp } from '@superego/app/package'
import app from '../superego.config.ts'

const built = await packageApp(new URL('..', import.meta.url).pathname, app, { identity: process.env.SUPEREGO_SIGN_IDENTITY ?? null })
for (const path of built) console.log(path)
