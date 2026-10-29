import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctorCommand, type DoctorReport } from "../../src/commands/doctor.js";
import { createFixtureRepo } from "../helpers/repo.js";

const probe = { platform: "linux" as const, bwrap: () => true, pasta: () => true };

const capture = () => {
  let out = "";
  return { io: { out: (s: string) => void (out += s), err: (s: string) => void (out += s) }, text: () => out };
};

describe("factory doctor: model layers", () => {
  it("prints the effective model per role and its layer", async () => {
    const home = mkdtempSync(join(tmpdir(), "fh-"));
    writeFileSync(join(home, "profile.yaml"), "roles:\n  pr_writer: [{ model: opencode-go/grok-4.7 }]\n");
    const c = capture();
    expect(await doctorCommand({ factoryHome: home, json: false, probe }, c.io)).toBe(0);
    expect(c.text()).toMatch(/pr_writer\s+opencode-go\/grok-4.7\s+← user/);
    expect(c.text()).toMatch(/implement\s+opencode-go\/deepseek-v4.1-flash \(high\) → opencode-go\/mimo-v2.6-flash \[capacity-only\]\s+← built-in/);
  });

  it("includes the repo layer with --repo and fails on a broken merge (JSON)", async () => {
    const home = mkdtempSync(join(tmpdir(), "fh-"));
    const repo = createFixtureRepo((c) => void (c.models = { evaluate: [{ model: "opencode-go/grok-4.7" }] }));
    const c = capture();
    expect(await doctorCommand({ factoryHome: home, repo, json: true, probe }, c.io)).toBe(0);
    const r = JSON.parse(c.text()) as DoctorReport;
    expect(r.models.find((m) => m.role === "evaluate")).toMatchObject({ layer: "repo", models: ["opencode-go/grok-4.7"] });

    const bad = createFixtureRepo((c) => void (c.models = { implement: [{ model: "openai/gpt-6-luna" }] }));
    const c2 = capture();
    expect(await doctorCommand({ factoryHome: home, repo: bad, json: true, probe }, c2.io)).toBe(1);
    expect((JSON.parse(c2.text()) as DoctorReport).checks[0]).toMatchObject({ status: "fail" });
  });

  it("reports the sandbox: required but unavailable fails, preferred degraded warns", async () => {
    const strict = mkdtempSync(join(tmpdir(), "fh-"));
    writeFileSync(join(strict, "profile.yaml"), "sandbox: required\n");
    const c = capture();
    expect(await doctorCommand({ factoryHome: strict, json: true, probe: { ...probe, pasta: () => false } }, c.io)).toBe(1);
    expect((JSON.parse(c.text()) as DoctorReport).checks.find((x) => x.name === "sandbox")).toMatchObject({ status: "fail", detail: expect.stringMatching(/pasta/) });
    const c2 = capture();
    expect(await doctorCommand({ factoryHome: mkdtempSync(join(tmpdir(), "fh-")), json: true, probe: { ...probe, pasta: () => false } }, c2.io)).toBe(0);
    expect((JSON.parse(c2.text()) as DoctorReport).checks.find((x) => x.name === "sandbox")).toMatchObject({ status: "warn", detail: expect.stringMatching(/network shared/) });
  });
});
