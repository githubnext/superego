// A stand-in for `gh`, for tests and look.sh's github scene: run as `node fake-gh.cjs <dir> <gh's arguments>` by a `gh`
// on a PATH of its own (fake-gh.ts writes one). It answers from <dir>/github.json (who's signed in, the pull requests
// GitHub has as GraphQL nodes by `owner/repo#number` on any host, each branch's, a rate limit, a failure) and logs each call to
// <dir>/calls.jsonl.
const fs = require('node:fs')
const path = require('node:path')
const dir = process.argv[2]
const args = process.argv.slice(3)
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, cwd: process.cwd(), prompt: process.env.GH_PROMPT_DISABLED }) + '\n')
const world = JSON.parse(fs.readFileSync(path.join(dir, 'github.json'), 'utf8'))
const out = (text) => process.stdout.write(text)
const fail = (text, code = 1) => { process.stderr.write(text + '\n'); process.exit(code) }
const signedOut = 'You are not logged into any GitHub hosts. To log in, run: gh auth login'
if (args[0] === '--version') { out('gh version 2.99.0 (fake)\n'); process.exit(0) }
if (args[0] === 'auth' && args[1] === 'status') {
  if (!world.login) fail(signedOut)
  const hosts = Object.fromEntries(['github.com', ...(world.hosts ?? [])].map((host) => [host, [{ state: 'success', active: true, host, login: world.login }]]))
  out(JSON.stringify({ hosts }))
  process.exit(0)
}
if (!world.login) fail('To get started with GitHub CLI, please run:  gh auth login', 4)
if (args[0] === 'pr' && args[1] === 'list') {
  if (world.listFailing) fail(world.listFailing)
  const branch = args[args.indexOf('--head') + 1]
  out(JSON.stringify((world.branches?.[branch] ?? []).map((url, i) => ({ url, createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }))))
  process.exit(0)
}
if (args[0] === 'api' && args[1] === 'graphql') {
  if (world.failing) fail(world.failing)
  if (world.rateLimitedUntil && Date.now() / 1000 < world.rateLimitedUntil) {
    out('HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: ' + world.rateLimitedUntil + '\n\n{"message":"API rate limit exceeded"}')
    fail('gh: API rate limit exceeded (HTTP 403)')
  }
  const query = args.find((a) => a.startsWith('query=')).slice(6)
  const data = { rateLimit: { remaining: 4999, resetAt: '2030-01-01T00:00:00Z' } }
  const errors = []
  for (const [, alias, owner, repo, number] of query.matchAll(/(p\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/g)) {
    const node = world.prs?.[owner + '/' + repo + '#' + number]
    data[alias] = { pullRequest: node ?? null }
    if (!node) errors.push({ type: 'NOT_FOUND', path: [alias, 'pullRequest'], message: 'Could not resolve to a PullRequest with the number of ' + number + '.' })
  }
  out('HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 4999\n\n' + JSON.stringify(errors.length ? { data, errors } : { data }))
  process.exit(errors.length ? 1 : 0)
}
fail('fake gh: no answer for ' + args.join(' '))
