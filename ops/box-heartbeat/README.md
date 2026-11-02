# Box heartbeat

Detects a box outage from outside: the box pings the Healthchecks check `box-heartbeat`
(period 5 min, grace 10 min) every 5 minutes. If pings stop, Healthchecks alerts.

The check, the ping-URL file and the alert route (Healthchecks webhook to the backup alarm) are set up by Zuse;
nothing in this repo creates them.

## Files

- `ping.sh`: reads the ping URL from `~/.config/box-heartbeat/ping-url` (mode 0600) and pings it with
  `curl -fsS -m 10 --retry 3`. The URL is never printed or logged; on failure only curl's exit code is logged.
  A missing or empty file exits non-zero and names the path only.
- `crontab`: supercronic schedule, `*/5 * * * *`.
- `ensure.sh`: starts `supercronic -quiet <crontab>` in the background if none is running for this crontab.
  Safe to run repeatedly; it does not touch the backup supercronic.

The box has no systemd and no cron (PID 1 is tini), so jobs run under supercronic, like `/workspace/ops/backup/`.

## Deploy

1. Copy this directory to `/workspace/ops/box-heartbeat/` (the crontab uses that absolute path).
2. Make sure `~/.config/box-heartbeat/ping-url` exists with mode 0600.
3. Run `/workspace/ops/box-heartbeat/ensure.sh`.
4. Logs: `/workspace/ops/box-heartbeat-logs/` (no URL in them).

Autostart after a box restart is handled in pm #246 (s6/supervisord) by Zuse.
