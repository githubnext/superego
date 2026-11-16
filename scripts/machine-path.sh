# Where git, mise and pnpm usually are, put first on PATH: a non-login ssh shell (as an update from the app or
# `superego machines update` runs, see packages/client/src/update.ts) may have none of them, nor `gh`, git's credential
# helper. Sourced by install-machine.sh and by that update, before it pulls.
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
