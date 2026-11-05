# Factory gc retention

`factory gc` reclaims disk under `$FACTORY_HOME` without touching secrets, profile, or notify config.

## What it removes

| Stage | When | Paths |
| --- | --- | --- |
| Sandbox **home/** | Terminal run idle ≥ 24 h. A `needs_input` / `needs_human` / `base_red` run is eligible the same way once its PR is merged or closed. | `$FACTORY_HOME/runs/<id>/home` |
| **Worktrees** | Merged/closed PRs (existing rules); no-PR failed idle ≥ 7 d; needs_input / needs_human / base_red idle ≥ 14 d | Git worktrees; then `git worktree prune` per repo |
| **Metadata** | Idle ≥ 90 d (failed ≥ 180 d), keeping the newest 20 runs per repo | Tarball to `$FACTORY_HOME/archive/runs/<id>.tar.gz`, then drop `$FACTORY_HOME/runs/<id>/` |
| **Archive** | Tarballs/dirs under `archive/runs/` older than 180 d | Deletes tarballs; strips `home/` and `worktree/` from legacy archived run dirs first |

Never touched: `keys/`, `secrets/`, `memory/`, `archive/keys`, `archive/memory`, `*.bak`, `profile.yaml`, `notify.yaml*`, or runs that are active. needs_input / needs_human / base_red keep their worktree and metadata while idle &lt; 14 days; their sandbox `home/` is removed after `home_hours` only when that run's PR is already merged or closed (an open or missing PR keeps `home/`).

Guards:

- **Sandbox `home/`** is removed with **no repo lock** when the run is terminal (not `locked`) and idle ≥ `home_hours`, and also when a `needs_input` / `needs_human` / `base_red` run is idle ≥ `home_hours` and its PR is merged or closed. The directory is that run's cache, not a git operation. Only `runs/<id>/home` goes; events, state, plan, reviews and `pr.md` stay. An open or missing PR keeps the home. A run that currently holds a lock slot is skipped (`run is live; home/ kept`). Another run of the same repo holding a slot does not keep it. PR state is the same `GitHub.prStatus` lookup the worktree stage uses; a failed lookup keeps `home/`.
- **Worktrees and `factory/*` branches** (merged/closed PRs, and no-PR runs past retention) take a short lock file `factory.gitops.lock` in the checkout's git common dir, not a run slot. The same lock is held around `git worktree add` / `remove` / `prune` in runs, adopt, abandon and base worktrees, so those operations do not interleave. Manual and scheduled gc wait up to 60s for it; the automatic gc at the start of `factory run` waits 5s. If it stays busy, that worktree is skipped until the next gc. A live run's worktree is never removed. A free run slot is not required, so a repo with `max_runs: 2` and one run active is still cleaned.
- **Metadata archive** still takes every run slot (exclusive). It does not delete a run directory while any slot is held.
- **deploy-self:** gc skips deletions only while `deploy-self.sh once` holds `flock` on `$FACTORY_RELEASES/.deploy.lock`. That flock is on the process fd and is released when `once` exits, including a crash. A leftover lock file with nobody holding it does not block gc, and the daemon's `.daemon.lock` is a different file, so a finished deploy cannot skip the daily run permanently. A missing `flock` binary fails closed (gc skips). The overlap with a deploy is one `once` (a fetch, or a build when `main` moved), not the daemon's whole lifetime.
- No `--force` on the scheduled path. Dirty worktrees and branches with unpushed commits are skipped.

## Configuration

Built-in defaults live in `profiles/default.yaml` under `gc.retention`. Override in `$FACTORY_HOME/profile.yaml`:

```yaml
gc:
  retention:
    dry_run: true   # scheduled `factory gc --scheduled` uses this until you flip it after ~1 week of log review
    home_hours: 24
    worktree_failed_days: 7
    worktree_resume_days: 14
    metadata_days: 90
    metadata_failed_days: 180
    metadata_min_per_repo: 20
    archive_tarball_days: 180
```

CLI flags still override slices of this: `--retention-days`, `--archive-days` (metadata days), `--dry-run`, `--force`. Manual runs default to **live** deletes unless you pass `--dry-run`. Cron should call `factory gc --scheduled`, which applies `gc.retention.dry_run`.

Each run appends one JSON line to `$FACTORY_HOME/gc.log` (rotated at 5 MiB) with paths, byte counts, and reasons (no secrets).

## Scheduling (supercronic)

This box uses **supercronic** and supervisord, not systemd. The scheduled gc **already runs** daily at 04:30 as supervisord program `factory-gc` (supercronic on the crontab below), with `gc.retention.dry_run: false` (live deletes). The crontab line is in [ops/supercronic/factory-gc.crontab](../ops/supercronic/factory-gc.crontab).

On the box every job has its own supercronic process under supervisord (`/workspace/ops/supervisor/conf.d/*.conf`,
one `[program:…]` per crontab, like `backup-cron` and `box-heartbeat`). To enable gc on a new box:

1. Copy the crontab to `/workspace/ops/factory-gc/crontab`.
2. Add `/workspace/ops/supervisor/conf.d/factory-gc.conf` with
   `command=/workspace/ops/bin/supercronic -quiet /workspace/ops/factory-gc/crontab`, `directory=/workspace/ops`,
   `autostart=true`, `autorestart=true` and a `stdout_logfile` under `/workspace/ops/supervisor/logs/`.
3. `supervisorctl reread && supervisorctl update`, then check `supervisorctl status factory-gc`.
4. Leave `gc.retention.dry_run: true` for the first week and read `$FACTORY_HOME/gc.log`; flip it to `false` in
   `$FACTORY_HOME/profile.yaml` only after that review.

`--scheduled` never forces and stays dry-run while the profile says so, even though the CLI otherwise defaults to live.

## Backups (restic)

Owned by a separate bot. Suggested policy:

**Exclude** (large and regenerable, or secret): `runs/*/home`, `runs/*/worktree`, `archive/runs/*/home`, `archive/runs/*/worktree`, `archive/keys`, `archive/notify.yaml*`, and the top-level `keys/`, `secrets/`, `notify.yaml` and `locks/`. Global excludes in the box profile: `*.key`, `*.pem`, `.env*`.

**Include** (small, valuable): run metadata under `runs/` (until archived), `archive/runs/*.tar.gz`, patches, events, state, `memory/`, `profile.yaml`, `*.bak`.

Legacy one-off cleanup of old `archive/runs` directories or manual worktrees outside `$FACTORY_HOME` is out of scope for `factory gc`.
