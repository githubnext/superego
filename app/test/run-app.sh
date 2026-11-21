# Sourced by the tests that run the app (smoke, showcase, look): run it on a test script, and stop everything it started.
#
# Each run of the app gets a process group of its own (set -m), holding Electron, its helpers and the commands that
# reach other machines. The daemons it starts have sessions of their own and outlive it; they're found by what they
# hold open in $SUPEREGO_HOME (their logs and sockets), among the processes running this checkout's code: pid files
# miss a daemon whose successor was still starting, and lsof over every process takes minutes on a busy machine. All
# of them are stopped with SIGTERM, then SIGKILL if they're still there 10s later.
set -m
APP_GROUPS=
# The app's own environment only, not the login shell's (where the user's API keys are): runs start without keys.
export SUPEREGO_LOGIN_ENV=off
CHECKOUT=$(cd .. && pwd)

# The processes of the app's runs (`app`), or those and the daemons (no argument).
started() {
  [ -z "$APP_GROUPS" ] || ps -A -o pid=,pgid= | awk -v groups=" $APP_GROUPS " 'index(groups, " " $2 " ") { print $1 }'
  [ "$1" = app ] && return 0
  ours=$(ps -A -o pid=,command= | awk -v checkout="$CHECKOUT/" -v me=$$ '$1 != me && index($0, checkout) { print $1 }' | paste -sd, -)
  [ -z "$ours" ] || lsof -a -p "$ours" -Fpn 2>/dev/null | awk -v home="$(basename "$SUPEREGO_HOME")" \
    '/^p/ { pid = substr($0, 2) } /^n/ && index($0, "/" home "/") && !seen[pid]++ { print pid }'
  return 0
}

stop_started() {
  pids=$(started "$1")
  [ -n "$pids" ] || return 0
  kill $pids 2>/dev/null || true
  i=0
  while [ $i -lt 50 ] && pids=$(started "$1") && [ -n "$pids" ]; do sleep 0.2; i=$((i + 1)); done
  [ -z "$pids" ] || kill -9 $pids 2>/dev/null || true
}

# Run the app: `run_app <command…>`. The test script touches $SUPEREGO_HOME/passed once it has passed; an app that then
# hangs on its way out is stopped, and the run still passes.
run_app() {
  rm -f "$SUPEREGO_HOME/passed"
  "$@" &
  app=$!
  APP_GROUPS="$APP_GROUPS $app"
  while kill -0 $app 2>/dev/null && [ ! -e "$SUPEREGO_HOME/passed" ]; do sleep 0.5; done
  i=0
  while kill -0 $app 2>/dev/null && [ $i -lt 30 ]; do sleep 0.5; i=$((i + 1)); done
  if kill -0 $app 2>/dev/null; then
    echo "the app passed but didn't exit after 15s; stopping it" >&2
    stop_started app
    wait $app || true
    return 0
  fi
  wait $app
}
