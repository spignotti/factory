import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderView } from "../../src/agents/provider-guard.js";
import { doctorCommand } from "../../src/commands/doctor.js";
import { gc } from "../../src/commands/gc.js";
import { statsReport } from "../../src/commands/stats.js";
import { statusReport } from "../../src/commands/status.js";
import { ResultSchema } from "../../src/events.js";
import { EventLineSchema, JSON_SCHEMAS, renderJsonSchema } from "../../src/schemas/json.js";
import { DoctorReportSchema, GcReportSchema, StatsReportSchema, StatusReportSchema } from "../../src/schemas/reports.js";
import { LeanOutputSchema } from "../../src/schemas/review.js";
import { MemoryFileSchema } from "../../src/memory.js";
import { addOrigin } from "../helpers/repo.js";
import { runScenario } from "../helpers/scenario.js";

const SCHEMA_DIR = join(import.meta.dirname, "..", "..", "schemas");

describe("JSON contracts", () => {
  it("schemas/*.schema.json are up to date (pnpm schemas)", () => {
    expect(readdirSync(SCHEMA_DIR).sort()).toEqual(Object.keys(JSON_SCHEMAS).sort());
    for (const name of Object.keys(JSON_SCHEMAS)) expect(readFileSync(join(SCHEMA_DIR, name), "utf8"), name).toBe(renderJsonSchema(name));
  });

  it("real outputs of a run, status, stats, gc and doctor match their schemas", async () => {
    const r = await runScenario({ script: "stalemate.json", setup: (repo) => void addOrigin(repo) });
    expect(() => ResultSchema.parse(r.resultFile)).not.toThrow();
    for (const e of r.events) EventLineSchema.parse(e);
    const memDir = join(r.factoryHome, "memory");
    const [repoDir] = readdirSync(memDir);
    MemoryFileSchema.parse(JSON.parse(readFileSync(join(memDir, repoDir!, "findings.json"), "utf8")));

    StatusReportSchema.parse(await statusReport({ factoryHome: r.factoryHome, github: r.github }));
    const stats = statsReport({ factoryHome: r.factoryHome, since: "1d" });
    StatsReportSchema.parse(stats);
    expect(stats.current.runs).toBe(1);
    r.github.prStates.set(r.result.pr!, { state: "closed", draft: true });
    GcReportSchema.parse(await gc({ factoryHome: r.factoryHome, github: r.github, dryRun: true }));

    const view: ProviderView = {
      resolve: (m) => ({ baseUrl: m.startsWith("openai/") ? "https://api.openai.com/v1" : "https://opencode.ai/inference/go/v1", api: "x" }),
      auth: (p) => ({ configured: true, subscription: p === "openai", source: "stored" }),
      modelsJsonBaseUrls: () => [],
      ping: async () => {},
    };
    let out = "";
    await doctorCommand({ factoryHome: mkdtempSync(join(tmpdir(), "fh-")), repo: r.repo, json: true, view, github: r.github, ping: true, probe: { platform: "linux", bwrap: () => true, pasta: () => true } }, { out: (s) => void (out += s), err: () => {} });
    DoctorReportSchema.parse(JSON.parse(out));
  });

  it("the lean review shape in the prompt parses", () => {
    const sample = { reviews: [{ reviewer: "plan", findings: [{ severity: "bug", claim: "x" }] }, { reviewer: "simplicity" }] };
    expect(LeanOutputSchema.parse(sample).reviews[1]).toEqual({ reviewer: "simplicity", prior: [], findings: [] });
  });
});
