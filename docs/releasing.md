# Releasing Superego

A release is a signed, notarized `Superego.app` for Apple Silicon, zipped and attached to a GitHub release on
`githubnext/superego`, with `update.json` beside it: the feed the released app updates itself from (see
[Automatic updates](#automatic-updates)). The first install is by hand: download the zip and open the app.

**Versions:** each release raises the minor version by one (0.2.0, 0.3.0, 0.4.0…; no patch releases, and no holding back).
Early days: a release is whatever is on `main` and green, not a milestone.

Releasing is by hand, on a Mac that can sign and notarize (for now, the one that has the Developer ID and the
`TunaNotary` profile): no CI builds it.

```sh
pnpm release 0.3.0               # main, built, notarized, tagged v0.3.0 and published
pnpm release 0.3.0 --no-publish  # the same up to the notarized zip; nothing is tagged or leaves this Mac
pnpm bundle                      # this checkout as it is, notarized into app/dist (the version in app/package.json)
```

## Automatic updates

The released app updates itself with Electron's `autoUpdater` (Squirrel.Mac), in
[packages/app/src/main/app-updates.ts](../packages/app/src/main/app-updates.ts) and
[updates.ts](../packages/app/src/main/updates.ts):

- **The feed** is `updateFeed` in [app/superego.config.ts](../app/superego.config.ts), one URL:
  `https://github.com/githubnext/superego/releases/latest/download/update.json`, the newest release's `update.json`. It's
  Squirrel's JSON format (`serverType: 'json'`): `currentRelease` is the newest version, and its `updateTo.url` the
  release's zip. The app updates when `currentRelease` isn't its own version. GitHub serves both without credentials
  once the repository is public; while it's private, every check fails (Settings → About says so).
- **Only a release's build** carries the feed (`updateFeed` in the bundle's package.json, from `--update-feed`, which
  `pnpm release` passes). `pnpm package` and `pnpm bundle` builds, and the app run from source, never update themselves.
  `SUPEREGO_UPDATE_FEED=<url>` sets another feed for a packaged app, for a test.
- **When:** 10 seconds after launch, then every 4 hours, until an update is downloaded. A check the app makes on its
  own while offline fails quietly; any other failure shows in Settings → About, and a failed download or install in the
  notice in the rail too. Check for Updates… (the app menu, Settings → About) checks now.
- **Installing:** Restart (in the notice, or Settings → About) stops this computer's daemon, which runs from inside the
  app, asking first while agents work (they resume after), then quits, installs and opens the new app, which starts
  the daemon again. Quitting with an update downloaded installs it too, without reopening; the daemon is left running,
  as quitting always leaves it, on the replaced app. A packaged app that finds its daemon on older code as it starts
  restarts it onto its own as soon as no agent is working ("Restart when idle", which can be cancelled).
- **Squirrel checks the update's code signature** against the running app's designated requirement: both signed with
  the same Developer ID (team `DDB8SQMXS9`) and bundle id. An ad hoc signed app can't update.

### Trying an update locally

Two builds signed with the Developer ID (no need to notarize: Squirrel checks the signature, not the ticket), a feed
on a local HTTP server, and a data dir of their own, so neither touches your daemon:

```sh
export SUPEREGO_SIGN_IDENTITY="Developer ID Application: Mikkel Malmberg (DDB8SQMXS9)"
T=/tmp/sg-update-test && mkdir -p $T/feed $T/apps $T/home
cd app && pnpm exec electron-vite build
# The update. Its daemon code must differ from the first's to see the daemon restart onto it (a changed line will do).
node scripts/package.ts --version 0.0.2-test && cp dist/Superego-0.0.2-test-arm64.zip $T/feed/
node --input-type=module -e "import { updateFeedJson } from '@superego/app/package'; process.stdout.write(updateFeedJson({
  version: '0.0.2-test', notes: '- A test', zipUrl: 'http://127.0.0.1:8765/Superego-0.0.2-test-arm64.zip' }))" > $T/feed/update.json
# The app to update, with the local feed in it.
node scripts/package.ts --version 0.0.1-test --update-feed http://127.0.0.1:8765/update.json
ditto dist/mac-arm64/Superego.app $T/apps/Superego.app
(cd $T/feed && python3 -m http.server 8765 --bind 127.0.0.1 &)
SUPEREGO_HOME=$T/home $T/apps/Superego.app/Contents/MacOS/Superego
```

About 10 seconds in, the server logs `GET /update.json` and the zip, and the rail shows "Superego 0.0.2-test is
ready". Restart: the daemon stops, ShipIt installs (its log: `~/Library/Caches/com.githubnext.superego.ShipIt/`) and
opens the new app. It opens without `SUPEREGO_HOME`, so on your own data dir, where your running app takes it over:
start it again as above, and `superego daemon status` (the app's CLI, with `SUPEREGO_HOME`) shows a new daemon on the
new build. To try the quit path, quit instead of Restart: ShipIt installs, the old daemon keeps running, and starting
the new app restarts it. Afterwards: `superego daemon stop` with `SUPEREGO_HOME=$T/home`, and stop the server.

## Machines on releases

A machine the app reaches over ssh can run a release instead of main:
[`scripts/install-machine.sh --release [version]`](../scripts/install-machine.sh), the newest by default.

- **macOS:** it downloads the release's zip with `gh` (signed in there), puts
  `Superego.app` in `~/Applications` (replacing an older one), and writes `~/.local/bin/superego` to run the app's CLI.
  It needs no checkout, pnpm or Node.
- **Linux** (there's no Linux build): the checkout checks out the release's tag instead of pulling main, and installs as
  for main.

Either way it restarts a running daemon, unless agents are working there: `SUPEREGO_RESTART_NOW=1` restarts it anyway
(they resume after). Before, check with `ssh <host> '~/.local/bin/superego threads'`.

To move a machine to releases, from a checkout of the repository anywhere (it reads the script from stdin; on Linux it
installs the checkout at `~/dev/superego`, or `SUPEREGO_DIR`), or there with its own checkout's script:

```sh
ssh <host> 'bash -s -- --release' < scripts/install-machine.sh
ssh <host> '~/dev/superego/scripts/install-machine.sh --release'
```

After a release, update each machine the same way, or with Update in the app (`superego machines update <host>`): a
Mac on releases runs main's install-machine.sh from GitHub, a checkout at a release's tag checks out the newest tag. A
Mac that runs the app updates itself too (see [Automatic updates](#automatic-updates)), its daemon with it. A
Mac's ssh command stays `~/.local/bin/superego connect --start`. To bring a Linux machine back to main, run its
install-machine.sh without `--release`.


## Once per Mac

Signing and notarizing need two things in the keychain. `pnpm bundle` says which one is missing.

1. **A Developer ID Application certificate** for team `DDB8SQMXS9`, with its private key. Check with
   `security find-identity -v -p codesigning`. Bring it over as a `.p12` exported from Keychain Access on a Mac that
   has it, or make a new one in Xcode → Settings → Accounts → Manage Certificates → + → Developer ID Application
   (signing in to Xcode alone doesn't put one in the keychain). With more than one, pick one with
   `SUPEREGO_SIGN_IDENTITY="Developer ID Application: Mikkel Malmberg (DDB8SQMXS9)"`.
2. **notarytool's credentials**, the keychain profile `TunaNotary` that Tuna uses too. A profile can't be copied
   between Macs; store it again, in a terminal of its own (it asks for an app-specific password from
   account.apple.com, which `!` in an agent can't answer):

   ```sh
   xcrun notarytool store-credentials TunaNotary --apple-id mikkelmalmberg@me.com --team-id DDB8SQMXS9
   ```

   Or with an App Store Connect API key: `NOTARYTOOL_KEY_ID`, `NOTARYTOOL_ISSUER_ID` and `NOTARYTOOL_KEY_PATH`, set
   in the environment or in `.env` (see [.env.example](../.env.example)), and
   [scripts/notarytool-setup.sh](../scripts/notarytool-setup.sh) to store them as a profile.
   `xcrun notarytool history --keychain-profile TunaNotary` checks it.

`pnpm release` also needs `gh` signed in (`gh auth status`) with push access to the repository.

## What `pnpm bundle` does

`app/scripts/package.ts --notarize`, on top of `packageApp` in [packages/app/src/package.ts](../packages/app/src/package.ts):

1. `electron-vite build`, then stage `out/`, `resources/` and a dependency-free `package.json` in `app/dist/app`.
2. electron-builder (through `npx`, outside the workspace) packs it on the installed Electron, with the compiled
   `superego.icon` copied in, and signs every nested piece of code with the Developer ID, the hardened runtime and
   Electron's two entitlements (`allow-jit`, `allow-unsigned-executable-memory`: V8, in the app and in the daemon,
   which runs on the app's Electron as Node).
3. `notarytool submit --wait`. Anything but Accepted stops it, with Apple's log of what was wrong.
4. `stapler staple`, so the app opens offline too, and `spctl --assess` to check Gatekeeper takes it.
5. Zip it: `app/dist/Superego-<version>-arm64.zip`.

Notarizing takes a few minutes. The version is `version` in [app/package.json](../app/package.json).

## What `pnpm release <version>` does

[app/scripts/release.ts](../app/scripts/release.ts), from any checkout or worktree of the repository. It releases the
local `main` as it is when it starts, so merge first.

1. Checks first, before minutes of building: the tag not taken (here or on GitHub; it fetches), `origin/main` not
   ahead of `main`, `gh` signed in, a Developer ID and notary credentials.
2. Builds in a worktree of its own: `main`'s commit, detached, in a temporary folder, with a fresh `pnpm install`. The
   main checkout, which every merge fast-forwards, is never touched, and what's built is exactly that commit.
3. `pnpm bundle`'s steps there, with the version given: it goes into the app (`CFBundleShortVersionString`) and the
   zip's name, not into `app/package.json`. Nothing is committed for a release; the tag says which commit it was.
   If anything fails, nothing has left this Mac, and the worktree is kept to look at.
4. An annotated tag `v<version>` on that commit, then pushes it and that commit to `main` on GitHub.
5. `gh release create v<version> --latest` with the zip and `update.json`, titled `Superego <version>`, its notes the
   `## <version>` section of `CHANGELOG.md` on main. `update.json` names this version and its zip
   (`https://github.com/<repo>/releases/download/v<version>/Superego-<version>-arm64.zip`) with the same notes; as the
   newest release's, it's what every released app finds at its feed. Then it removes the worktree.

The build has the app config's `updateFeed` in it (`--update-feed`). `--no-publish` builds the same, and uploads
nothing: the feed still names the release before.

Before releasing, consolidate the changelog: move `## Unreleased`'s notes under a new `## <version>` heading,
tighten them into short sections grouped by what the user sees, leave an empty `## Unreleased` above it, and merge
that to main. `pnpm release` stops before building if main's `CHANGELOG.md` has no section for the version.

Before releasing, say what changed by where it lives, so it's clear what reaches whom: the core (protocol, daemon,
app), the bundled extensions (by name), the CLI and skill, the extension API (its version, and what breaks), and
anything outside the repo that has to follow: the user's own profiles and extensions (`~/.superego/profiles`), and
machines that must update (`superego machines update`).

Before releasing, run the checks as before any merge: `pnpm test` and `pnpm smoke`. Smoke includes
[app/test/oauth.sh](../app/test/oauth.sh): the providers' OAuth flows load in the build (pi loads them by a path the
bundle can't follow). It takes a packaged app too: `app/test/oauth.sh app/dist/mac-arm64/Superego.app`.

After it: download the zip from the release, open it, and check it starts (a first launch from a download goes
through Gatekeeper's check, which a local build skips).

## What an author's checks need from the package

`superego extension test` type-checks and tests a profile's extensions with only what the app carries: TypeScript's
native compiler for this Mac's architecture, with its `lib.*.d.ts`, in `out/node_modules/@typescript` (about 26 MB,
beside `typescript`, its package), a small test runner (vitest's `expect` and `vi`, its own `describe` and `it`),
bundled as `out/main/author-test.js` and its chunks, and the author types in `out/types`. electron-builder drops every
`*.d.ts` from an app's files, so `out/types` and `out/node_modules/@typescript` go in as a file set of their own
([packages/app/src/package.ts](../packages/app/src/package.ts)).

`pnpm smoke` checks it on the build: [app/test/author-test.sh](../app/test/author-test.sh) copies `out/` out of the repo
and runs `extension new` and `extension test` on Electron as Node, for a data-only extension and one with a UI half.
What it can't see is the packing itself. After changing how the app is packaged, check a package by hand, out of
the repo's reach:

```sh
pnpm --filter superego package
A=$(mktemp -d /tmp/sg.XXXX) && ditto app/dist/mac-arm64/Superego.app $A/Superego.app && mkdir $A/home $A/work && cd $A/work && git init -q
sg() { env -i HOME=$A/home PATH=/usr/bin:/bin SUPEREGO_HOME=$A/home ELECTRON_RUN_AS_NODE=1 $A/Superego.app/Contents/MacOS/Superego $A/Superego.app/Contents/Resources/app.asar/out/main/cli.js "$@"; }
sg extension new foo && sg extension test foo && sg extension new bar --ui && sg extension test bar; sg daemon stop
```

## When something fails

- **pnpm won't run** (`ERR_PNPM_PNPM_ENGINE_IDENTITY_UNVERIFIABLE`): where registry.npmjs.org is blocked, pnpm
  verifies the version `packageManager` pins against the registry in its own config, not `NPM_CONFIG_REGISTRY`. Set
  the mirror there once, from outside the repo: `cd ~ && pnpm config set --global registry "$NPM_CONFIG_REGISTRY"`
  (see [a registry mirror](overview.md#a-registry-mirror)).
- **No Developer ID / no notarytool profile**: see [Once per Mac](#once-per-mac).
- **Notarization Invalid**: the error prints Apple's log; it names each file and what was wrong with it (usually
  something unsigned, or signed without the hardened runtime or a timestamp).
- **It failed publishing** (pushing, or at `gh release create`): the zip is notarized and the tag made. It prints the
  commands that finish it by hand, with the zip's and `update.json`'s paths; run those rather than releasing again.
- **A released app doesn't update:** Settings → About shows the last check's error; the app's console has each
  failure (`Updating the app (check|download|install): …`). `curl -L <updateFeed>` shows what it read. A signature
  error means the new build isn't signed by the same Developer ID as the running one.
