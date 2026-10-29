import { describe, expect, it } from "vitest";
import { dependentsOf, runInDagOrder, topoOrder } from "../../src/pipeline/dag.js";

const nodes = [
  { id: "P3", depends_on: ["P1", "P2"] },
  { id: "P1", depends_on: [] },
  { id: "P2", depends_on: ["P1"] },
  { id: "P4", depends_on: [] },
  { id: "P5", depends_on: ["P3"] },
];

describe("DAG", () => {
  it("orders dependencies first", () => {
    expect(topoOrder(nodes).map((n) => n.id)).toEqual(["P1", "P2", "P3", "P4", "P5"]);
  });

  it("throws on cycles", () => {
    expect(() => topoOrder([{ id: "A", depends_on: ["B"] }, { id: "B", depends_on: ["A"] }])).toThrow(/cycle/);
  });

  it("finds transitive dependents", () => {
    expect([...dependentsOf(nodes, "P2")].sort()).toEqual(["P3", "P5"]);
  });

  it("cascade-skips dependents of a failed package and runs independent ones", async () => {
    const ran: string[] = [];
    const status = await runInDagOrder(nodes, async (n) => {
      ran.push(n.id);
      return n.id !== "P2";
    });
    expect(ran).toEqual(["P1", "P2", "P4"]);
    expect(Object.fromEntries(status)).toEqual({ P1: "done", P2: "failed", P3: "skipped", P4: "done", P5: "skipped" });
  });
});
