#!/bin/bash
# A stand-in for `tailscale` (test/look.sh web): status from $SUPEREGO_HOME/tailscale-status.json, and serve's config
# kept in $SUPEREGO_HOME/tailscale-serve.json.
status="$SUPEREGO_HOME/tailscale-status.json"
serve="$SUPEREGO_HOME/tailscale-serve.json"
[ -e "$serve" ] || echo '{}' > "$serve"
case "$1 $2" in
  "status --json") cat "$status" ;;
  "serve status") cat "$serve" ;;
  *) for last; do :; done
     if [ "$last" = off ]; then echo '{}' > "$serve"
     else printf '{"Web":{"studio.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"%s"}}}}}' "$last" > "$serve"; fi ;;
esac
