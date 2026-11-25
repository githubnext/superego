import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineConfig } from 'vitest/config'
import { profileImport } from './packages/daemon/src/module-graph.ts'
import { builtins, keyShape } from './packages/daemon/src/providers.ts'

// No test signs in to a provider from this machine's environment (OPENROUTER_API_KEY, AWS_PROFILE): each starts signed
// out of all of them, whatever the machine has (empty reads as unset).
const providerEnv: Record<string, string> = {}
for (const provider of builtins()) for (const name of (await keyShape(provider.auth.apiKey)).env) providerEnv[name] = ''

// Where ssh's master sockets go when a test's data dir is too long for one (see @superego/client's ssh.ts): a
// directory of this run's own, not the shared /tmp.
const runtime = mkdtempSync(join(tmpdir(), 'superego-test-run-'))
process.on('exit', () => rmSync(runtime, { recursive: true, force: true }))

// git as the tests' own, not this machine's (~/.gitconfig): an identity, and nothing that makes each repository or
// commit cost more than it says (a commit signed by the machine's gpg-agent, a repository given the template's hook
// samples, maintenance started after a commit). On a busy machine each of those took seconds.
const gitConfig = join(runtime, 'gitconfig')
writeFileSync(gitConfig, [
  '[user]', '\tname = Test', '\temail = test@example.test',
  '[init]', '\tdefaultBranch = main', '\ttemplateDir =',
  '[commit]', '\tgpgSign = false', '[tag]', '\tgpgSign = false',
  '[maintenance]', '\tauto = false', '[gc]', '\tauto = 0', '',
].join('\n'))

const SDK_SHIM = fileURLToPath(new URL('./packages/daemon/src/sdk-shim.ts', import.meta.url))

export default defineConfig({
  // Profiles import from 'superego'; under vitest that is the daemon's SDK through a shim (packages/daemon/src/profiles.ts).
  resolve: { alias: { superego: SDK_SHIM } },
  plugins: [{
    // What the daemon's Node hook does for a profile's modules (profiles.ts): their own imports at their versions now,
    // and nothing else but 'superego' (here the shim) and Node's built-ins.
    name: 'superego-profile-versions',
    enforce: 'pre',
    async resolveId(source, importer) {
      // 'superego' comes aliased already.
      if (!importer?.includes('superego-v=') || source === SDK_SHIM) return null
      const resolved = await this.resolve(source, importer.replace(/[?#].*$/, ''), { skipSelf: true })
      const url = profileImport(source, `file://${importer}`, () => resolved && !resolved.external && resolved.id.startsWith('/') ? pathToFileURL(resolved.id).href : `unresolved:${source}`)
      return url.includes('superego-v=') ? `${fileURLToPath(url.replace(/\?.*$/, ''))}?${url.split('?')[1]}` : resolved
    },
  }],
  test: {
    include: ['packages/*/test/**/*.test.ts', 'extensions/*/test/**/*.test.ts'], testTimeout: 20_000,
    // The author types tests share (packages/cli/test/author-types.ts): a data dir to install them in, once a run.
    // Nor from the login shell's, which a daemon the tests start as the app's would read (login-env.ts).
    env: {
      ...providerEnv, SUPEREGO_LOGIN_ENV: 'off', XDG_RUNTIME_DIR: runtime, SUPEREGO_TEST_AUTHOR_TYPES: join(runtime, 'author'),
      GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1',
    },
  },
})
