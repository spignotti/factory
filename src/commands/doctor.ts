import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ancestorContextFiles, PI_CONTEXT_NAMES } from "../agents/context-files.js";
import { endpointViolation, isZenEndpoint, piProviderView, type ProviderView, ZEN_PROVIDER } from "../agents/provider-guard.js";
import { ciStubCheck, defaultRef, LEGACY_REQUIRED_CHECK, otherPrWorkflows, REQUIRED_CHECK } from "../ci.js";
import { describeToolchains, resolveToolchains } from "../toolchains.js";
import { GhCli, type GitHub } from "../gh.js";
import { baseRef, remotesWithCredentials, revParse, withBaseWorktree } from "../git.js";
import { describeProfile, loadLayers, resolveProfile, withRepoModels } from "../config.js";
import { loadRepoConfig, REPO_CONFIG_PATH, type RepoConfig } from "../schemas/repo.js";
import type { Profile } from "../schemas/profile.js";
import type { Io } from "./gates.js";
import { createSandbox, gitCommonDir, type Sandbox, type SandboxMode, type SandboxProbe, SandboxUnavailable } from "../sandbox/sandbox.js";
import { mkdtempSync, rmSync, statfsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildAgentEnv, prepareAgentHome } from "../agents/env.js";
import { sh, tail } from "../exec.js";
import { Services } from "../services.js";
import { browsersPath, findHeadlessShell, INSTALL_HINT, knownDevice } from "../evaluate/browser.js";
import type { z } from "zod";
import type { DoctorReportSchema } from "../schemas/reports.js";
import { type Context7Client, context7Probe } from "../docs/context7.js";
import { redact } from "../events.js";
import { notifyChecks } from "../notify.js";
import { defaultSecretsFile, isInside, looseMode, MIN_REDACT_LENGTH, type ResolvedSecrets, resolveSecrets, SecretsError, secretsFile } from "../secrets.js";

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
  /** `--services`: start and stop every service and the ui once in a clean base worktree. */
  services?: boolean;
  /** Context7 client of `docs_lookup` (the CLI passes one; absent = not checked). */
  context7?: Context7Client;
  /** Filesystem usage (tests inject one). */
  statfs?: (p: string) => FsUsage;
}

/** Filesystem numbers `diskChecks` needs (a subset of `fs.statfsSync`). */
export interface FsUsage {
  blocks: number;
  bfree: number;
  bavail: number;
  files: number;
  ffree: number;
}

export const DISK_WARN_PCT = 85;
export const DISK_FAIL_PCT = 95;

/**
 * Space and inode usage of the filesystem(s) holding `$FACTORY_HOME` and the temp dir: warn at 85 %, fail at
 * 95 % (worktrees, dependency folders and test fixtures are inode-heavy; on 31.10 the box ran out of inodes).
 * Space is computed like `df` (used / (used + available to unprivileged users)).
 */
export function diskChecks(paths: string[], statfs: (p: string) => FsUsage = statfsSync, devOf: (p: string) => number | bigint = (p) => statSync(p).dev): DoctorCheck[] {
  const seen = new Map<string, string[]>();
  for (const p of paths) {
    let key: string;
    try {
      key = String(devOf(p));
    } catch {
      continue;
    }
    seen.set(key, [...(seen.get(key) ?? []), p]);
  }
  const checks: DoctorCheck[] = [];
  for (const group of seen.values()) {
    const where = group.join(", ");
    try {
      const s = statfs(group[0]!);
      const used = s.blocks - s.bfree;
      const spacePct = used + s.bavail > 0 ? Math.round((used / (used + s.bavail)) * 100) : 0;
      const inodePct = s.files > 0 ? Math.round(((s.files - s.ffree) / s.files) * 100) : null; // 0 = no fixed inode table
      const worst = Math.max(spacePct, inodePct ?? 0);
      const status = worst >= DISK_FAIL_PCT ? "fail" : worst >= DISK_WARN_PCT ? "warn" : "ok";
      const detail = `${where}: space ${spacePct}%, inodes ${inodePct === null ? "n/a" : `${inodePct}% (${s.files - s.ffree}/${s.files})`}`;
      checks.push({ name: "disk", status, detail: status === "ok" ? detail : `${detail}; free up space (factory gc, old worktrees, package caches)` });
    } catch (e) {
      checks.push({ name: "disk", status: "warn", detail: `${where}: usage unknown (${(e as Error).message.slice(0, 120)})` });
    }
  }
  return checks;
}

/** Resolves the layered model config (with the repo layer if `--repo`), reporting errors as a failed check. */
export function modelConfigCheck(opts: DoctorOptions): { check: DoctorCheck; profile?: Profile } {
  try {
    let profile = resolveProfile(loadLayers({ factoryHome: opts.factoryHome, profile: opts.profile }));
    // A missing repo.yaml is reported by the repo check; the other layers are still shown.
    if (opts.repo && existsSync(join(resolve(opts.repo), REPO_CONFIG_PATH))) profile = withRepoModels(profile, loadRepoConfig(resolve(opts.repo)).models);
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
 * Zen guard: every configured model resolved through Pi (with `models.json` overrides)
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
 * PRs just wait for a manual merge.
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
  const required = s.required_checks ?? [];
  if (s.branch_protected === false) {
    checks.push({
      name: "branch protection",
      status: "info",
      detail: `${repo.base_branch} is not protected${s.private ? " (private repos need GitHub Pro for it)" : ""}; optional: require the status check "${REQUIRED_CHECK}" once the CI stub exists`,
    });
  } else if (s.branch_protected && required.includes(LEGACY_REQUIRED_CHECK) && !required.includes(REQUIRED_CHECK)) {
    checks.push({
      name: "branch protection",
      status: "warn",
      detail: `${repo.base_branch} requires "${LEGACY_REQUIRED_CHECK}", which no check run reports, so every PR stays blocked; require "${REQUIRED_CHECK}" (the stub's job name) instead`,
    });
  } else if (s.branch_protected && !required.includes(REQUIRED_CHECK)) {
    checks.push({ name: "branch protection", status: "info", detail: `${repo.base_branch} is protected; "${REQUIRED_CHECK}" is not a required check yet` });
  }
  return checks;
}

/** CI stub hash and other workflows gating pull requests (hint). */
export function ciChecks(repoDir: string, repo: RepoConfig, currentRef = defaultRef()): DoctorCheck[] {
  const stub = ciStubCheck(repoDir, undefined, currentRef);
  const checks: DoctorCheck[] = [{ name: "ci stub", ...stub }];
  const { toolchains, notes } = resolveToolchains(repoDir, repo);
  checks.push({ name: "ci toolchains", status: notes.length ? "warn" : "ok", detail: `${describeToolchains(toolchains)} (${repo.ci?.toolchains ? "repo.yaml ci.toolchains + detected" : "detected"})${notes.length ? `; ${notes.join("; ")}` : ""}` });
  if (repo.base_branch !== "main") {
    checks.push({ name: "ci stub", status: "warn", detail: `base_branch is ${repo.base_branch}; the stub's push trigger and default base are main` });
  }
  const others = otherPrWorkflows(repoDir);
  if (others.length) {
    checks.push({ name: "other workflows", status: "info", detail: `${others.join(", ")} also run on pull requests; checks there are unknown to repo.yaml (move them into repo.yaml checks, or keep them out of required statuses)` });
  }
  return checks;
}

/**
 * Evaluator prerequisites for a repo with `ui`: the Chromium headless shell, known
 * Playwright device names, ffmpeg for the session GIF (without it the PR gets the video only).
 */
export function evaluatorChecks(repo: RepoConfig, env: { shell: string | undefined; browsers: string; ffmpeg: boolean }): DoctorCheck[] {
  if (!repo.ui) return [];
  const unknown = repo.ui.devices.filter((d) => !knownDevice(d));
  return [
    env.shell ? { name: "browser", status: "ok", detail: `headless shell ${env.shell}` } : { name: "browser", status: "fail", detail: `no Chromium headless shell under ${env.browsers}; evaluate stops runs with needs_human (install: ${INSTALL_HINT})` },
    unknown.length ? { name: "ui devices", status: "fail", detail: `unknown Playwright device ${unknown.join(", ")}` } : { name: "ui devices", status: "ok", detail: repo.ui.devices.join(", ") },
    env.ffmpeg ? { name: "ffmpeg", status: "ok", detail: "session GIFs" } : { name: "ffmpeg", status: "warn", detail: "not found: evaluator sessions get a video but no GIF preview" },
  ];
}

/** Static service/ui checks: what runs unsandboxed, what nothing uses. */
export function serviceConfigChecks(repo: RepoConfig): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const used = new Set([...repo.checks.flatMap((c) => c.services ?? []), ...(repo.ui?.services ?? [])]);
  for (const svc of repo.services) {
    if (svc.host) checks.push({ name: `service ${svc.name}`, status: "warn", detail: "host: true: starts outside the sandbox, in the run worktree the agents write (residual risk)" });
    if (!used.has(svc.name)) checks.push({ name: `service ${svc.name}`, status: "info", detail: "no check or ui needs it; it never starts" });
  }
  return checks;
}

/**
 * Live service/ui check (`--services`: services start/stop, ui reachable): setup, then every
 * service and the ui started (ready probe) and stopped once, in a clean detached worktree of the base,
 * with the same sandbox and env allowlist as a run. Never touches the user's checkout.
 */
export async function liveServiceChecks(repoDir: string, repo: RepoConfig, factoryHome: string, sandbox: Sandbox, secrets?: ResolvedSecrets): Promise<DoctorCheck[]> {
  const names = [...repo.services.map((s) => s.name), ...(repo.ui ? ["ui"] : [])];
  if (!names.length) return [];
  const tmp = mkdtempSync(join(tmpdir(), "factory-doctor-"));
  const runId = `doctor-${process.pid}-${Date.now()}`;
  const checks: DoctorCheck[] = [];
  try {
    const sha = await revParse(repoDir, await baseRef(repoDir, repo.base_branch));
    await withBaseWorktree(repoDir, sha, join(tmp, "wt"), async (wt) => {
      const home = prepareAgentHome(tmp);
      const base = buildAgentEnv(process.env, { home, extra: repo.agent_env, exclude: secrets?.names ?? [] });
      // Services get the repo secrets like in a run; setup does not.
      const env = { ...base, ...(secrets?.env ?? {}) };
      const common = gitCommonDir(wt);
      const jail = sandbox.mode === "off" ? undefined : { sandbox, rw: [wt, home], ro: common ? [common] : [], hide: [factoryHome, ...(secrets?.files ?? [])] };
      if (repo.setup) {
        const setup = await sh(repo.setup, { cwd: wt, env: base, jail, timeoutMs: 15 * 60_000 });
        if (setup.code !== 0) {
          checks.push({ name: "services", status: "fail", detail: `setup failed in a clean base worktree: ${tail(setup.output, 5)}` });
          return;
        }
      }
      for (const name of names) {
        const services = new Services(repo, { runId, logDir: join(tmp, "services"), cwd: wt, env, factoryHome, jail });
        const t0 = Date.now();
        try {
          await services.ensure(name === "ui" ? [...(repo.ui?.services ?? []), "ui"] : [name]);
          const what = name === "ui" ? `reachable at ${await services.expand(repo.ui!.url)}` : "started";
          checks.push({ name: name === "ui" ? "ui" : `service ${name}`, status: "ok", detail: `${what} in ${Math.round((Date.now() - t0) / 100) / 10}s and stopped` });
        } catch (e) {
          checks.push({ name: name === "ui" ? "ui" : `service ${name}`, status: "fail", detail: redact((e as Error).message, secrets?.redact ?? []).slice(0, 600) });
        } finally {
          await services.stopAll();
        }
      }
    });
  } catch (e) {
    checks.push({ name: "services", status: "fail", detail: (e as Error).message.slice(0, 300) });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return checks;
}

/**
 * Context files outside the worktree that plain Pi would load (its agent dir, the ancestors of the
 * run worktrees) and an `AGENTS.override.md` in the repo. The factory ignores them all; the warning
 * is so nobody edits one and expects it to reach the agents.
 */
export function contextFileChecks(factoryHome: string, repoDir?: string): DoctorCheck[] {
  const stray = [
    ...PI_CONTEXT_NAMES.map((n) => join(factoryHome, "pi", n)).filter((p) => existsSync(p)),
    ...ancestorContextFiles(join(factoryHome, "runs", "_"), {}),
  ];
  const checks: DoctorCheck[] = [
    stray.length
      ? { name: "agent context", status: "warn", detail: `ignored context file(s) outside the worktree: ${[...new Set(stray)].join(", ")}; agents read only the worktree's AGENTS.md` }
      : { name: "agent context", status: "ok", detail: "agents read only the worktree's AGENTS.md" },
  ];
  if (repoDir && existsSync(join(repoDir, "AGENTS.override.md"))) {
    checks.push({ name: "agent context", status: "warn", detail: "AGENTS.override.md is ignored; put its rules into AGENTS.md" });
  }
  return checks;
}

/**
 * repo.yaml `secrets:`: the file (env_file, or the wrapper's credentials) exists outside the repo with
 * mode 0600, and every name resolves. Reports names and counts only, never a value.
 */
export async function secretsChecks(repoDir: string, repo: RepoConfig, factoryHome: string, parentEnv: NodeJS.ProcessEnv = process.env): Promise<{ checks: DoctorCheck[]; resolved?: ResolvedSecrets }> {
  const cfg = repo.secrets;
  if (!cfg) return { checks: [] };
  const checks: DoctorCheck[] = [];
  const file = secretsFile(cfg, repoDir, factoryHome);
  const what = cfg.provider === "env_file" ? "secrets file" : "secrets credentials";
  if (file) {
    if (isInside(repoDir, file)) checks.push({ name: what, status: "fail", detail: `${file} is inside the repo; move it outside (agents work in the repo)` });
    else if (!existsSync(file)) checks.push({ name: what, status: "fail", detail: `${file} is missing (create it with mode 0600: install -m 600 /dev/null ${file})` });
    else if (looseMode(file)) checks.push({ name: what, status: "fail", detail: `${file} is readable by group or others (chmod 600 ${file})` });
    else checks.push({ name: what, status: "ok", detail: `${file} (0600, outside the repo)` });
  } else if (cfg.provider === "command") {
    checks.push({ name: what, status: "info", detail: "none: the wrapper uses its own login (credentials: <file> for a per-repo machine identity)" });
  }
  if (cfg.provider === "env_file" && !cfg.path) {
    const d = defaultSecretsFile(repoDir, factoryHome);
    if (d.legacy) checks.push({ name: "secrets file name", status: "warn", detail: `${d.legacy} is named after the checkout directory; rename it to ${d.preferred} (the default now follows the repo name from the origin URL)` });
  }
  const both = cfg.names.filter((n) => repo.agent_env.includes(n));
  if (both.length) checks.push({ name: "secrets", status: "warn", detail: `${both.join(", ")} also in agent_env: never passed to agents (secrets win)` });
  if (checks.some((c) => c.status === "fail")) return { checks };
  try {
    const r = await resolveSecrets(cfg, { repoDir, factoryHome, parentEnv });
    const found = cfg.names.length - r.missing.length;
    checks.push(
      r.missing.length
        ? { name: "secrets", status: "fail", detail: `${found}/${cfg.names.length} names resolve via ${cfg.provider}; missing: ${r.missing.join(", ")}` }
        : { name: "secrets", status: "ok", detail: `${found}/${cfg.names.length} names resolve via ${cfg.provider} (values not shown; checks, services and the ui get them, agents never)` },
    );
    if (r.short.length) checks.push({ name: "secrets", status: "warn", detail: `${r.short.join(", ")} shorter than ${MIN_REDACT_LENGTH} characters: not redacted from logs` });
    return { checks, resolved: r.missing.length ? undefined : r };
  } catch (e) {
    if (!(e instanceof SecretsError)) throw e;
    checks.push({ name: "secrets", status: "fail", detail: e.message });
    return { checks };
  }
}

/** Context7 behind `docs_lookup`: reachable, and the key accepted when `CONTEXT7_API_KEY` is set. */
export async function docsLookupCheck(client: Context7Client, roles: readonly string[]): Promise<DoctorCheck> {
  if (!roles.length) return { name: "docs_lookup", status: "info", detail: "off (profile docs_lookup.roles is empty)" };
  const probe = await context7Probe(client);
  return { name: "docs_lookup", status: probe.status, detail: `Context7 for ${roles.join(", ")}: ${probe.detail}` };
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
  checks.push(...diskChecks([opts.factoryHome, tmpdir()], opts.statfs));
  checks.push(...contextFileChecks(opts.factoryHome, opts.repo ? resolve(opts.repo) : undefined));
  if (opts.context7 && profile) checks.push(await docsLookupCheck(opts.context7, profile.docs_lookup.roles));
  checks.push(...(await notifyChecks(opts.factoryHome, opts.repo ? resolve(opts.repo) : undefined)));
  if (opts.repo) {
    try {
      const repoDir = resolve(opts.repo);
      const leaky = await remotesWithCredentials(repoDir);
      checks.push(
        leaky.length
          ? { name: "git remotes", status: "fail", detail: `credentials embedded in the URL of remote ${leaky.join(", ")}; agents can read .git/config inside the sandbox. Use gh's credential helper (gh auth setup-git) and a plain URL` }
          : { name: "git remotes", status: "ok", detail: "no credentials in remote URLs" },
      );
      const repo = loadRepoConfig(repoDir);
      checks.push(...ciChecks(repoDir, repo));
      checks.push(...serviceConfigChecks(repo));
      const sec = await secretsChecks(repoDir, repo, opts.factoryHome);
      checks.push(...sec.checks);
      if (repo.ui) checks.push(...evaluatorChecks(repo, { shell: findHeadlessShell(), browsers: browsersPath(), ffmpeg: (await sh("command -v ffmpeg", { cwd: repoDir, env: { PATH: process.env.PATH ?? "" } })).code === 0 }));
      if (opts.services && profile) {
        try {
          checks.push(...(await liveServiceChecks(repoDir, repo, opts.factoryHome, createSandbox(profile.sandbox, opts.probe), sec.resolved)));
        } catch (e) {
          checks.push({ name: "services", status: "fail", detail: `not started: ${(e as Error).message}` });
        }
      } else if (repo.services.length || repo.ui) {
        checks.push({ name: "services", status: "info", detail: "not started; doctor --repo <path> --services starts and stops each service and the ui once" });
      }
      checks.push(...(await githubChecks(opts.github ?? new GhCli(), repoDir, repo)));
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
      checks.push({ name: "repo.yaml", status: "fail", detail: missing ? `${REPO_CONFIG_PATH} is missing (write it by hand or run \`factory adopt\`)` : (e as Error).message.slice(0, 300) });
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
