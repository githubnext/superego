#!/usr/bin/env bash
# Make this machine one the mu app can reach over ssh: a checkout of mu, its dependencies (no Electron, the
# daemon runs on Node), and `mu` in ~/.local/bin. Run it again to update; it restarts a running daemon.
#
#   gh repo clone mikker/mu ~/dev/mu && ~/dev/mu/scripts/install-machine.sh
#
# Node comes from mise when it's there (see mise.toml), else from PATH: it needs to run TypeScript (22.18+).
set -euo pipefail

# In braces, so bash reads it all before `git pull` below changes it.
{
dir=$(cd "$(dirname "$0")/.." && pwd)
bin=${MU_BIN:-$HOME/.local/bin}
registry=${MU_REGISTRY:-https://packagefeedproxy.microsoft.io/npm/}
cd "$dir"

if command -v mise > /dev/null; then
  mise trust --quiet "$dir/mise.toml"
  mise install --quiet
  eval "$(mise env -s bash -C "$dir")"
fi

git pull --ff-only --quiet || echo "install-machine: not updated from git; installing what's checked out" >&2
# The lockfile is resolved through this feed; pnpm refuses tarballs from anywhere else.
ELECTRON_SKIP_BINARY_DOWNLOAD=1 CI=1 pnpm install --frozen-lockfile --registry="$registry"

# The window's build, for Web access. Only that: with a built main, `mu` would run the daemon on Electron, which
# isn't here; without, it runs app/src/daemon.ts on Node.
(cd app && pnpm exec electron-vite build --logLevel error)
rm -rf app/out/main app/out/preload

# A wrapper, not a symlink: ssh runs `mu connect --start` in a non-login shell, where mise hasn't set up PATH.
mkdir -p "$bin"
cat > "$bin/mu" << EOF
#!/bin/sh
# Written by $dir/scripts/install-machine.sh
if command -v mise > /dev/null; then exec mise exec -C "$dir" -- node "$dir/app/bin/mu.ts" "\$@"; fi
exec node "$dir/app/bin/mu.ts" "\$@"
EOF
chmod +x "$bin/mu"

"$bin/mu" daemon status | grep -q '^Running' && "$bin/mu" daemon restart
echo "Installed $bin/mu ($(git rev-parse --short HEAD))"
exit
}
