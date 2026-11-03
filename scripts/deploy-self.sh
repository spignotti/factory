#!/usr/bin/env bash
# deploy-self.sh: versioned self-deploy of the factory CLI on a box (no cron/systemd needed).
#
#   deploy-self.sh once     check origin/main once; build + switch when it moved (default).
#                           Prints one `deploy: <result> …` line; exit 0 deployed/up_to_date,
#                           1 error/build_failed, 3 busy (another deploy holds the lock)
#   deploy-self.sh daemon   loop: `once` every FACTORY_DEPLOY_INTERVAL seconds (singleton)
#   deploy-self.sh ensure   start the daemon in the background unless it already runs
#   deploy-self.sh status   print the state JSON
#
# Layout (defaults):
#   ~/.local/share/factory                     git source clone (fetch + worktrees)
#   ~/.local/share/factory-releases/<sha>      one built release per main commit (git worktree)
#   ~/.local/share/factory-releases/current -> <sha>
#   ~/.local/bin/factory -> ~/.local/share/factory-releases/current/scripts/factory
#   ~/.local/share/factory-releases/{deploy.log,state.json,deploy-self.sh}
#
# A release is built (pnpm install --frozen-lockfile, pnpm build) and smoke-tested
# (./dist/cli.js --version, run through its shebang) in its own directory; a failed build changes nothing. The switch
# (rename of the `current`, bin and lib symlinks) happens as soon as that succeeds, even while factory
# runs are active. Running processes are unaffected: node resolves the entry symlink to its real path,
# so a run started from release A keeps loading A's files after `current` points at B. Old releases
# (beyond the newest FACTORY_DEPLOY_KEEP) are pruned on each check, including while runs are active,
# except a release a running process still names (command line or working directory) or that a live
# lock's process still has open. Those stay until a later check sees them unused. When a live lock's
# process cannot be inspected, nothing is pruned.
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
# Filled by collect_in_use: releases a process or live lock still uses, and why prune must wait.
IN_USE=""
PRUNE_BLOCK_REASON=""
REL_REAL=""

resolve_node_sh() {
  if [ -n "${FACTORY_RESOLVE_NODE:-}" ] && [ -f "$FACTORY_RESOLVE_NODE" ]; then printf '%s' "$FACTORY_RESOLVE_NODE"; return; fi
  if [ -f "$REL/current/scripts/resolve-node.sh" ]; then printf '%s' "$REL/current/scripts/resolve-node.sh"; return; fi
  local d; d=$(dirname "$(readlink -f "$0")")
  if [ -f "$d/resolve-node.sh" ]; then printf '%s' "$d/resolve-node.sh"; return; fi
  if [ -f "$d/scripts/resolve-node.sh" ]; then printf '%s' "$d/scripts/resolve-node.sh"; return; fi
  die "resolve-node.sh missing (reinstall factory from a checkout)"
}

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

# One summary line on stdout per `once`; exit codes: 0 deployed/up_to_date, 1 error/build_failed, 3 busy.
result() { printf 'deploy: %s\n' "$*"; }

die() {
  log "ERROR: $*"
  result "error: $*"
  state "last_result=error" "last_error=$*" "last_check=$(date -Iseconds)"
  exit 1
}

need_tools() {
  local t resolve
  for t in git jq flock; do command -v "$t" >/dev/null || die "$t not found on PATH"; done
  resolve=$(resolve_node_sh)
  # shellcheck source=resolve-node.sh
  . "$resolve"
  resolve_node || die "$(printf '%s' "node not found: set FACTORY_NODE, put node on PATH, or install to ${FACTORY_NODE_FALLBACK:-$HOME/.local/share/factory-node/bin/node}. Nothing was changed.")"
  export NODE_BIN
  "$NODE_BIN" --version >/dev/null 2>&1 || die "node at $NODE_BIN does not run. Nothing was changed."
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
  local resolve; resolve=$(resolve_node_sh)
  # shellcheck source=resolve-node.sh
  . "$resolve"
  resolve_node || { log "node not found for build"; return 1; }
  (cd "$dir" && PATH="$(dirname "$NODE_BIN"):$PATH" bash -c "$BUILD") >>"$LOG" 2>&1 || { log "build failed for $sha (see above)"; return 1; }
  # tsc does not set the exec bit that npm/pnpm bin links would; the bin link runs the file directly.
  chmod +x "$dir/dist/cli.js" 2>/dev/null || true
  local v
  chmod +x "$dir/scripts/factory" 2>/dev/null || true
  v=$("$dir/scripts/factory" --version 2>>"$LOG") || { log "smoke test failed for $sha: scripts/factory --version"; return 1; }
  log "smoke ok: $v"
  printf '%s\n' "$v" >"$dir/.deploy-ok"
}

# Release sha when $1 is a path inside a built release directory, else nothing.
path_sha() {
  local path=$1 prefix rest sha
  [ -n "$path" ] || return 0
  for prefix in "$REL" "$REL_REAL"; do
    [ -n "$prefix" ] || continue
    case "$path" in
      "$prefix"/*)
        rest=${path#"$prefix"/}
        sha=${rest%%/*}
        if [[ "$sha" =~ ^[0-9a-f]{12}$ ]]; then printf '%s\n' "$sha"; fi
        ;;
    esac
  done
}

add_in_use() {
  local sha=$1
  [[ "$sha" =~ ^[0-9a-f]{12}$ ]] || return 0
  if [ -n "$IN_USE" ] && grep -qx "$sha" <<<"$IN_USE"; then return 0; fi
  IN_USE="${IN_USE:+$IN_USE$'\n'}$sha"
}

scan_cmdline() {
  local cmdf=$1 arg sha
  [ -r "$cmdf" ] || return 0
  while IFS= read -r -d '' arg || [ -n "${arg:-}" ]; do
    [ -n "${arg:-}" ] || continue
    while IFS= read -r sha; do
      add_in_use "$sha"
    done < <(path_sha "$arg")
  done < <(cat "$cmdf" 2>/dev/null || true)
}

# /proc/<pid>/cwd is the directory inode, so a process that entered a release stays visible after the symlink moves.
scan_cwd() {
  local pid=$1 cwd sha
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
  [ -n "$cwd" ] || return 0
  while IFS= read -r sha; do
    add_in_use "$sha"
  done < <(path_sha "$cwd")
}

scan_fds() {
  local pid=$1 fd target sha
  for fd in "/proc/$pid/fd"/*; do
    [ -L "$fd" ] || continue
    target=$(readlink "$fd" 2>/dev/null || true)
    [ -n "$target" ] || continue
    while IFS= read -r sha; do
      add_in_use "$sha"
    done < <(path_sha "$target")
  done
}

# Populates IN_USE. Sets PRUNE_BLOCK_REASON when a live lock's process cannot be inspected:
# pruning then would risk deleting the release that run still uses.
collect_in_use() {
  local cmdf pid line
  IN_USE=""
  PRUNE_BLOCK_REASON=""
  REL_REAL=$(readlink -f "$REL" 2>/dev/null || true)
  [ "$REL_REAL" = "$REL" ] && REL_REAL=""
  if [ ! -d /proc ]; then
    PRUNE_BLOCK_REASON="/proc unavailable"
    return 0
  fi
  for cmdf in /proc/[0-9]*/cmdline; do
    [ -e "$cmdf" ] || continue
    scan_cmdline "$cmdf"
    pid=${cmdf#/proc/}
    pid=${pid%/cmdline}
    scan_cwd "$pid"
  done
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    pid=${line##*:}
    # /proc files report size 0, so test the content, not `-s`.
    if [ ! -r "/proc/$pid/cmdline" ] || [ -z "$(tr -d '\0' <"/proc/$pid/cmdline" 2>/dev/null | head -c1)" ]; then
      PRUNE_BLOCK_REASON="live lock ${line%%:*} pid $pid cmdline unreadable"
      return 0
    fi
    if ! readlink "/proc/$pid/cwd" >/dev/null 2>&1; then
      PRUNE_BLOCK_REASON="live lock ${line%%:*} pid $pid cwd unreadable"
      return 0
    fi
    if [ ! -d "/proc/$pid/fd" ] || [ ! -x "/proc/$pid/fd" ]; then
      PRUNE_BLOCK_REASON="live lock ${line%%:*} pid $pid fd directory unreadable"
      return 0
    fi
    scan_cmdline "/proc/$pid/cmdline"
    scan_cwd "$pid"
    scan_fds "$pid"
  done < <(live_locks)
  if [ -n "$IN_USE" ]; then IN_USE=$(printf '%s\n' "$IN_USE" | sed '/^$/d' | sort -u); fi
}

# Shas still in use, omitting $1 (the release just switched to). "none" when nothing else is.
in_use_note() {
  local skip=${1:-} line out=""
  if [ -n "$PRUNE_BLOCK_REASON" ]; then
    printf '%s' "unknown ($PRUNE_BLOCK_REASON)"
    return 0
  fi
  if [ -n "$IN_USE" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      [ -n "$skip" ] && [ "$line" = "$skip" ] && continue
      out="${out:+$out }$line"
    done <<<"$IN_USE"
  fi
  printf '%s' "${out:-none}"
}

prune() {
  local cur keep_list d name kept_extra=""
  collect_in_use
  if [ -n "$PRUNE_BLOCK_REASON" ]; then
    log "prune skipped ($PRUNE_BLOCK_REASON)"
    return 0
  fi
  cur=$(current_sha)
  # `current` plus the newest KEEP-1 other built releases (by build time) stay.
  keep_list=$(find "$REL" -mindepth 2 -maxdepth 2 -name .deploy-ok -printf '%T@ %h\n' | sort -rn \
    | while read -r _ d; do name=$(basename "$d"); [ "$name" != "$cur" ] && echo "$name"; done | head -n "$((KEEP - 1))" || true)
  for d in "$REL"/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    [ "$name" = current ] && continue
    [ "$name" = "$cur" ] && continue
    [ -n "$keep_list" ] && grep -qx "$name" <<<"$keep_list" && continue
    if [ -n "$IN_USE" ] && grep -qx "$name" <<<"$IN_USE"; then
      kept_extra="${kept_extra:+$kept_extra }$name"
      continue
    fi
    [ -e "$d/.deploy-ok" ] || [ -e "$d/.git" ] || continue
    log "pruning release $name"
    git -C "$SRC" worktree remove --force "$d" >>"$LOG" 2>&1 || rm -rf "$d"
  done
  git -C "$SRC" worktree prune
  if [ -n "$kept_extra" ]; then log "left in-use releases: $kept_extra"; fi
  return 0
}

once() {
  need_tools
  exec 9>"$REL/.deploy.lock"
  flock -n 9 || { log "another deploy is running; skipping"; result "busy: another deploy is running"; return 3; }
  [ -d "$SRC/.git" ] || die "source clone $SRC missing (git clone https://github.com/spignotti/factory.git $SRC)"

  local remote_sha cur
  remote_sha=$(git -C "$SRC" ls-remote "$REMOTE" "refs/heads/$BRANCH" | cut -f1) || die "git ls-remote $REMOTE $BRANCH failed"
  [ -n "$remote_sha" ] || die "no refs/heads/$BRANCH on $REMOTE"
  remote_sha=${remote_sha:0:12}
  cur=$(current_sha)
  state "last_check=$(date -Iseconds)" "remote_sha=$remote_sha" "current=$cur"

  if [ "$cur" = "$remote_sha" ] && [ "$(readlink "$BIN" 2>/dev/null)" = "$REL/current/scripts/factory" ]; then
    # A release kept for a run that has since exited is removed on this check, not only on the next switch.
    prune
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

  swap_link "$remote_sha" "$REL/current"
  swap_link "$REL/current/scripts/factory" "$BIN"
  [ -z "$LIB_LINK" ] || swap_link "$REL/current" "$LIB_LINK"
  # The daemon runs the installed copy, so it updates itself with each release.
  if [ -f "$REL/current/scripts/deploy-self.sh" ]; then
    cp "$REL/current/scripts/deploy-self.sh" "$REL/deploy-self.sh.tmp" && chmod +x "$REL/deploy-self.sh.tmp" && mv -f "$REL/deploy-self.sh.tmp" "$REL/deploy-self.sh"
  fi
  if [ -f "$REL/current/scripts/resolve-node.sh" ]; then
    cp "$REL/current/scripts/resolve-node.sh" "$REL/resolve-node.sh.tmp" && mv -f "$REL/resolve-node.sh.tmp" "$REL/resolve-node.sh"
  fi
  collect_in_use
  log "switched current ${cur:-none} -> $remote_sha ($(cat "$REL/$remote_sha/.deploy-ok")); in-use releases left in place: $(in_use_note "$remote_sha")"
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
