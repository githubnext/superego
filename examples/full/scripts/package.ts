// `pnpm package`: mu.app (and a zip) in dist/. Set MU_SIGN_IDENTITY to sign for distribution; unset signs ad hoc.
import { packageApp } from '@mu/app/package'
import app from '../mu.config.ts'

const built = await packageApp(new URL('..', import.meta.url).pathname, app, { identity: process.env.MU_SIGN_IDENTITY ?? null })
for (const path of built) console.log(path)
