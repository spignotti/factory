export interface DagNode {
  id: string;
  depends_on: string[];
}

/** Topological order that keeps the declared order among independent nodes. Throws on cycles. */
export function topoOrder<T extends DagNode>(nodes: T[]): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, "visiting" | "done">();
  const order: T[] = [];
  const visit = (node: T, path: string[]): void => {
    const s = state.get(node.id);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`dependency cycle: ${[...path, node.id].join(" -> ")}`);
    state.set(node.id, "visiting");
    for (const dep of node.depends_on) {
      const depNode = byId.get(dep);
      if (!depNode) throw new Error(`${node.id} depends on unknown package ${dep}`);
      visit(depNode, [...path, node.id]);
    }
    state.set(node.id, "done");
    order.push(node);
  };
  for (const node of nodes) visit(node, []);
  return order;
}

/** All nodes that transitively depend on `failed`. */
export function dependentsOf<T extends DagNode>(nodes: T[], failed: string): Set<string> {
  const out = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (out.has(node.id)) continue;
      if (node.depends_on.some((d) => d === failed || out.has(d))) {
        out.add(node.id);
        changed = true;
      }
    }
  }
  return out;
}

export type PackageStatus = "done" | "failed" | "skipped";

/**
 * Runs `exec` for every node in topological order. A failed node cascade-skips all its dependents;
 * independent nodes still run.
 */
export async function runInDagOrder<T extends DagNode>(
  nodes: T[],
  exec: (node: T) => Promise<boolean>,
): Promise<Map<string, PackageStatus>> {
  const status = new Map<string, PackageStatus>();
  const skipped = new Set<string>();
  for (const node of topoOrder(nodes)) {
    if (skipped.has(node.id)) {
      status.set(node.id, "skipped");
      continue;
    }
    const ok = await exec(node);
    status.set(node.id, ok ? "done" : "failed");
    if (!ok) for (const dep of dependentsOf(nodes, node.id)) skipped.add(dep);
  }
  return status;
}
