#!/usr/bin/env bash
# Make this machine one the Superego app can reach over ssh: a checkout of Superego, its dependencies (no Electron, the
# daemon runs on Node), and `superego` in ~/.local/bin. Run it again to update; it restarts a running daemon.
#
#   gh repo clone mikker/superego ~/dev/superego && ~/dev/superego/scripts/install-machine.sh
#
# Node comes from mise when it's there (see mise.toml), else from PATH: it needs to run TypeScript (22.18+).
set -euo pipefail

# In braces, so bash reads it all before `git pull` below changes it.
{
dir=$(cd "$(dirname "$0")/.." && pwd)
bin=${SUPEREGO_BIN:-$HOME/.local/bin}
registry=${SUPEREGO_REGISTRY:-https://packagefeedproxy.microsoft.io/npm/}
cd "$dir"

# Where git, mise and pnpm usually are: a non-login ssh shell (as Update in the app runs this) may have none of them on
# PATH, nor `gh`, git's credential helper.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# Where mise is now, for the wrapper below: ssh's PATH may not have it (~/.local/bin, say).
mise=$(command -v mise || true)
if [[ -n $mise ]]; then
  mise trust --quiet "$dir/mise.toml"
  mise install --quiet
  eval "$(mise env -s bash -C "$dir")"
fi

git pull --ff-only --quiet || echo "install-machine: not updated from git; installing what's checked out" >&2
# The lockfile is resolved through this feed; pnpm refuses tarballs from anywhere else.
ELECTRON_SKIP_BINARY_DOWNLOAD=1 CI=1 pnpm install --frozen-lockfile --registry="$registry"

# The window's build, for Web access. Only that: with a built main, `superego` would run the daemon on Electron, which
# isn't here; without, it runs app/src/daemon.ts on Node.
(cd app && pnpm exec electron-vite build --logLevel error)
rm -rf app/out/main app/out/preload

# A wrapper, not a symlink: ssh runs `superego connect --start` in a non-login shell, where mise hasn't set up PATH.
mkdir -p "$bin"
cat > "$bin/superego" << EOF
#!/bin/sh
# Written by $dir/scripts/install-machine.sh
if [ -x "$mise" ]; then exec "$mise" exec -C "$dir" -- node "$dir/app/bin/superego.ts" "\$@"; fi
exec node "$dir/app/bin/superego.ts" "\$@"
EOF
chmod +x "$bin/superego"

# SUPEREGO_RESTART_NOW: restart though agents are working (they resume after); else a busy daemon refuses, and this fails.
"$bin/superego" daemon status | grep -q '^Running' && "$bin/superego" daemon restart ${SUPEREGO_RESTART_NOW:+--now}
echo "Installed $bin/superego ($(git rev-parse --short HEAD))"
exit
}
