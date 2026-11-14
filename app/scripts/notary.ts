// What signing and notarizing for distribution need, from the environment or the repo's .env (see .env.example):
//
// - A "Developer ID Application" certificate in the keychain. SUPEREGO_SIGN_IDENTITY picks one by name; unset, the only
//   one there is used.
// - notarytool's credentials: NOTARYTOOL_PROFILE, a keychain profile stored once with scripts/notarytool-setup.sh (the
//   same one Tuna uses, TunaNotary, unless set), or an App Store Connect API key (NOTARYTOOL_KEY_PATH, _KEY_ID,
//   _ISSUER_ID).
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { NotaryAuth } from '@superego/app/package'

const dotenv = new URL('../../.env', import.meta.url).pathname
if (existsSync(dotenv)) process.loadEnvFile(dotenv)

export function developerId(): string {
  const wanted = process.env.SUPEREGO_SIGN_IDENTITY
  if (wanted) return wanted
  const found = [...execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
    .matchAll(/"(Developer ID Application: [^"]+)"/g)].map((match) => match[1]!)
  const unique = [...new Set(found)]
  if (unique.length === 1) return unique[0]!
  if (unique.length === 0) throw new Error('No "Developer ID Application" certificate in the keychain. Create one in Xcode → Settings → Accounts → Manage Certificates, or set SUPEREGO_SIGN_IDENTITY.')
  throw new Error(`More than one Developer ID; pick one with SUPEREGO_SIGN_IDENTITY:\n  ${unique.join('\n  ')}`)
}

export function notaryAuth(): NotaryAuth {
  const { NOTARYTOOL_KEY_PATH: key, NOTARYTOOL_KEY_ID: keyId, NOTARYTOOL_ISSUER_ID: issuer } = process.env
  if (key || keyId || issuer) {
    if (!key || !keyId || !issuer) throw new Error('Set all of NOTARYTOOL_KEY_PATH, NOTARYTOOL_KEY_ID and NOTARYTOOL_ISSUER_ID, or none')
    return { key, keyId, issuer }
  }
  const profile = process.env.NOTARYTOOL_PROFILE || 'TunaNotary'
  try {
    execFileSync('xcrun', ['notarytool', 'history', '--keychain-profile', profile], { stdio: 'ignore' })
  } catch {
    throw new Error(`No notarytool profile "${profile}" in the keychain: store it once with scripts/notarytool-setup.sh`)
  }
  return { profile }
}
