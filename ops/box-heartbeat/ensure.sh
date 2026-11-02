#!/usr/bin/env bash
# Starts supercronic for the heartbeat crontab unless one is already running for exactly this crontab.
# Idempotent; matches by crontab path, so the backup supercronic (/workspace/ops/backup/crontab) is never touched.
set -euo pipefail

dir="${BOX_HEARTBEAT_DIR:-/workspace/ops/box-heartbeat}"
supercronic="${SUPERCRONIC:-/workspace/ops/bin/supercronic}"
crontab="$dir/crontab"
log_dir="${BOX_HEARTBEAT_LOG_DIR:-/workspace/ops/box-heartbeat-logs}"

mkdir -p "$log_dir"

if pgrep -f -- "supercronic -quiet $crontab\$" >/dev/null 2>&1; then
  echo "box-heartbeat: supercronic already running for $crontab"
  exit 0
fi

nohup "$supercronic" -quiet "$crontab" >>"$log_dir/supercronic.log" 2>&1 </dev/null &
echo "box-heartbeat: started supercronic (pid $!) for $crontab"
