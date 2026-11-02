# resolve-node.sh — shared node lookup for factory shell entrypoints.
# Resolution order: FACTORY_NODE (must be executable), `command -v node`, then
# ~/.local/share/factory-node/bin/node (override with FACTORY_NODE_FALLBACK).
# Sets NODE_BIN on success; prints a one-line fix hint to stderr and returns 1 on failure.
resolve_node() {
  NODE_BIN=
  if [ -n "${FACTORY_NODE:-}" ] && [ -x "$FACTORY_NODE" ]; then
    NODE_BIN=$FACTORY_NODE
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    NODE_BIN=$(command -v node)
    return 0
  fi
  local fb=${FACTORY_NODE_FALLBACK:-$HOME/.local/share/factory-node/bin/node}
  if [ -x "$fb" ]; then
    NODE_BIN=$fb
    return 0
  fi
  printf '%s\n' "node not found: set FACTORY_NODE, put node on PATH, or install to ${fb}" >&2
  return 1
}
