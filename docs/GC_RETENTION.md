# Factory gc retention

`factory gc` reclaims disk under `$FACTORY_HOME` without touching secrets, profile, or notify config, and without hiding runs from `status` and `stats`.

## What it removes

| Stage | When | Paths |
| --- | --- | --- |
| **Strip** | Terminal run (`done`, `failed`, `abandoned`) whose branch is pushed, or that has no PR. Also the automatic gc at the start of `factory run`. | `$FACTORY_HOME/runs/<id>/home`, published `evidence/`, `services/` logs, and every `node_modules`, `.venv`, `.nox` under the worktree |
| **Worktrees** | Merged/closed PRs; no-PR runs idle ≥ 7 d (failed) or ≥ 14 d (`needs_input` / `needs_human` / `base_red`) | Git worktrees; then `git worktree prune` per repo |

Kept in `runs/<id>/`: `events.jsonl`, `result.json`, `state.json`, `plan.json`, `pr.md`, review and gate reports. The worktree itself goes when the PR is merged or closed (or after the no-PR idle window). Run directories are not archived and are not deleted by age.

Never touched: `keys/`, `secrets/`, `memory/`, `archive/keys`, `archive/memory`, `*.bak`, `profile.yaml`, `notify.yaml*`, `cache/`, or runs that are active. `needs_input` / `needs_human` / `base_red` keep their worktree and `home/` (the worktree of a no-PR resume run still follows the 14-day idle rule). An unpushed branch is not stripped.

Guards:

- **Strip** takes **no repo lock**. Only real directories inside the run (not a symlink) are removed. Unpublished `evidence/` stays. A run that currently holds a lock slot is skipped (`run is live; home/ kept`).
- **Worktrees and `factory/*` branches** (merged/closed PRs, and no-PR runs past retention) take a short lock file `factory.gitops.lock` in the checkout's git common dir, not a run slot. Manual and scheduled gc wait up to 60s for it; the automatic gc at the start of `factory run` waits 5s. If it stays busy, that worktree is skipped until the next gc. A live run's worktree is never removed.
- **deploy-self:** gc skips deletions only while `deploy-self.sh once` holds `flock` on `$FACTORY_RELEASES/.deploy.lock`. That flock is on the process fd and is released when `once` exits, including a crash. A leftover lock file with nobody holding it does not block gc. A missing `flock` binary does not block gc either (macOS has no `flock`).
- No `--force` on the scheduled path. Dirty worktrees and branches with unpushed commits are skipped for worktree removal. The strip also skips an unpushed branch.

## Shared cache

Setup, checks and agents set `UV_CACHE_DIR`, `npm_config_cache`, `PIP_CACHE_DIR` and `XDG_CACHE_HOME` to `$FACTORY_HOME/cache`. `HOME` stays `runs/<id>/home`, so git and gh config stay isolated. The Linux jail bind-mounts the cache read-write and still hides the rest of `$FACTORY_HOME`.

## Configuration

Built-in defaults live in `profiles/default.yaml` under `gc.retention`. Override in `$FACTORY_HOME/profile.yaml`:

```yaml
gc:
  retention:
    dry_run: true   # scheduled `factory gc --scheduled` uses this until you flip it after ~1 week of log review
    worktree_failed_days: 7
    worktree_resume_days: 14
```

`home_hours`, `metadata_days`, `metadata_failed_days`, `metadata_min_per_repo` and `archive_tarball_days` are still accepted so older profiles load. They no longer delay the strip and gc no longer writes metadata tarballs.

CLI flags: `--retention-days`, `--dry-run`, `--force`. Manual runs default to **live** deletes unless you pass `--dry-run`. The LaunchAgent should call `factory gc --scheduled`, which applies `gc.retention.dry_run`. A scheduled dry-run does not resume `base_red` runs.

Each run appends one JSON line to `$FACTORY_HOME/gc.log` (rotated at 5 MiB) with paths, byte counts, and reasons (no secrets).

## Scheduling (macOS LaunchAgent)

Daily at 04:30, `~/Library/LaunchAgents/com.factory.gc.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.factory.gc</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>exec "$HOME/.local/bin/factory" gc --scheduled</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>4</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
</dict>
</plist>
```

```
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.factory.gc.plist
```

Leave `gc.retention.dry_run: true` for the first week and read `$FACTORY_HOME/gc.log`; flip it to `false` in `$FACTORY_HOME/profile.yaml` only after that review. `--scheduled` never forces and stays dry-run while the profile says so, even though the CLI otherwise defaults to live.

## Backups (restic)

**Exclude** (large and regenerable, or secret): `cache/`, `runs/*/home`, `runs/*/worktree`, `runs/*/evidence`, `runs/*/services`, `archive/keys`, `archive/notify.yaml*`, and the top-level `keys/`, `secrets/`, `notify.yaml` and `locks/`. Global excludes in the box profile: `*.key`, `*.pem`, `.env*`.

**Include** (small, valuable): run metadata under `runs/` (events, state, plan, reviews, `pr.md`), `memory/`, `profile.yaml`, `*.bak`.
