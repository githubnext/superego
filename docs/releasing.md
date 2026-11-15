# Releasing Superego

A release is a signed, notarized `Superego.app` for Apple Silicon, zipped and attached to a GitHub release on
`mikker/superego`. The repository is private, so only people with access to it can download a release. There are no
automatic updates: people download the zip and replace the app.

```sh
pnpm bundle             # build, sign and notarize into app/dist; nothing leaves this Mac but the notary upload
pnpm release 0.1.0      # the same, then commit the version, tag, push and publish it
```

## Once per Mac

Signing and notarizing need three things in the keychain. `pnpm bundle` says which one is missing.

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
3. **Your GPG key**, for the release commit and tag, as for any commit here.

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

[app/scripts/release.ts](../app/scripts/release.ts):

1. Checks first, before minutes of building: on `main`, a clean tree, the tag not taken, `origin/main` not ahead
   (it fetches), `gh` signed in, a Developer ID and notary credentials.
2. Writes the version into `app/package.json` and runs `pnpm bundle`'s steps. If any fails, the version change is
   undone and nothing has left this Mac.
3. Commits `Release v<version>`, makes an annotated tag `v<version>`, pushes `main` and the tag.
4. `gh release create v<version>` with the zip, titled `Superego <version>`, its notes generated from the commits
   since the last release. Edit them on GitHub afterwards if they need it.

Before releasing, run the checks as before any merge: `pnpm test` and `pnpm smoke`.

After it: download the zip from the release, open it, and check it starts (a first launch from a download goes
through Gatekeeper's check, which a local build skips).

## What an author's checks need from the package

`superego extension test` type-checks and tests a profile's extensions with only what the app carries: TypeScript's
compiler and a small test runner (vitest's `expect` and `vi`, its own `describe` and `it`), bundled as
`out/main/author-test.js` and its chunks (about 16 MB, 3.5 MB zipped), and the author types in `out/types`, with
TypeScript's `lib.*.d.ts` (about 4 MB). electron-builder drops every `*.d.ts` from an app's files, so `out/types` goes
in as a file set of its own ([packages/app/src/package.ts](../packages/app/src/package.ts)).

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
  the mirror there once, from outside the repo: `cd ~ && pnpm config set --global registry "$NPM_CONFIG_REGISTRY"`.
- **"The specified electronDist does not exist"**: Electron's binary wasn't downloaded on install. Run
  `node install.js` in `node_modules/.pnpm/electron@*/node_modules/electron`.
- **No Developer ID / no notarytool profile**: see [Once per Mac](#once-per-mac).
- **Notarization Invalid**: the error prints Apple's log; it names each file and what was wrong with it (usually
  something unsigned, or signed without the hardened runtime or a timestamp).
- **It failed after pushing** (at `gh release create`): the commit and tag are out. Run
  `gh release create v<version> app/dist/Superego-<version>-arm64.zip --verify-tag --title "Superego <version>" --generate-notes`
  by hand rather than releasing again.
