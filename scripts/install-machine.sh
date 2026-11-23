#!/usr/bin/env bash
# Make this machine one the Superego app can reach over ssh, with `superego` in ~/.local/bin. Run it again to update; it
# restarts a running daemon. SUPEREGO_RESTART_NOW=1: even while agents work there (they resume after); else a busy
# daemon refuses, and this fails.
#
# A release, the newest or the version given (see docs/releasing.md):
#
#   scripts/install-machine.sh --release [version]
#
#   On macOS, the release's Superego.app in ~/Applications, downloaded with `gh` (signed in, with access to the repo).
#   It needs no checkout. On Linux, which has no build of the app, a checkout at the release's tag, installed as main is
#   below. Either from a checkout on another machine (on Linux, the one at ~/dev/superego, or SUPEREGO_DIR):
#
#   ssh <host> 'bash -s -- --release' < scripts/install-machine.sh
#
# main: a checkout of Superego, pulled, its dependencies (no Electron, the daemon runs on Node) and the window's build.
#
#   gh repo clone githubnext/superego ~/dev/superego && ~/dev/superego/scripts/install-machine.sh
#
# Node comes from mise when it's there (see mise.toml), else from PATH: it needs to run TypeScript (22.18+).
#
# Packages come from the registry in this machine's pnpm config (registry.npmjs.org unless it names a mirror; see
# docs/development.md#a-registry-mirror), or SUPEREGO_REGISTRY's for this run. The install is frozen: it never rewrites
# pnpm-lock.yaml.
set -euo pipefail

# In braces, so bash reads it all before `git checkout` below changes it.
{
release=
case "${1:-}" in
  --release) release=${2:-latest} ;;
  '') ;;
  *) echo "usage: install-machine.sh [--release [version]]" >&2; exit 2 ;;
esac
bin=${SUPEREGO_BIN:-$HOME/.local/bin}
repo=${SUPEREGO_REPO:-githubnext/superego}

restart() {
  "$bin/superego" daemon status | grep -q '^Running' || return 0
  "$bin/superego" daemon restart ${SUPEREGO_RESTART_NOW:+--now}
  # A restart runs the daemon's own command again: one this didn't install (a checkout's, on moving to a release's app)
  # still runs the old code, so it's stopped, and this install's started.
  if "$bin/superego" daemon status | grep -q '^An update is installed'; then
    "$bin/superego" daemon stop
    "$bin/superego" daemon restart
  fi
}

if [[ -n $release && $(uname -s) == Darwin ]]; then
  # As scripts/machine-path.sh, which isn't here without a checkout: ssh's PATH may not have gh.
  PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
  apps=${SUPEREGO_APPS:-$HOME/Applications}
  app="$apps/Superego.app"
  if [[ $release == latest ]]; then tag=$(gh release view --repo "$repo" --json tagName --jq .tagName); else tag=v${release#v}; fi
  installed=$(defaults read "$app/Contents/Info.plist" CFBundleShortVersionString 2> /dev/null || true)
  if [[ v$installed != "$tag" ]]; then
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    gh release download "$tag" --repo "$repo" --pattern 'Superego-*-arm64.zip' --dir "$tmp"
    ditto -x -k "$tmp"/Superego-*-arm64.zip "$tmp/unzipped"
    [[ -d $tmp/unzipped/Superego.app ]] || { echo "install-machine: no Superego.app in $tag's zip" >&2; exit 1; }
    mkdir -p "$apps"
    rm -rf "$app"
    mv "$tmp/unzipped/Superego.app" "$app"
  fi
  # The CLI the app's Settings installs: the app's Electron, run as Node.
  mkdir -p "$bin"
  rm -f "$bin/superego" # Not through a symlink (to a checkout's app/bin/superego.ts, as `pnpm link:cli` makes).
  cat > "$bin/superego" << EOF
#!/bin/sh
# Written by scripts/install-machine.sh --release
ELECTRON_RUN_AS_NODE=1 exec '$app/Contents/MacOS/Superego' '$app/Contents/Resources/app.asar/out/main/cli.js' "\$@"
EOF
  chmod +x "$bin/superego"
  restart
  echo "Installed $bin/superego (Superego $(defaults read "$app/Contents/Info.plist" CFBundleShortVersionString), $app)"
  exit
fi

# This script's checkout; read from stdin (`bash -s`), ~/dev/superego's or SUPEREGO_DIR's.
if [[ -f $0 ]]; then dir=$(cd "$(dirname "$0")/.." && pwd); else dir=${SUPEREGO_DIR:-$HOME/dev/superego}; fi
cd "$dir"

. "$dir/scripts/machine-path.sh"

# Where mise is now, for the wrapper below: ssh's PATH may not have it (~/.local/bin, say).
mise=$(command -v mise || true)
if [[ -n $mise ]]; then
  mise trust --quiet "$dir/mise.toml"
  mise install --quiet
  eval "$(mise env -s bash -C "$dir")"
fi

if [[ -n $release ]]; then
  git fetch --tags --force --quiet
  if [[ $release == latest ]]; then tag=$(git tag --list 'v*' --sort=-v:refname | head -n 1); else tag=v${release#v}; fi
  [[ -n $tag ]] || { echo "install-machine: no release tags in $dir" >&2; exit 1; }
  git -c advice.detachedHead=false checkout --quiet "$tag"
else
  # Back from a release's tag to main.
  git symbolic-ref --quiet HEAD > /dev/null || git checkout --quiet main
  git pull --ff-only --quiet || echo "install-machine: not updated from git; installing what's checked out" >&2
fi
ELECTRON_SKIP_BINARY_DOWNLOAD=1 CI=1 pnpm install --frozen-lockfile ${SUPEREGO_REGISTRY:+--registry="$SUPEREGO_REGISTRY"}

# The window's build, for Web access. Only that: with a built main, `superego` would run the daemon on Electron, which
# isn't here; without, it runs app/src/daemon.ts on Node.
(cd app && pnpm exec electron-vite build --logLevel error)
rm -rf app/out/main app/out/preload

# A wrapper, not a symlink: ssh runs `superego connect --start` in a non-login shell, where mise hasn't set up PATH.
mkdir -p "$bin"
rm -f "$bin/superego"
cat > "$bin/superego" << EOF
#!/bin/sh
# Written by $dir/scripts/install-machine.sh
if [ -x "$mise" ]; then exec "$mise" exec -C "$dir" -- node "$dir/app/bin/superego.ts" "\$@"; fi
exec node "$dir/app/bin/superego.ts" "\$@"
EOF
chmod +x "$bin/superego"

restart
echo "Installed $bin/superego ($(git describe --tags --exact-match --match 'v*' 2> /dev/null || git rev-parse --short HEAD))"
exit
}
