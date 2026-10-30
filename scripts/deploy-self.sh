#!/usr/bin/env bash
# deploy-self.sh: versioned self-deploy of the factory CLI on a box (no cron/systemd needed).
#
#   deploy-self.sh once     check origin/main once; build + switch when it moved (default).
#                           Prints one `deploy: <result> …` line; exit 0 deployed/up_to_date,
#                           1 error/build_failed, 3 deferred (a run is active) or busy
#   deploy-self.sh daemon   loop: `once` every FACTORY_DEPLOY_INTERVAL seconds (singleton)
#   deploy-self.sh ensure   start the daemon in the background unless it already runs
#   deploy-self.sh status   print the state JSON
#
# Layout (defaults):
#   ~/.local/share/factory                     git source clone (fetch + worktrees)
#   ~/.local/share/factory-releases/<sha>      one built release per main commit (git worktree)
#   ~/.local/share/factory-releases/current -> <sha>
#   ~/.local/bin/factory -> ~/.local/share/factory-releases/current/dist/cli.js
#   ~/.local/share/factory-releases/{deploy.log,state.json,deploy-self.sh}
#
# A release is built (pnpm install --frozen-lockfile, pnpm build) and smoke-tested
# (./dist/cli.js --version, run through its shebang) in its own directory; a failed build changes nothing. The switch
# (rename of the `current` and bin symlinks) only happens when no factory run holds a live lock
# and no factory process runs; otherwise the next tick retries. Running processes are unaffected
# either way: node resolves the entry symlink to its real path, so a run started from release A
# keeps loading A's files after `current` points at B. Old releases (beyond the newest
# FACTORY_DEPLOY_KEEP) are pruned only while nothing runs.
set -euo pipefail

SRC=${FACTORY_DEPLOY_SRC:-$HOME/.local/share/factory}
REL=${FACTORY_RELEASES:-$HOME/.local/share/factory-releases}
BIN=${FACTORY_DEPLOY_BIN:-$HOME/.local/bin/factory}
LIB_LINK=${FACTORY_DEPLOY_LIB_LINK:-$HOME/.local/lib/node_modules/factory}
FHOME=${FACTORY_HOME:-$HOME/.factory}
REMOTE=${FACTORY_DEPLOY_REMOTE:-origin}
BRANCH=${FACTORY_DEPLOY_BRANCH:-main}
KEEP=${FACTORY_DEPLOY_KEEP:-3}
INTERVAL=${FACTORY_DEPLOY_INTERVAL:-300}
BUILD=${FACTORY_DEPLOY_BUILD:-pnpm install --frozen-lockfile && pnpm build}
# Factory processes that block a switch (entry via the bin link or any release/checkout dist).
PROC_RE=${FACTORY_DEPLOY_PROC_RE:-(\.local/bin/factory|factory-releases/[^ ]*/dist/cli\.js|share/factory/dist/cli\.js)( |$)}

LOG=$REL/deploy.log
STATE=$REL/state.json

mkdir -p "$REL"

log() {
  if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 1048576 ]; then mv -f "$LOG" "$LOG.1"; fi
  local line
  line="$(date -Iseconds) $*"
  printf '%s\n' "$line" >>"$LOG"
  [ -n "${FACTORY_DEPLOY_QUIET:-}" ] || printf '%s\n' "$line" >&2
}

# state KEY=VALUE... : merge string fields into state.json (atomic rename).
state() {
  command -v jq >/dev/null || return 0
  local json='{}' args=() kv
  [ -f "$STATE" ] && json=$(cat "$STATE")
  for kv in "$@"; do args+=(--arg "${kv%%=*}" "${kv#*=}"); done
  # shellcheck disable=SC2016 # jq filter, not shell
  local filter='. + $ARGS.named'
  printf '%s' "$json" | jq "${args[@]}" "$filter" >"$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"
}

# One summary line on stdout per `once`; exit codes: 0 deployed/up_to_date, 1 error/build_failed, 3 deferred/busy.
result() { printf 'deploy: %s\n' "$*"; }

die() {
  log "ERROR: $*"
  result "error: $*"
  state "last_result=error" "last_error=$*" "last_check=$(date -Iseconds)"
  exit 1
}

need_tools() {
  local t
  for t in git jq flock; do command -v "$t" >/dev/null || die "$t not found on PATH"; done
  command -v node >/dev/null || die "node not found on PATH ($(printf '%s' "$PATH")). The box may have moved and lost /usr/local; reinstall node >= 22.19 before deploying. Nothing was changed."
  node --version >/dev/null 2>&1 || die "node on PATH ($(command -v node)) does not run. Nothing was changed."
}

# Live factory lock holders (stale locks of dead pids are ignored, like the factory does).
live_locks() {
  local f pid
  [ -d "$FHOME/locks" ] || return 0
  for f in "$FHOME"/locks/*.lock; do
    [ -e "$f" ] || continue
    pid=$(head -n1 "$f" 2>/dev/null || true)
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then echo "$(basename "$f"):$pid"; fi
  done
}

factory_procs() {
  pgrep -f -- "$PROC_RE" 2>/dev/null | grep -vx "$$" || true
}

# Prints why a switch must wait, or nothing when idle.
busy_reason() {
  local locks procs
  locks=$(live_locks | tr '\n' ' ')
  procs=$(factory_procs | tr '\n' ' ')
  if [ -n "$locks" ]; then echo "live locks: $locks"; elif [ -n "$procs" ]; then echo "factory processes: $procs"; fi
}

current_sha() {
  [ -L "$REL/current" ] && basename "$(readlink "$REL/current")" || true
}

# Atomic symlink replace: build next to it, rename over it.
swap_link() {
  local target=$1 link=$2
  mkdir -p "$(dirname "$link")"
  ln -sfn "$target" "$link.deploy-tmp"
  mv -fT "$link.deploy-tmp" "$link"
}

build_release() {
  local sha=$1 dir=$REL/$1
  if [ -f "$dir/.deploy-ok" ]; then return 0; fi
  if [ -e "$dir" ]; then
    git -C "$SRC" worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"
    git -C "$SRC" worktree prune
  fi
  log "building $sha in $dir"
  git -C "$SRC" worktree add --detach "$dir" "$sha" >>"$LOG" 2>&1 || return 1
  (cd "$dir" && bash -c "$BUILD") >>"$LOG" 2>&1 || { log "build failed for $sha (see above)"; return 1; }
  # tsc does not set the exec bit that npm/pnpm bin links would; the bin link runs the file directly.
  chmod +x "$dir/dist/cli.js" 2>/dev/null || true
  local v
  v=$(cd "$dir" && ./dist/cli.js --version 2>>"$LOG") || { log "smoke test failed for $sha: ./dist/cli.js --version"; return 1; }
  log "smoke ok: $v"
  printf '%s\n' "$v" >"$dir/.deploy-ok"
}

prune() {
  local cur keep_list d name
  cur=$(current_sha)
  # `current` plus the newest KEEP-1 other built releases (by build time) stay.
  keep_list=$(find "$REL" -mindepth 2 -maxdepth 2 -name .deploy-ok -printf '%T@ %h\n' | sort -rn \
    | while read -r _ d; do name=$(basename "$d"); [ "$name" != "$cur" ] && echo "$name"; done | head -n "$((KEEP - 1))" || true)
  for d in "$REL"/*/; do
    name=$(basename "$d")
    [ "$name" = current ] && continue
    [ "$name" = "$cur" ] && continue
    grep -qx "$name" <<<"$keep_list" && continue
    [ -e "$d/.deploy-ok" ] || [ -e "$d/.git" ] || continue
    log "pruning release $name"
    git -C "$SRC" worktree remove --force "$d" >>"$LOG" 2>&1 || rm -rf "$d"
  done
  git -C "$SRC" worktree prune
}

once() {
  need_tools
  exec 9>"$REL/.deploy.lock"
  flock -n 9 || { log "another deploy is running; skipping"; result "busy: another deploy is running"; return 3; }
  [ -d "$SRC/.git" ] || die "source clone $SRC missing (git clone https://github.com/spignotti/factory.git $SRC)"

  local remote_sha cur reason
  remote_sha=$(git -C "$SRC" ls-remote "$REMOTE" "refs/heads/$BRANCH" | cut -f1) || die "git ls-remote $REMOTE $BRANCH failed"
  [ -n "$remote_sha" ] || die "no refs/heads/$BRANCH on $REMOTE"
  remote_sha=${remote_sha:0:12}
  cur=$(current_sha)
  state "last_check=$(date -Iseconds)" "remote_sha=$remote_sha" "current=$cur"

  if [ "$cur" = "$remote_sha" ] && [ "$(readlink "$BIN" 2>/dev/null)" = "$REL/current/dist/cli.js" ]; then
    state "last_result=up_to_date"
    result "up_to_date $cur ($(cat "$REL/$cur/.deploy-ok" 2>/dev/null))"
    return 0
  fi

  git -C "$SRC" fetch --quiet "$REMOTE" "$BRANCH" >>"$LOG" 2>&1 || die "git fetch $REMOTE $BRANCH failed"
  if ! build_release "$remote_sha"; then
    state "last_result=build_failed" "last_error=build of $remote_sha failed; current stays ${cur:-none}" "failed_sha=$remote_sha"
    result "build_failed $remote_sha (current stays ${cur:-none}; see $LOG)"
    return 1
  fi

  reason=$(busy_reason)
  if [ -n "$reason" ]; then
    log "release $remote_sha ready, switch deferred ($reason)"
    state "last_result=deferred" "pending=$remote_sha" "deferred_reason=$reason"
    result "deferred $remote_sha built, not switched ($reason); current stays ${cur:-none}"
    return 3
  fi

  swap_link "$remote_sha" "$REL/current"
  swap_link "$REL/current/dist/cli.js" "$BIN"
  [ -z "$LIB_LINK" ] || swap_link "$REL/current" "$LIB_LINK"
  # The daemon runs the installed copy, so it updates itself with each release.
  if [ -f "$REL/current/scripts/deploy-self.sh" ]; then
    cp "$REL/current/scripts/deploy-self.sh" "$REL/deploy-self.sh.tmp" && chmod +x "$REL/deploy-self.sh.tmp" && mv -f "$REL/deploy-self.sh.tmp" "$REL/deploy-self.sh"
  fi
  log "switched current ${cur:-none} -> $remote_sha ($(cat "$REL/$remote_sha/.deploy-ok"))"
  state "last_result=deployed" "previous=$cur" "current=$remote_sha" "deployed_at=$(date -Iseconds)" "version=$(cat "$REL/$remote_sha/.deploy-ok")" "pending=" "last_error="
  result "deployed ${cur:-none} -> $remote_sha ($(cat "$REL/$remote_sha/.deploy-ok"))"
  prune
}

daemon() {
  exec 8>"$REL/.daemon.lock"
  flock -n 8 || { echo "deploy daemon already running" >&2; return 0; }
  echo $$ >"$REL/daemon.pid"
  export FACTORY_DEPLOY_QUIET=1
  log "daemon started (pid $$, every ${INTERVAL}s)"
  while true; do
    # Each tick runs the installed copy (fresh read), falling back to this file.
    local self=$REL/deploy-self.sh
    [ -x "$self" ] || self=$0
    bash "$self" once 9>&- 8>&- || true
    sleep "$INTERVAL" 8>&- || true
  done
}

ensure() {
  if ! flock -n "$REL/.daemon.lock" true 2>/dev/null; then echo "deploy daemon running (pid $(cat "$REL/daemon.pid" 2>/dev/null))"; return 0; fi
  local self=$REL/deploy-self.sh
  [ -x "$self" ] || self=$(realpath "$0")
  # log() already writes deploy.log; stray output (bash errors) goes to daemon.out
  nohup setsid bash "$self" daemon >>"$REL/daemon.out" 2>&1 </dev/null &
  sleep 1
  echo "deploy daemon started (pid $(cat "$REL/daemon.pid" 2>/dev/null))"
}

case "${1:-once}" in
  once) once ;;
  daemon) daemon ;;
  ensure) ensure ;;
  status) [ -f "$STATE" ] && cat "$STATE" || echo '{}' ;;
  *) echo "usage: $0 [once|daemon|ensure|status]" >&2; exit 2 ;;
esac
