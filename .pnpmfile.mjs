// pnpm-lock.yaml names only the public npm registry: each registry package as an integrity hash, no tarball URL
// (docs/overview.md#a-registry-mirror). A machine resolving through a mirror gets the mirror's metadata instead, and a
// mirror that serves its tarballs from another host, with only sha1 hashes, would write those into the lockfile.
// afterAllResolved puts each such package back as registry.npmjs.org has it, after checking that the mirror's tarball
// is the one npm serves, or fails the install: never a lockfile that doesn't verify against npm.

const NPM = 'https://registry.npmjs.org/'
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/
const CONCURRENCY = 16

export const hooks = {
  async afterAllResolved(lockfile, context) {
    const mirrored = Object.entries(lockfile.packages ?? {}).flatMap(([key, entry]) => {
      const pkg = registryPackage(key)
      return pkg && fromMirror(entry.resolution) ? [{ ...pkg, entry }] : []
    })
    if (mirrored.length === 0) return lockfile

    const failures = []
    const queue = [...mirrored]
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let pkg; (pkg = queue.shift());) {
        try {
          pkg.entry.resolution = await asOnNpm(pkg)
        } catch (error) {
          failures.push(`${pkg.name}@${pkg.version}: ${error.message}`)
        }
      }
    }))
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} of the ${mirrored.length} packages resolved through a registry mirror can't be written to ` +
          `pnpm-lock.yaml as registry.npmjs.org has them:\n  ${failures.sort().join('\n  ')}\n` +
          'The lockfile names only npm (docs/overview.md#a-registry-mirror). Make this change against npm ' +
          `(add --registry=${NPM}), or on a machine that reaches it.`,
      )
    }
    context.log(`Recorded ${mirrored.length} packages resolved through a mirror as registry.npmjs.org has them`)
    return lockfile
  },
}

// `name@1.2.3` (or `@scope/name@1.2.3`): a package from a registry. Anything else (`file:`, git, a tarball URL)
// is kept as it is.
function registryPackage(key) {
  const at = key.lastIndexOf('@')
  if (at <= 0) return null
  const version = key.slice(at + 1)
  return SEMVER.test(version) ? { name: key.slice(0, at), version } : null
}

// A resolution npm didn't give: a tarball on another host, or an integrity other than npm's sha512.
function fromMirror(resolution) {
  if (!resolution || resolution.type) return false // a directory, git, binary or variations resolution
  const { tarball, integrity } = resolution
  if (tarball && !/^https?:\/\//.test(tarball)) return false // file:
  return (tarball != null && !tarball.startsWith(NPM)) || !integrity?.startsWith('sha512-')
}

async function asOnNpm({ name, version, entry }) {
  const url = `${NPM}${name.replace('/', '%2f')}/${version}`
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  } catch (error) {
    throw new Error(`can't reach ${url}: ${error.cause?.message ?? error.message}`)
  }
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`)
  const { dist, deprecated } = await response.json()
  if (!dist?.shasum) throw new Error(`${url} has no dist.shasum`)
  const npmIntegrity = dist.integrity ?? `sha1-${Buffer.from(dist.shasum, 'hex').toString('base64')}`

  const mirrorIntegrity = entry.resolution.integrity
  if (!mirrorIntegrity) throw new Error('the mirror gave no integrity to check against npm')
  if (!sameTarball(mirrorIntegrity, dist.shasum, npmIntegrity)) {
    throw new Error(`the mirror's tarball (${mirrorIntegrity}) isn't npm's (${npmIntegrity})`)
  }
  // The mirror's copy of a deprecation notice can differ from npm's (this one's has been shortened).
  if (deprecated) entry.deprecated = deprecated
  else delete entry.deprecated
  const tarball = entry.resolution.tarball
  return tarball != null && tarball.startsWith(NPM) ? { integrity: npmIntegrity, tarball } : { integrity: npmIntegrity }
}

function sameTarball(mirrorIntegrity, npmShasum, npmIntegrity) {
  const npmHashes = new Set(npmIntegrity.split(/\s+/))
  npmHashes.add(`sha1-${Buffer.from(npmShasum, 'hex').toString('base64')}`)
  return mirrorIntegrity.split(/\s+/).some((hash) => npmHashes.has(hash))
}
