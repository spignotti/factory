import { join, resolve } from "node:path";
import { endpointViolation, isZenEndpoint, piProviderView, type ProviderView, ZEN_PROVIDER } from "../agents/provider-guard.js";
import { GhCli, type GitHub } from "../gh.js";
import { describeProfile, loadLayers, resolveProfile, withRepoModels } from "../config.js";
import { loadRepoConfig, type RepoConfig } from "../schemas/repo.js";
import type { Profile } from "../schemas/profile.js";
import type { Io } from "./gates.js";
import { createSandbox, type SandboxMode, type SandboxProbe, SandboxUnavailable } from "../sandbox/sandbox.js";
import type { z } from "zod";
import type { DoctorReportSchema } from "../schemas/reports.js";

/** `info` is a hint only (GitHub settings); only `fail` makes doctor exit 1. */
export type CheckStatus = "ok" | "warn" | "fail" | "info";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export type DoctorReport = z.infer<typeof DoctorReportSchema>;

export interface DoctorOptions {
  factoryHome: string;
  /** Sandbox probe (tests inject one). */
  probe?: SandboxProbe;
  repo?: string;
  profile?: string;
  json: boolean;
  /** Live ping of every configured model (`--ping`; real requests, counted against the subscriptions). */
  ping?: boolean;
  /** Pi model/auth view of `$FACTORY_HOME/pi` (tests inject a fake). */
  view?: ProviderView;
  github?: GitHub;
  pingTimeoutMs?: number;
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
  const icon = { ok: "✅", warn: "⚠️ ", fail: "❌", info: "ℹ️ " } as const;
  const lines = r.checks.map((c) => `${icon[c.status]} ${c.name}: ${c.detail}`);
  if (r.models.length) {
    lines.push("", "effective models (role ← layer):");
    const w = Math.max(...r.models.map((m) => m.role.length));
    for (const m of r.models) lines.push(`  ${m.role.padEnd(w)}  ${m.models.join(" → ")}  ← ${m.layer}`);
  }
  if (r.providers) lines.push("", `providers in use: ${r.providers_in_use.join(", ") || "-"}; policy: allow ${r.providers.allow.join(", ")}; deny ${r.providers.deny.join(", ") || "-"}`);
  return lines.join("\n") + "\n";
}

export function sandboxCheck(mode: SandboxMode, probe?: SandboxProbe): DoctorCheck {
  try {
    const sb = createSandbox(mode, probe);
    if (sb.mode === "off") return { name: "sandbox", status: "warn", detail: "off: agent commands run on the host" };
    const what = `${mode}: filesystem ${sb.fs}, network ${sb.net}`;
    return { name: "sandbox", status: sb.warnings.length ? "warn" : "ok", detail: [what, ...sb.warnings].join("; ") };
  } catch (e) {
    if (e instanceof SandboxUnavailable) return { name: "sandbox", status: "fail", detail: e.message };
    throw e;
  }
}

const modelsOf = (profile: Profile) => [...new Set(Object.values(profile.roles).flatMap((chain) => chain.map((e) => e.model)))].sort();
const providerOf = (model: string) => model.split("/")[0]!;

/**
 * Zen guard (Amendment e): every configured model resolved through Pi (with `models.json` overrides)
 * must stay off the Zen endpoint, `opencode` (Zen) only when the provider policy names it explicitly,
 * OpenAI only on the ChatGPT login, every provider logged in.
 */
export function zenGuardChecks(profile: Profile, view: ProviderView): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const models = modelsOf(profile);
  const providers = [...new Set(models.map(providerOf))].sort();

  const problems: string[] = [];
  const optIn: string[] = [];
  for (const model of models) {
    const resolved = view.resolve(model);
    if (!resolved) {
      problems.push(`${model} is unknown to Pi`);
      continue;
    }
    const v = endpointViolation(model, resolved.baseUrl);
    if (v) problems.push(v);
    else if (providerOf(model) === ZEN_PROVIDER) {
      if (profile.providers.allow.includes(ZEN_PROVIDER) && !profile.providers.deny.includes(ZEN_PROVIDER)) optIn.push(model);
      else problems.push(`${model} is OpenCode Zen (pay-per-use); allowed only when providers.allow names "${ZEN_PROVIDER}" explicitly`);
    } else if (providerOf(model) === "opencode-go" && !resolved.baseUrl.split("/").includes("go")) {
      problems.push(`${model} resolves to ${resolved.baseUrl}, not the OpenCode Go /go/ endpoint`);
    }
  }
  const overrides = view.modelsJsonBaseUrls().filter((o) => isZenEndpoint(o.baseUrl));
  for (const o of overrides) problems.push(`${o.path} points at the Zen endpoint ${o.baseUrl}`);
  checks.push(
    problems.length
      ? { name: "zen guard", status: "fail", detail: problems.join("; ") }
      : optIn.length
        ? { name: "zen guard", status: "warn", detail: `pay-per-use OpenCode Zen explicitly allowed and used: ${optIn.join(", ")}` }
        : { name: "zen guard", status: "ok", detail: `${models.length} models resolved; none on the Zen endpoint (opencode-go via /go/)` },
  );

  for (const provider of providers) {
    const auth = view.auth(provider);
    if (provider === "openai") {
      checks.push(
        auth.subscription
          ? { name: "openai login", status: "ok", detail: "ChatGPT login (subscription)" }
          : {
              name: "openai login",
              status: "fail",
              detail: `${auth.configured ? `credential from ${auth.source} is not the ChatGPT login (an API key bills per use)` : "not logged in"}; log in with ChatGPT: PI_CODING_AGENT_DIR=$FACTORY_HOME/pi pi, then /login`,
            },
      );
    } else if (!auth.configured) checks.push({ name: `${provider} auth`, status: "fail", detail: "no credential (Pi auth.json or provider env variable)" });
    else checks.push({ name: `${provider} auth`, status: "ok", detail: `credential from ${auth.source}` });
  }

  const subs = providers.filter((p) => p === "opencode-go" || p === "openai");
  if (subs.length) {
    checks.push({
      name: "extra usage",
      status: "warn",
      detail: `cannot be checked from here: keep "Extra Usage" (paid overage) off for ${subs.join(" and ")}, so an exhausted quota stops runs instead of billing`,
    });
  }
  return checks;
}

/** One request per configured model; only after the static guard passed. */
export async function pingChecks(profile: Profile, view: ProviderView, timeoutMs: number): Promise<DoctorCheck> {
  const failed: string[] = [];
  const models = modelsOf(profile);
  await Promise.all(
    models.map(async (model) => {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        await view.ping(model, signal);
      } catch (e) {
        failed.push(`${model}: ${signal.aborted ? `no answer within ${timeoutMs / 1000}s` : (e as Error).message.slice(0, 160)}`);
      }
    }),
  );
  failed.sort();
  return failed.length
    ? { name: "live ping", status: "warn", detail: `${models.length - failed.length}/${models.length} answered; ${failed.join("; ")}` }
    : { name: "live ping", status: "ok", detail: `${models.length}/${models.length} models answered` };
}

/**
 * GitHub (`--repo`): `gh` must be logged in; branch protection and auto-merge are hints only. Neither
 * needs admin rights nor GitHub Pro: without protection the factory still enforces its merge policy,
 * PRs just wait for a manual merge (Amendment g as amended).
 */
export async function githubChecks(github: GitHub, repoDir: string, repo: RepoConfig): Promise<DoctorCheck[]> {
  if (!(await github.authenticated(repoDir))) return [{ name: "gh", status: "fail", detail: "gh is not logged in (gh auth login)" }];
  const checks: DoctorCheck[] = [{ name: "gh", status: "ok", detail: "logged in" }];
  const s = await github.repoSettings(repoDir, repo.base_branch);
  if (s.error) return [...checks, { name: "github settings", status: "info", detail: `not readable: ${s.error}` }];
  const wantsAuto = repo.merge.auto_merge_max_risk !== "none";
  if (wantsAuto && s.auto_merge_allowed === false) {
    checks.push({ name: "auto-merge", status: "info", detail: `merge.auto_merge_max_risk is ${repo.merge.auto_merge_max_risk} but the repo does not allow auto-merge (Settings → General → Allow auto-merge); auto PRs will wait for a manual merge` });
  }
  if (s.branch_protected === false) {
    checks.push({
      name: "branch protection",
      status: "info",
      detail: `${repo.base_branch} is not protected${s.private ? " (private repos need GitHub Pro for it)" : ""}; optional: require "factory / done" once the CI stub exists`,
    });
  } else if (s.branch_protected && !(s.required_checks ?? []).includes("factory / done")) {
    checks.push({ name: "branch protection", status: "info", detail: `${repo.base_branch} is protected; "factory / done" is not a required check yet` });
  }
  return checks;
}

/** `factory doctor`: setup checks, the Zen guard and the effective model per role with its layer. */
export async function doctorCommand(opts: DoctorOptions, io: Io): Promise<number> {
  const { check, profile } = modelConfigCheck(opts);
  const checks = [check];
  if (profile) {
    checks.push(sandboxCheck(profile.sandbox, opts.probe));
    let view = opts.view;
    if (!view) {
      try {
        view = await piProviderView(join(opts.factoryHome, "pi"));
      } catch (e) {
        checks.push({ name: "zen guard", status: "fail", detail: `Pi model registry not readable: ${(e as Error).message.slice(0, 200)}` });
      }
    }
    if (view) {
      const guard = zenGuardChecks(profile, view);
      checks.push(...guard);
      if (opts.ping) {
        checks.push(
          guard.some((c) => c.status === "fail")
            ? { name: "live ping", status: "warn", detail: "skipped: fix the failed checks first (no request goes out while the guard fails)" }
            : await pingChecks(profile, view, opts.pingTimeoutMs ?? 60_000),
        );
      }
    }
  }
  if (opts.repo) {
    try {
      const repoDir = resolve(opts.repo);
      checks.push(...(await githubChecks(opts.github ?? new GhCli(), repoDir, loadRepoConfig(repoDir))));
    } catch (e) {
      checks.push({ name: "repo.yaml", status: "fail", detail: (e as Error).message.slice(0, 300) });
    }
  }
  const report: DoctorReport = {
    ok: checks.every((c) => c.status !== "fail"),
    checks,
    models: profile ? describeProfile(profile) : [],
    providers: profile?.providers,
    providers_in_use: profile ? [...new Set(modelsOf(profile).map(providerOf))].sort() : [],
  };
  io.out(opts.json ? JSON.stringify(report) + "\n" : renderDoctor(report));
  return report.ok ? 0 : 1;
}
