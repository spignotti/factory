#!/bin/bash
# Nightly self-update of the queue worker run by a LaunchAgent.
#
# When origin/<branch> is ahead of the checkout and the head's pull request had green checks:
# drain the worker, wait for it to exit, fast-forward, build, start it again and prove it with
# `doctor --ping`. Any failure after the fast-forward rolls back to the previous commit and its build.
# The worker is never left drained or unloaded: the EXIT trap resumes the queue and loads the agent.
#
# Settings (environment):
#   FACTORY_DIR          checkout the agent runs dist/cli.js from (default: this script's repo)
#   FACTORY_WORKER_LABEL LaunchAgent label of the worker (default: local.factory.worker)
#   FACTORY_BRANCH       branch to follow (default: main)
#   FACTORY_DRAIN_MAX    seconds to wait for live runs to finish before giving up (default: 18000)
# A commit that failed once is recorded in $FACTORY_HOME/self-update/bad-sha and not tried again.
set -uo pipefail

DIR="${FACTORY_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
LABEL="${FACTORY_WORKER_LABEL:-local.factory.worker}"
BRANCH="${FACTORY_BRANCH:-main}"
DRAIN_MAX="${FACTORY_DRAIN_MAX:-18000}"
HOME_DIR="${FACTORY_HOME:-$HOME/.factory}"
STATE="$HOME_DIR/self-update"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
CLI=(node "$DIR/dist/cli.js")

mkdir -p "$STATE"
# bash reads a script while it runs, and the fast-forward below rewrites this file: run from a copy.
if [ "${FACTORY_SELF_UPDATE_COPY:-}" != 1 ]; then
  cp "$0" "$STATE/self-update.run.sh" && FACTORY_DIR="$DIR" FACTORY_SELF_UPDATE_COPY=1 exec bash "$STATE/self-update.run.sh"
  exit 1
fi
log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

worker_pid() { launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/^\tpid = /{print $3; exit}'; }

cd "$DIR" || { log "FAIL no checkout at $DIR"; exit 1; }

if [ -n "$(git status --porcelain --untracked-files=no)" ] || [ "$(git rev-parse --abbrev-ref HEAD)" != "$BRANCH" ]; then
  log "SKIP checkout is not a clean $BRANCH"
  exit 0
fi
git fetch -q origin "$BRANCH" || { log "FAIL git fetch"; exit 1; }
prev=$(git rev-parse HEAD)
next=$(git rev-parse "origin/$BRANCH")
if [ "$prev" = "$next" ]; then log "OK up to date ($(git rev-parse --short HEAD))"; exit 0; fi
if ! git merge-base --is-ancestor "$prev" "$next"; then log "SKIP $BRANCH is not a fast-forward of origin"; exit 0; fi
if [ "$(cat "$STATE/bad-sha" 2>/dev/null)" = "$next" ]; then log "SKIP ${next:0:7} failed before"; exit 0; fi

# The head commit's pull request must have run checks, all passed or skipped.
pr=$(gh api "repos/{owner}/{repo}/commits/$next/pulls" --jq '.[0].number // empty' 2>/dev/null)
if [ -z "$pr" ]; then log "SKIP ${next:0:7} has no pull request"; exit 0; fi
checks=$(gh pr view "$pr" --json statusCheckRollup --jq '[.statusCheckRollup[] | (.conclusion // .state // "")] | if length == 0 then "none" elif all(. == "SUCCESS" or . == "SKIPPED" or . == "NEUTRAL") then "green" else "red" end' 2>/dev/null)
if [ "$checks" != "green" ]; then log "SKIP ${next:0:7} (PR #$pr) checks: ${checks:-unreadable}"; exit 0; fi

log "UPDATE ${prev:0:7} -> ${next:0:7} (PR #$pr)"

# From here on, always leave a loaded, resumed worker behind.
finish() {
  "${CLI[@]}" queue resume >/dev/null 2>&1 || log "WARN queue resume failed"
  if [ -z "$(worker_pid)" ]; then
    launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || launchctl kickstart "$DOMAIN/$LABEL" 2>/dev/null || log "WARN worker start failed"
  fi
}
trap finish EXIT

"${CLI[@]}" queue drain >/dev/null || { log "FAIL queue drain"; exit 1; }
waited=0
while [ -n "$(worker_pid)" ]; do
  if [ "$waited" -ge "$DRAIN_MAX" ]; then log "SKIP worker still busy after ${DRAIN_MAX}s; resumed, update next night"; exit 0; fi
  sleep 30; waited=$((waited + 30))
done
log "worker exited after ${waited}s"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

build() { pnpm install --frozen-lockfile >/dev/null 2>&1 && pnpm build >/dev/null 2>&1; }
prove() {
  "${CLI[@]}" queue resume >/dev/null 2>&1
  launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || return 1
  sleep 30
  [ -n "$(worker_pid)" ] || return 1
  out=$("${CLI[@]}" doctor --ping 2>&1)
  grep -q "✅ model config" <<<"$out" && grep -q "✅ live ping" <<<"$out"
}

if git merge -q --ff-only "$next" && build && prove; then
  log "OK running ${next:0:7}"
  exit 0
fi

log "FAIL ${next:0:7}; rolling back to ${prev:0:7}"
echo "$next" > "$STATE/bad-sha"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
while [ -n "$(worker_pid)" ]; do sleep 5; done
git reset -q --hard "$prev"
if build && prove; then log "ROLLBACK ok, running ${prev:0:7}"; else log "ROLLBACK FAILED: worker on ${prev:0:7} did not come up"; fi
exit 1
