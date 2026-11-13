import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FakeStep } from "../../src/agents/fake-runner.js";
import { resumeScenario, runScenario } from "../helpers/scenario.js";
import { gitIn } from "../helpers/repo.js";

const PRETTIER = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const write = args.includes("--write");
const check = args.includes("--check") || args.includes("-c");
const files = args.filter((a) => !a.startsWith("-"));
let dirty = false;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const fixed = text.split("\\n").map((line) => line.replace(/[ \\t]+$/, "")).join("\\n");
  if (fixed !== text) {
    dirty = true;
    if (write) writeFileSync(f, fixed);
  }
}
if (check && dirty) {
  console.error("prettier: trailing whitespace");
  process.exit(1);
}
`;

const HOLD = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const text = readFileSync(process.argv[2], "utf8");
if (!text.includes("multiply")) process.exit(0);
console.log(process.argv[3] || "external status: held");
process.exit(1);
`;

// A stable ShellCheck finding whose report text changes every attempt (the pid is in the line and column).
const SHELLCHECK = `#!/bin/sh
grep -q multiply src/math.js || exit 0
echo "src/math.js:$$:$$: SyntaxError: unexpected token (SC2166)"
exit 1
`;

function brokenImplement(steps: FakeStep[]): FakeStep {
  const impl = steps.find((s) => s.role === "implement" && typeof s.writes?.["src/math.js"] === "string");
  const source = impl?.writes?.["src/math.js"];
  if (!impl || typeof source !== "string") throw new Error("script has no implement write for src/math.js");
  return { ...impl, writes: { ...impl.writes, "src/math.js": source.replace("return a * b;\n}\n", "return a * b;\n") } };
}

function commitTools(repo: string, files: Record<string, string>): void {
  mkdirSync(join(repo, "tools"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const path = join(repo, "tools", name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  gitIn(repo, "add", "-A");
  gitIn(repo, "-c", "user.name=fixture", "-c", "user.email=fixture@test", "commit", "-q", "-m", "tools");
}

const ISSUE_BODY = "Add a multiply function to src/math.js.\n\nmultiply(2, 3) returns 6.\n";

function holdCheck(message?: string): (cfg: Record<string, unknown>) => void {
  const run = message ? `tools/hold src/math.js "${message}"` : "tools/hold src/math.js";
  return (cfg) => {
    const checks = cfg.checks as { name: string; run: string; tier: string; paths?: string[] }[];
    checks.push({ name: message ? "infra" : "external", run, tier: "fast", paths: ["src/**"] });
  };
}

describe("F02 recovery", () => {
  it("V05: a format error is fixed on the same head without a new plan or a second PR", async () => {
    const r = await runScenario({
      script: "clean.json",
      setup: (repo) => commitTools(repo, { prettier: PRETTIER }),
      patch: (cfg) => {
        const checks = cfg.checks as { name: string; run: string; tier: string; paths?: string[] }[];
        checks.push({ name: "format", run: "tools/prettier --check src/math.js", tier: "fast", paths: ["src/**"] });
      },
      steps: (steps) =>
        steps.map((s) => {
          if (s.role !== "implement" || !s.writes?.["src/math.js"]) return s;
          return { ...s, writes: { ...s.writes, "src/math.js": s.writes["src/math.js"].replace("return a * b;\n", "return a * b;  \n") } };
        }),
    });
    expect(r.result.result).toBe("done");
    expect(r.runner.calls.filter((c) => c.role === "plan_high")).toHaveLength(1);
    expect(r.runner.calls.filter((c) => c.role === "implement")).toHaveLength(1);
    expect(r.github.prs).toHaveLength(1);
    expect(r.events.some((e) => e.data.repair === "format")).toBe(true);
    const first = JSON.parse(r.file("gates-1.json")) as { checks: { name: string; status: string }[] };
    const second = JSON.parse(r.file("gates-2.json")) as { green: boolean; checks: { name: string; status: string }[] };
    expect(first.checks.find((c) => c.name === "format")?.status).toBe("fail");
    expect(second.green).toBe(true);
    expect(second.checks.find((c) => c.name === "format")?.status).toBe("pass");
    const math = readFileSync(join(r.result.worktree!, "src/math.js"), "utf8");
    expect(math).toContain("return a * b;");
    expect(math).not.toMatch(/[ \t]$/m);
  });

  it("V06/V07: an unknown external state does not invent a product edit, and resume keeps that", async () => {
    const r = await runScenario({
      script: "clean.json",
      setup: (repo) => commitTools(repo, { hold: HOLD }),
      patch: holdCheck(),
    });
    expect(r.result.result).toBe("needs_human");
    expect(r.result.reason).toMatch(/class=unknown/);
    expect(r.result.reason).toMatch(/attempts=1\/3/);
    expect(r.result.reason).toMatch(/checkpoint=[0-9a-f]{7,}/);
    expect(r.result.reason).toMatch(/did not change product code/);
    expect(r.runner.calls.filter((c) => c.role === "implement")).toHaveLength(1);
    expect(r.runner.calls.filter((c) => c.role === "plan_high")).toHaveLength(1);
    const math = readFileSync(join(r.result.worktree!, "src/math.js"), "utf8");
    expect(math).not.toContain("multiply");
    expect(math).not.toContain("invented");

    const r2 = await resumeScenario(r, {
      script: "clean.json",
      steps: (steps) =>
        steps.filter((s) => s.role === "implement").slice(0, 1).map((s) => ({
          ...s,
          writes: { "src/math.js": "export const invented = true;\n" },
        })),
    });
    expect(r2.result.result).toBe("needs_human");
    expect(r2.result.reason).toMatch(/class=unknown/);
    expect(r2.runner.calls.filter((c) => c.role === "implement")).toHaveLength(0);
    expect(r2.runner.calls.filter((c) => c.role.startsWith("plan"))).toHaveLength(0);
    expect(readFileSync(join(r2.result.worktree!, "src/math.js"), "utf8")).not.toContain("invented");
    expect(r2.result.branch).toBe(r.result.branch);
    expect(JSON.parse(r2.file("plan.json")).goal).toBe(JSON.parse(r.file("plan.json")).goal);
  });

  it("V07: infra is rerun once and then stopped, without a product edit", async () => {
    const r = await runScenario({
      script: "clean.json",
      setup: (repo) => commitTools(repo, { hold: HOLD }),
      patch: holdCheck("connect ETIMEDOUT"),
    });
    expect(r.result.result).toBe("needs_human");
    expect(r.result.reason).toMatch(/class=infra/);
    expect(r.result.reason).toMatch(/Do not cancel and rerun/);
    expect(r.events.filter((e) => e.data.repair === "infra_rerun")).toHaveLength(1);
    expect(r.runner.calls.filter((c) => c.role === "implement")).toHaveLength(1);
    expect(readFileSync(join(r.result.worktree!, "src/math.js"), "utf8")).not.toContain("multiply");
    const state = JSON.parse(r.file("state.json")) as { repair?: { infra_reruns?: number; class?: string } };
    expect(state.repair).toMatchObject({ infra_reruns: 1, class: "infra" });
  });

  it("V07: a restart continues the gate budget and does not start a new plan", async () => {
    const r = await runScenario({
      script: "gate-fail-fix.json",
      steps: (steps) => {
        const step = brokenImplement(steps);
        return [...steps.filter((s) => s.role !== "implement"), step, step];
      },
    });
    expect(r.result.result).toBe("failed");
    expect(r.result.reason).toMatch(/no scripted step left/);
    const state = JSON.parse(r.file("state.json")) as { repair?: { gate_attempts?: number }; branch?: string };
    expect(state.repair?.gate_attempts).toBe(2);
    expect(state.branch).toBe(r.result.branch);

    const r2 = await resumeScenario(r, {
      script: "gate-fail-fix.json",
      steps: (steps) => [brokenImplement(steps)],
    });
    expect(r2.result.result).toBe("needs_human");
    expect(r2.result.reason).toMatch(/class=code/);
    expect(r2.result.reason).toMatch(/attempts=3\/3/);
    expect(r2.result.reason).toMatch(/checkpoint=[0-9a-f]{7,}/);
    expect(r2.result.reason).toMatch(/SyntaxError/);
    expect(r2.result.reason).toMatch(/Do not open a new plan/);
    expect(r2.runner.calls.filter((c) => c.role === "implement")).toHaveLength(1);
    expect(r2.runner.calls.filter((c) => c.role.startsWith("plan"))).toHaveLength(0);
    expect(r2.result.branch).toBe(r.result.branch);
    expect(r2.result.worktree).toBe(r.result.worktree);
    expect(JSON.parse(r2.file("plan.json")).goal).toBe(JSON.parse(r.file("plan.json")).goal);
    const after = JSON.parse(r2.file("state.json")) as { repair?: { gate_attempts?: number } };
    expect(after.repair?.gate_attempts).toBe(3);
  });

  it("#181: an unchanged repeated failure escalates to a diagnostic strategy instead of repeating the prompt", async () => {
    const patch = (cfg: Record<string, unknown>) => {
      const checks = cfg.checks as { name: string; run: string; tier: string; paths?: string[] }[];
      checks.push({ name: "shellcheck", run: "tools/shcheck", tier: "fast", paths: ["src/**"] });
    };
    const brokenThrice = (steps: FakeStep[]) => {
      const step = brokenImplement(steps);
      return [...steps.filter((s) => s.role !== "implement"), step, step, step];
    };
    const r = await runScenario({
      script: "gate-fail-fix.json",
      setup: (repo) => commitTools(repo, { shcheck: SHELLCHECK }),
      patch,
      steps: brokenThrice,
    });
    expect(r.result.result).toBe("needs_human");
    const impl = r.runner.calls.filter((c) => c.role === "implement");
    expect(impl).toHaveLength(3);
    expect(impl[1]!.prompt).toContain("Gates are red");
    expect(impl[1]!.prompt).not.toContain("Unchanged failure");
    expect(impl[2]!.prompt).toContain("Unchanged failure");
    expect(r.events.some((e) => e.data.repair === "strategy" && e.data.strategy === "diagnose")).toBe(true);
    const st = JSON.parse(r.file("state.json")) as {
      repair?: { gate_attempts?: number; failure?: { signature?: string; checkpoint?: string; unchanged?: number } };
    };
    expect(st.repair?.gate_attempts).toBe(3);
    expect(st.repair?.failure?.signature).toMatch(/^[0-9a-f]{12}$/);
    expect(st.repair?.failure?.checkpoint).toMatch(/^[0-9a-f]{7,12}$/);
    expect(st.repair!.failure!.unchanged!).toBeGreaterThanOrEqual(2);
    expect(r.result.reason).toMatch(/attempts=3\/3/);
    expect(r.result.reason).toMatch(/failure=[0-9a-f]{12} unchanged=/);
    expect(r.github.prs).toHaveLength(0);
    expect(r.runner.calls.filter((c) => c.role.startsWith("plan"))).toHaveLength(1);
  });

  it("#181: resume keeps the spent budget and the same failure identity across process restart", async () => {
    const r = await runScenario({
      script: "gate-fail-fix.json",
      setup: (repo) => commitTools(repo, { shcheck: SHELLCHECK }),
      patch: (cfg: Record<string, unknown>) => {
        const checks = cfg.checks as { name: string; run: string; tier: string; paths?: string[] }[];
        checks.push({ name: "shellcheck", run: "tools/shcheck", tier: "fast", paths: ["src/**"] });
      },
      steps: (steps) => {
        const step = brokenImplement(steps);
        return [...steps.filter((s) => s.role !== "implement"), step, step];
      },
    });
    expect(r.result.result).toBe("failed");
    const before = JSON.parse(r.file("state.json")) as { repair?: { gate_attempts?: number; failure?: { signature?: string; unchanged?: number } } };
    expect(before.repair?.gate_attempts).toBe(2);
    expect(before.repair?.failure?.unchanged).toBe(2);

    const r2 = await resumeScenario(r, {
      script: "gate-fail-fix.json",
      steps: (steps) => [brokenImplement(steps)],
    });
    expect(r2.result.result).toBe("needs_human");
    const after = JSON.parse(r2.file("state.json")) as { repair?: { gate_attempts?: number; failure?: { signature?: string; unchanged?: number } } };
    expect(after.repair?.gate_attempts).toBe(3);
    expect(after.repair?.failure?.signature).toBe(before.repair?.failure?.signature);
    expect(after.repair!.failure!.unchanged!).toBeGreaterThanOrEqual(3);
    expect(r2.result.reason).toMatch(/attempts=3\/3/);
    expect(r2.result.reason).toMatch(/failure=[0-9a-f]{12} unchanged=[3-9]/);
    expect(r2.runner.calls.filter((c) => c.role.startsWith("plan"))).toHaveLength(0);
    expect(r2.result.branch).toBe(r.result.branch);
  });

  it("#181: resume applies the persisted diagnostic strategy before the next implement turn", async () => {
    const marked = `#!/bin/sh
echo "FOCUSED_CHECK_RAN"
grep -q multiply src/math.js || exit 0
echo "src/math.js:$$:$$: warning: SC2166 Don't use -a or -o."
exit 1
`;
    const r = await runScenario({
      script: "gate-fail-fix.json",
      setup: (repo) => commitTools(repo, { shcheck: marked }),
      patch: (cfg: Record<string, unknown>) => {
        const checks = cfg.checks as { name: string; run: string; tier: string; paths?: string[] }[];
        checks.push({ name: "shellcheck", run: "tools/shcheck", tier: "fast", paths: ["src/**"] });
      },
      steps: (steps) => {
        const step = brokenImplement(steps);
        return [...steps.filter((s) => s.role !== "implement"), step, step];
      },
    });
    expect(r.result.result).toBe("failed");
    const before = JSON.parse(r.file("state.json")) as { repair?: { gate_attempts?: number; failure?: { unchanged?: number } } };
    expect(before.repair?.gate_attempts).toBe(2);
    expect(before.repair?.failure?.unchanged).toBe(2);

    const r2 = await resumeScenario(r, {
      script: "gate-fail-fix.json",
      steps: (steps) => [brokenImplement(steps)],
    });
    const impl = r2.runner.calls.filter((c) => c.role === "implement");
    expect(impl).toHaveLength(1);
    expect(impl[0]!.prompt.startsWith("Unchanged failure")).toBe(true);
    expect(impl[0]!.prompt).toContain("FOCUSED_CHECK_RAN");
    expect(impl[0]!.prompt).toContain("failing_check");
    expect(r2.events.some((e) => e.data.repair === "diagnose" && e.data.executed === true)).toBe(true);
    const after = JSON.parse(r2.file("state.json")) as { repair?: { gate_attempts?: number } };
    expect(after.repair?.gate_attempts).toBe(3);
    expect(r2.result.reason).toMatch(/attempts=3\/3/);
    expect(r2.runner.calls.filter((c) => c.role.startsWith("plan"))).toHaveLength(0);
    expect(r2.github.approvedShas).toEqual([]);
  });

  it("#181: suppression, severity reduction, or a dropped gate is not a fix and does not approve", async () => {
    const marked = `#!/bin/sh
echo "FOCUSED_CHECK_RAN"
grep -q multiply src/math.js || exit 0
echo "src/math.js:$$:$$: error: SC2166 Don't use -a or -o."
exit 1
`;
    const neuter = (steps: FakeStep[]): FakeStep => {
      const step = brokenImplement(steps);
      const source = steps.map((s) => s.writes?.["src/math.js"]).find((body) => typeof body === "string" && body.endsWith("}\n"));
      if (typeof source !== "string") throw new Error("script has no closed src/math.js");
      return { ...step, writes: { ...step.writes, "src/math.js": source, "tools/shcheck": "#!/bin/sh\nexit 0\n" } };
    };
    const r = await runScenario({
      script: "gate-fail-fix.json",
      setup: (repo) => commitTools(repo, { shcheck: marked }),
      patch: (cfg: Record<string, unknown>) => {
        const checks = cfg.checks as { name: string; run: string; tier: string; paths?: string[] }[];
        checks.push({ name: "shellcheck", run: "tools/shcheck", tier: "fast", paths: ["src/**"] });
      },
      steps: (steps) => {
        const step = brokenImplement(steps);
        return [...steps.filter((s) => s.role !== "implement"), step, step, neuter(steps)];
      },
    });
    expect(r.result.result).not.toBe("done");
    expect(r.github.prs).toHaveLength(0);
    expect(r.github.approvedShas).toEqual([]);
    expect(r.result.reason).toMatch(/not a fix|dropped gate|altered|suppress|severity/);
    const gates = r.events.filter((e) => e.event === "gate_result").map((e) => e.data.check);
    expect(gates).toContain("syntax");
    expect(gates).toContain("unit");
    expect(r.runner.calls.filter((c) => c.role === "implement").at(-1)?.prompt).toContain("Unchanged failure");
    expect(r.runner.calls.filter((c) => c.role === "implement").at(-1)?.prompt).toContain("FOCUSED_CHECK_RAN");
  });

  it("#181: an interpreter-wrapped gate script rewritten to exit 0 is not a fix", async () => {
    const marked = `#!/bin/sh
echo "FOCUSED_CHECK_RAN"
grep -q multiply src/math.js || exit 0
echo "src/math.js:$$:$$: error: SC2166 Don't use -a or -o."
exit 1
`;
    const neuter = (steps: FakeStep[]): FakeStep => {
      const step = brokenImplement(steps);
      const source = steps.map((s) => s.writes?.["src/math.js"]).find((body) => typeof body === "string" && body.endsWith("}\n"));
      if (typeof source !== "string") throw new Error("script has no closed src/math.js");
      return { ...step, writes: { ...step.writes, "src/math.js": source, "tools/shcheck": "#!/bin/sh\nexit 0\n" } };
    };
    const r = await runScenario({
      script: "gate-fail-fix.json",
      setup: (repo) => commitTools(repo, { shcheck: marked }),
      patch: (cfg: Record<string, unknown>) => {
        const checks = cfg.checks as { name: string; run: string; tier: string; paths?: string[] }[];
        checks.push({ name: "shellcheck", run: "sh tools/shcheck", tier: "fast", paths: ["src/**"] });
      },
      steps: (steps) => {
        const step = brokenImplement(steps);
        return [...steps.filter((s) => s.role !== "implement"), step, step, neuter(steps)];
      },
    });
    expect(r.result.result).not.toBe("done");
    expect(r.github.prs).toHaveLength(0);
    expect(r.github.approvedShas).toEqual([]);
    expect(r.result.reason).toMatch(/altered|not a fix/);
    expect(r.runner.calls.filter((c) => c.role === "implement").at(-1)?.prompt).toContain("Unchanged failure");
  });

  it("#181: an npm test script rewritten to exit 0 is not a fix", async () => {
    const marked = `#!/bin/sh
grep -q multiply src/math.js || exit 0
echo "src/math.js:$$:$$: error: SC2166 Don't use -a or -o."
exit 1
`;
    const neuter = (steps: FakeStep[]): FakeStep => {
      const step = brokenImplement(steps);
      const source = steps.map((s) => s.writes?.["src/math.js"]).find((body) => typeof body === "string" && body.endsWith("}\n"));
      if (typeof source !== "string") throw new Error("script has no closed src/math.js");
      return {
        ...step,
        writes: {
          ...step.writes,
          "src/math.js": source,
          "package.json": JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "exit 0" } }),
        },
      };
    };
    const r = await runScenario({
      script: "gate-fail-fix.json",
      setup: (repo) => {
        const pkgPath = join(repo, "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
        pkg.scripts = { ...pkg.scripts, test: "sh tools/shcheck" };
        writeFileSync(pkgPath, JSON.stringify(pkg));
        commitTools(repo, { shcheck: marked });
      },
      patch: (cfg: Record<string, unknown>) => {
        const checks = cfg.checks as { name: string; run: string; tier: string; paths?: string[] }[];
        checks.push({ name: "shellcheck", run: "npm test", tier: "fast", paths: ["src/**"] });
      },
      steps: (steps) => {
        const step = brokenImplement(steps);
        return [...steps.filter((s) => s.role !== "implement"), step, step, neuter(steps)];
      },
    });
    expect(r.result.result).not.toBe("done");
    expect(r.github.prs).toHaveLength(0);
    expect(r.github.approvedShas).toEqual([]);
    expect(r.result.reason).toMatch(/altered|not a fix/);
  });

  it("resume keeps the checkpoint plan when the issue drops a quote", async () => {
    const r = await runScenario({
      script: "clean.json",
      options: { issue: 7 },
      setup: (repo) => commitTools(repo, { hold: HOLD }),
      patch: holdCheck(),
      github: (gh) => {
        gh.issues.set(7, { number: 7, title: "Multiply", body: ISSUE_BODY, labels: [] });
      },
    });
    expect(r.result.result).toBe("needs_human");
    const issue = r.github.issues.get(7)!;
    issue.body = "A different request.";
    const r2 = await resumeScenario(r, { script: "clean.json", steps: () => [] });
    expect(r2.result.result).toBe("needs_human");
    expect(r2.result.reason).toMatch(/dropped a planned quote/);
    expect(r2.result.reason).toMatch(/kept the checkpoint plan/);
    expect(r2.runner.calls).toEqual([]);
    expect(JSON.parse(r2.file("plan.json")).goal).toBe(JSON.parse(r.file("plan.json")).goal);
  });

  it("resume does not open another pull request when the saved one is closed", async () => {
    const r = await runScenario({ script: "stalemate.json" });
    expect(r.result.result).toBe("needs_human");
    expect(r.github.prs).toHaveLength(1);
    const url = r.github.prs[0]!.url;
    r.github.prStates.set(url, { state: "closed", draft: true });
    const r2 = await resumeScenario(r, { script: "clean.json", steps: () => [] });
    expect(r2.result.result).toBe("needs_human");
    expect(r2.result.reason).toMatch(/not opening another/);
    expect(r2.runner.calls).toEqual([]);
    expect(r.github.prs).toHaveLength(1);
    expect(r2.result.branch).toBe(r.result.branch);
  });
});
