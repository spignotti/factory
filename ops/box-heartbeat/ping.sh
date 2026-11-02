#!/usr/bin/env bash
# Pings the Healthchecks check `box-heartbeat`. The ping URL is a secret: it is read only from
# $HOME/.config/box-heartbeat/ping-url (mode 0600, created by the operator) and is never printed or logged.
set -euo pipefail

url_file="${HOME}/.config/box-heartbeat/ping-url"

if [ ! -s "$url_file" ]; then
  echo "box-heartbeat: ping URL file missing or empty: $url_file" >&2
  exit 2
fi

url="$(head -n 1 "$url_file" | tr -d '[:space:]')"
if [ -z "$url" ]; then
  echo "box-heartbeat: ping URL file missing or empty: $url_file" >&2
  exit 2
fi

# curl's stdout and stderr both go to /dev/null so the URL can never reach a log; only the exit code is reported.
rc=0
curl -fsS -m 10 --retry 3 "$url" >/dev/null 2>&1 || rc=$?
if [ "$rc" -ne 0 ]; then
  echo "box-heartbeat: ping failed (curl exit $rc)" >&2
  exit "$rc"
fi
