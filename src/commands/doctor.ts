import { resolve } from "node:path";
import { describeProfile, loadLayers, resolveProfile, withRepoModels } from "../config.js";
import { loadRepoConfig } from "../schemas/repo.js";
import type { Profile } from "../schemas/profile.js";
import type { Io } from "./gates.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  models: ReturnType<typeof describeProfile>;
  providers?: Profile["providers"];
}

export interface DoctorOptions {
  factoryHome: string;
  repo?: string;
  profile?: string;
  json: boolean;
}

/** Resolves the layered model config (with the repo layer if `--repo`), reporting errors as a failed check. */
export function modelConfigCheck(opts: DoctorOptions): { check: DoctorCheck; profile?: Profile } {
  try {
    let profile = resolveProfile(loadLayers({ factoryHome: opts.factoryHome, profile: opts.profile }));
    if (opts.repo) profile = withRepoModels(profile, loadRepoConfig(resolve(opts.repo)).models);
    return { check: { name: "model config", status: "ok", detail: "layers merged; provider policy and family rules hold" }, profile };
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    return { check: { name: "model config", status: "fail", detail: e.message } };
  }
}

export function renderDoctor(r: DoctorReport): string {
  const icon = { ok: "✅", warn: "⚠️ ", fail: "❌" } as const;
  const lines = r.checks.map((c) => `${icon[c.status]} ${c.name}: ${c.detail}`);
  if (r.models.length) {
    lines.push("", "effective models (role ← layer):");
    const w = Math.max(...r.models.map((m) => m.role.length));
    for (const m of r.models) lines.push(`  ${m.role.padEnd(w)}  ${m.models.join(" → ")}  ← ${m.layer}`);
  }
  if (r.providers) lines.push("", `providers: allow ${r.providers.allow.join(", ")}; deny ${r.providers.deny.join(", ") || "-"}`);
  return lines.join("\n") + "\n";
}

/** `factory doctor`: setup checks and the effective model per role with the layer it came from. */
export async function doctorCommand(opts: DoctorOptions, io: Io): Promise<number> {
  const { check, profile } = modelConfigCheck(opts);
  const checks = [check];
  const report: DoctorReport = {
    ok: checks.every((c) => c.status !== "fail"),
    checks,
    models: profile ? describeProfile(profile) : [],
    providers: profile?.providers,
  };
  io.out(opts.json ? JSON.stringify(report) + "\n" : renderDoctor(report));
  return report.ok ? 0 : 1;
}
