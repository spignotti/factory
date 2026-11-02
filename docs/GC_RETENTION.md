# Factory gc retention

`factory gc` reclaims disk under `$FACTORY_HOME` without touching secrets, profile, or notify config.

## What it removes

| Stage | When | Paths |
| --- | --- | --- |
| Sandbox **home/** | Terminal run idle ≥ 24 h | `$FACTORY_HOME/runs/<id>/home` |
| **Worktrees** | Merged/closed PRs (existing rules); no-PR failed idle ≥ 7 d; needs_input / needs_human / base_red idle ≥ 14 d | Git worktrees; then `git worktree prune` per repo |
| **Metadata** | Idle ≥ 90 d (failed ≥ 180 d), keeping the newest 20 runs per repo | Tarball to `$FACTORY_HOME/archive/runs/<id>.tar.gz`, then drop `$FACTORY_HOME/runs/<id>/` |
| **Archive** | Tarballs/dirs under `archive/runs/` older than 180 d | Deletes tarballs; strips `home/` and `worktree/` from legacy archived run dirs first |

Never touched: `keys/`, `secrets/`, `memory/`, `archive/keys`, `archive/memory`, `*.bak`, `profile.yaml`, `notify.yaml*`, or runs that are active, or needs_input / needs_human / base_red while idle &lt; 14 days.

Guards: skip repos whose lock is held; skip when deploy-self holds its deploy lock; no `--force` on the scheduled path; dirty worktrees and branches with unpushed commits are skipped.

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

This box uses **supercronic** and supervisord, not systemd. Example crontab line (daily 04:30):

See [ops/supercronic/factory-gc.crontab](../ops/supercronic/factory-gc.crontab).

Point supercronic at your crontab file the same way as the restic backup job.

## Backups (restic)

Owned by a separate bot. Suggested policy:

**Exclude** (large, regenerable): `runs/*/home`, `runs/*/worktree`, `archive/runs/*/home`, `archive/runs/*/worktree`, `archive/keys`, `archive/notify.yaml*`.

**Include** (small, valuable): run metadata under `runs/` (until archived), `archive/runs/*.tar.gz`, patches, events, state, `memory/`, `profile.yaml`, `*.bak`.

Legacy one-off cleanup of old `archive/runs` directories or manual worktrees outside `$FACTORY_HOME` is out of scope for `factory gc`.
