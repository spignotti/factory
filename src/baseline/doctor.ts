import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import picomatch from "picomatch";
import { CI_STUB_PATH } from "../ci.js";
import { sh } from "../exec.js";
import type { RepoSettings } from "../gh.js";
import type { RepoConfig } from "../schemas/repo.js";
import { resolveToolchains, type Toolchains } from "../toolchains.js";
import {
  auditLevelOk,
  baselineVersion,
  blockingAuditTexts,
  blockingJobs,
  dependabotUpdates,
  exceptionRules,
  hasImageBuild,
  ignoreLive,
  isNpmProject,
  isPnpmProject,
  isPythonProject,
  loadRuff,
  parseGitleaks,
  pyrightRank,
  RUFF_BASELINE,
  ruleCovered,
  scanText,
  SEMGREP_BASE_RULESETS,
  SEMGREP_REGISTRY,
  trivyIgnoreIssues,
  typeCheckingMode,
} from "./spec.js";

/** Same shape as `DoctorCheck`. Declared here so this module does not import the doctor command. */
export interface BaselineCheck {
  name: string;
  status: "ok" | "warn" | "fail" | "info";
  detail: string;
}

const ok = (name: string, detail: string): BaselineCheck => ({ name, status: "ok", detail });
const warn = (name: string, detail: string): BaselineCheck => ({ name, status: "warn", detail });
const fail = (name: string, detail: string): BaselineCheck => ({ name, status: "fail", detail });

const STUB_EXCLUDE = ".github/workflows/factory.yml";

function ruffChecks(dir: string, repo: RepoConfig, python: boolean): BaselineCheck[] {
  if (!python) {
    return [ok("ruff baseline", "no Python project"), ok("ruff ignores", "no Python project")];
  }
  const ruff = loadRuff(dir);
  const excused = exceptionRules(repo, "ruff");
  if (!ruff.found) {
    return [
      warn("ruff baseline", `no ruff config. Vendor templates/baseline/python/ruff-base.toml (baseline ${baselineVersion()}) and set extend = "ruff-base.toml", or select ${RUFF_BASELINE.join(",")}`),
      ok("ruff ignores", "no ruff config"),
    ];
  }
  if (ruff.missingExtend) {
    return [
      warn("ruff baseline", `extend = "${ruff.missingExtend}" was not found next to the ruff config`),
      ok("ruff ignores", "ruff extend path is missing, ignores were not judged"),
    ];
  }
  const missing = RUFF_BASELINE.filter((c) => !ruleCovered(ruff.select, c) && !ruleCovered(excused, c));
  const dead = [...ruff.ignore].filter((c) => !ignoreLive(ruff.select, c));
  return [
    missing.length
      ? warn("ruff baseline", `select is missing ${missing.join(", ")} (baseline ${baselineVersion()}: ${RUFF_BASELINE.join(", ")}). Select them, or add tool_exceptions: [{ tool: ruff, rule: <code>, reason: "..." }]`)
      : ok("ruff baseline", `select covers ${RUFF_BASELINE.join(", ")} (baseline ${baselineVersion()})${excused.length ? `; exceptions: ${excused.join(", ")}` : ""}`),
    dead.length
      ? warn("ruff ignores", `ignore lists ${dead.join(", ")}, which select does not enable. Remove the dead ignore`)
      : ok("ruff ignores", "every ignore matches a selected code"),
  ];
}

function typeCheck(dir: string, python: boolean): BaselineCheck {
  if (!python) return ok("type checker", "no Python project");
  const found = typeCheckingMode(dir);
  if (!found) {
    return warn("type checker", 'no pyright or mypy config. Set pyright typeCheckingMode to "standard" (or stricter), or mypy strict = True');
  }
  const rank = pyrightRank(found.mode);
  if (rank === undefined) return warn("type checker", `${found.tool} mode "${found.mode}" is not off|basic|standard|strict. Set typeCheckingMode to "standard"`);
  if (rank < pyrightRank("standard")!) {
    return warn("type checker", `${found.tool} is ${found.mode}, below standard. Raise it to standard (pyright) or strict (mypy)`);
  }
  return ok("type checker", `${found.tool} ${found.mode}`);
}

function semgrepCheck(dir: string, repo: RepoConfig): BaselineCheck {
  const text = scanText(dir, repo);
  const invoked = /\bsemgrep\b/.test(text);
  if (!invoked) {
    return warn("semgrep", "no semgrep command in repo.yaml checks or workflows. Add a full check: semgrep scan --metrics=off --error --disable-version-check --config p/default --config p/owasp-top-ten --config p/secrets");
  }
  const excused = exceptionRules(repo, "semgrep");
  const missing: string[] = [];
  if (!SEMGREP_BASE_RULESETS.some((r) => text.includes(r) || excused.includes(r))) missing.push("p/default or p/python");
  for (const rule of SEMGREP_REGISTRY) if (!text.includes(rule) && !excused.includes(rule)) missing.push(rule);
  const errorFlag = /--error\b/.test(text);
  if (!errorFlag) missing.push("--error");
  if (!/--metrics=off\b/.test(text)) missing.push("--metrics=off");
  return missing.length
    ? warn("semgrep", `semgrep is missing ${missing.join(", ")}. Registry rulesets run in CI; a tool_exceptions entry (tool: semgrep, rule: <ruleset>, reason) can justify a ruleset, not --error`)
    : ok("semgrep", "registry rulesets, --error, --metrics=off");
}

function trivyConfigured(text: string, dir: string): { high: boolean; exitCode: boolean; unfixed: boolean } {
  const cfg = [join(dir, "trivy.yaml"), join(dir, ".trivy.yaml")].map((p) => (existsSync(p) ? readFileSync(p, "utf8") : "")).join("\n");
  const all = `${text}\n${cfg}`;
  const high = /CRITICAL/.test(all) && /HIGH/.test(all);
  const exitCode = /--exit-code(?:\s+|=)1\b/.test(all) || /^\s*exit-code:\s*1\b/m.test(cfg);
  const unfixed = /--ignore-unfixed\b/.test(all) || /^\s*ignore-unfixed:\s*true\b/m.test(cfg);
  return { high, exitCode, unfixed };
}

function trivyCheck(dir: string, repo: RepoConfig): BaselineCheck {
  const text = scanText(dir, repo);
  const ignorePath = join(dir, ".trivyignore");
  const issues = existsSync(ignorePath) ? trivyIgnoreIssues(readFileSync(ignorePath, "utf8")) : [];
  const image = hasImageBuild(dir);
  const invoked = /\btrivy\b/.test(text) || existsSync(join(dir, "trivy.yaml"));
  if (!image && !invoked && !existsSync(ignorePath)) return ok("trivy", "no image build");
  const flags = trivyConfigured(text, dir);
  const gaps: string[] = [];
  if (!invoked) gaps.push("no trivy command (add a full check: trivy image --severity CRITICAL,HIGH --exit-code 1 --ignore-unfixed <image>)");
  else {
    if (!flags.high) gaps.push("severity must include CRITICAL and HIGH");
    if (!flags.exitCode) gaps.push("exit-code 1");
    if (!flags.unfixed) gaps.push("--ignore-unfixed");
  }
  if (issues.length) gaps.push(`.trivyignore needs a reason for ${issues.map((i) => `${i.id} (line ${i.line})`).join(", ")}`);
  return gaps.length ? warn("trivy", gaps.join("; ")) : ok("trivy", "blocks CRITICAL,HIGH with exit-code 1 and --ignore-unfixed");
}

function gitleaksCheck(dir: string, repo: RepoConfig): BaselineCheck {
  const cfg = parseGitleaks(existsSync(join(dir, ".gitleaks.toml")) ? readFileSync(join(dir, ".gitleaks.toml"), "utf8") : undefined);
  const gaps: string[] = [];
  if (cfg.present && !cfg.useDefault) gaps.push("set [extend] useDefault = true so the default rules stay on");
  for (const [i, allow] of cfg.allowlists.entries()) {
    if (!allow.description) gaps.push(`allowlist ${i + 1} has no description`);
    if (!allow.contentBound) gaps.push(`allowlist ${i + 1} is not content-bound (add regexes or regexTarget = "match")`);
  }
  const invoked = /\bgitleaks\b/.test(scanText(dir, repo));
  if (!invoked) gaps.push("no gitleaks check in repo.yaml or workflows, so CI does not scan. Add a fast check: gitleaks detect --source . --redact --no-banner");
  return gaps.length
    ? warn("gitleaks", gaps.join("; "))
    : ok("gitleaks", cfg.present ? "default rules, allowlists are content-bound, and a check runs it" : "default rules (no .gitleaks.toml) and a check runs it");
}

function dependencyAudit(dir: string, repo: RepoConfig, toolchains: Toolchains): BaselineCheck {
  const python = isPythonProject(dir, toolchains);
  const pnpm = isPnpmProject(dir, toolchains);
  const npm = isNpmProject(dir, pnpm);
  if (!python && !pnpm && !npm) return ok("dependency audit", "no Python project and no npm or pnpm lockfile");
  // repo.yaml checks and pull_request steps, including a nox session the step runs.
  const runs = blockingAuditTexts(dir, repo);
  const missing: string[] = [];
  if (python && !runs.some((r) => /\bpip-audit\b/.test(r))) missing.push("pip-audit (blocking check or CI step; a nox session that step runs counts; not || true)");
  if (pnpm && !runs.some((r) => /\bpnpm\s+audit\b/.test(r) && auditLevelOk(r))) missing.push("pnpm audit --audit-level high (low or moderate is fine; critical-only is not)");
  if (npm && !runs.some((r) => /\bnpm\s+audit\b/.test(r) && auditLevelOk(r))) missing.push("npm audit --audit-level=high");
  return missing.length
    ? fail("dependency audit", `CI does not block on ${missing.join("; ")}. Add a full check that fails the job`)
    : ok("dependency audit", [python ? "pip-audit" : "", pnpm ? "pnpm audit" : "", npm ? "npm audit" : ""].filter(Boolean).join(", "));
}

function dependabotCheck(dir: string): BaselineCheck {
  const path = join(dir, ".github", "dependabot.yml");
  const alt = join(dir, ".github", "dependabot.yaml");
  const file = existsSync(path) ? path : existsSync(alt) ? alt : undefined;
  if (!file) return ok("dependabot", "no dependabot config; nothing bumps actions inside the CI stub");
  const parsed = dependabotUpdates(readFileSync(file, "utf8"));
  if (parsed.error) return warn("dependabot", `${file} did not parse (${parsed.error})`);
  const actions = parsed.updates.filter((u) => u.ecosystem === "github-actions");
  if (!actions.length) return ok("dependabot", "no github-actions ecosystem; the CI stub is not an action update target");
  const covered = actions.every((u) => u.exclude.length > 0 && picomatch(u.exclude, { dot: true })(STUB_EXCLUDE));
  if (!covered) {
    return warn(
      "dependabot",
      `github-actions updates must skip the generated stub or a bump edits a hashed file. Under that update add:\nexclude-paths:\n  - "${CI_STUB_PATH}"`,
    );
  }
  return ok("dependabot", `${CI_STUB_PATH} is excluded from github-actions updates`);
}

function toolsCheck(present: { gitleaks: boolean; semgrep: boolean }): BaselineCheck {
  const missing = [present.gitleaks ? "" : "gitleaks", present.semgrep ? "" : "semgrep"].filter(Boolean);
  return missing.length
    ? warn("baseline tools", `${missing.join(" and ")} not on PATH. Fast gates skip a missing scanner (install them on the factory box)`)
    : ok("baseline tools", "gitleaks and semgrep are on PATH");
}

/** File and toolchain checks. `tools` defaults to probing PATH when omitted by the caller that has already probed. */
export function baselineConfigChecks(dir: string, repo: RepoConfig, tools: { gitleaks: boolean; semgrep: boolean }, toolchains?: Toolchains): BaselineCheck[] {
  const resolved = toolchains ?? resolveToolchains(dir, repo).toolchains;
  const python = isPythonProject(dir, resolved);
  return [
    ...ruffChecks(dir, repo, python),
    typeCheck(dir, python),
    semgrepCheck(dir, repo),
    trivyCheck(dir, repo),
    gitleaksCheck(dir, repo),
    dependencyAudit(dir, repo, resolved),
    dependabotCheck(dir),
    toolsCheck(tools),
  ];
}

/** Branch protection and secret scanning. Unknown GitHub fields do not fail. */
export function baselineGithubChecks(dir: string, settings: RepoSettings): BaselineCheck[] {
  const checks: BaselineCheck[] = [];
  if (settings.private === false) {
    const secretOff = settings.secret_scanning === false;
    const pushOff = settings.push_protection === false;
    if (secretOff || pushOff) {
      const which = [secretOff ? "secret scanning" : "", pushOff ? "push protection" : ""].filter(Boolean).join(" and ");
      checks.push(fail("secret scanning", `public repo has ${which} disabled. Enable both (Settings → Code security → Secret protection)`));
    } else if (settings.secret_scanning === true && settings.push_protection === true) {
      checks.push(ok("secret scanning", "secret scanning and push protection are enabled"));
    } else {
      checks.push(warn("secret scanning", "public repo, but secret scanning was not readable. Confirm secret scanning and push protection are enabled (Settings → Code security)"));
    }
  } else if (settings.private === true) {
    checks.push(ok("secret scanning", "private repository"));
  }
  if (settings.branch_protected) {
    const required = settings.required_checks ?? [];
    const missing = blockingJobs(dir).filter((j) => !required.includes(j));
    checks.push(
      missing.length
        ? warn("required checks", `branch protection does not require ${missing.join(", ")}. The stub blocks through "done"; every other pull_request job must be required too`)
        : ok("required checks", required.length ? `requires ${required.join(", ")}` : "no extra pull_request jobs"),
    );
    if (settings.strict_required_checks === false) {
      checks.push(warn("status checks strict", 'required status checks are not strict. Enable "Require branches to be up to date before merging"'));
    } else if (settings.strict_required_checks === true) {
      checks.push(ok("status checks strict", "required status checks are strict"));
    }
  }
  return checks;
}

/** `command -v` for the two fast-gate scanners. Tests pass an explicit result instead. */
export async function probeBaselineTools(): Promise<{ gitleaks: boolean; semgrep: boolean }> {
  const exists = async (bin: string) => (await sh(`command -v ${bin}`, { cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" } })).code === 0;
  return { gitleaks: await exists("gitleaks"), semgrep: await exists("semgrep") };
}
