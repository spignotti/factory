import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { baselineConfigChecks, baselineGithubChecks, type BaselineCheck } from "../../src/baseline/doctor.js";
import { planBaselineGates, runBaselineGates } from "../../src/baseline/gates.js";
import { formatGateResults, skippedSecurityGates } from "../../src/steps/gates.js";
import { baselineVersion, loadRuff, parseRuffToml, RUFF_BASELINE, semgrepRulesDir } from "../../src/baseline/spec.js";
import { doctorCommand, type DoctorReport } from "../../src/commands/doctor.js";
import { FakeGitHub } from "../../src/gh.js";
import { parseRepoConfig } from "../../src/schemas/repo.js";

const tools = { gitleaks: true, semgrep: true };
const none = { python: "", pnpm: false, uv: false, node: "22", pnpm_version: "", uv_version: "" };

function tree(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "baseline-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const at = (checks: BaselineCheck[], name: string) => checks.find((c) => c.name === name);

const SEMGREP = "semgrep scan --metrics=off --error --disable-version-check --config p/default --config p/owasp-top-ten --config p/secrets";
const GITLEAKS = "gitleaks detect --source . --redact --no-banner";
const TRIVY = "trivy image --severity CRITICAL,HIGH --exit-code 1 --ignore-unfixed app";

describe("baseline templates", () => {
  it("version is 1 and the ruff template selects exactly the baseline codes", () => {
    expect(baselineVersion()).toBe("1");
    const text = readFileSync(new URL("../../templates/baseline/python/ruff-base.toml", import.meta.url), "utf8");
    expect(text).toContain("factory-baseline-version: 1");
    expect(text).toContain("line-length = 100");
    const parsed = parseRuffToml(text, false);
    expect(parsed.select).toEqual([...RUFF_BASELINE]);
    expect(parsed.perFileIgnores).toEqual(expect.arrayContaining(["S101", "S105", "S106"]));
    const loaded = loadRuff(tree({ "ruff.toml": text }));
    expect(loaded.ignore.filter((c) => !RUFF_BASELINE.some((s) => c.startsWith(s)))).toEqual([]);
  });

  it("ships semgrep rules for offline scans (no registry id, no URL)", () => {
    const dir = semgrepRulesDir();
    const ids: string[] = [];
    for (const name of ["exec.yaml", "secrets.yaml"]) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(text).not.toMatch(/https?:\/\//);
      const doc = parse(text) as { rules: { id: string }[] };
      expect(JSON.stringify(doc)).not.toMatch(/p\/default|p\/python|p\/owasp|p\/secrets/);
      ids.push(...doc.rules.map((r) => r.id));
    }
    expect(ids).toEqual([
      "factory.baseline.python-eval",
      "factory.baseline.python-shell",
      "factory.baseline.js-eval",
      "factory.baseline.aws-access-key",
      "factory.baseline.private-key",
    ]);
  });
});

describe("tool_exceptions", () => {
  it("requires a reason and rejects a duplicate", () => {
    expect(parseRepoConfig("tool_exceptions: []").tool_exceptions).toEqual([]);
    expect(() => parseRepoConfig("tool_exceptions: [{ tool: ruff, rule: S }]")).toThrow(/reason/);
    expect(() => parseRepoConfig('tool_exceptions: [{ tool: ruff, rule: S, reason: " " }]')).toThrow(/reason/);
    expect(() => parseRepoConfig('tool_exceptions:\n  - { tool: ruff, rule: S, reason: legacy }\n  - { tool: ruff, rule: S, reason: again }\n')).toThrow(/duplicate tool exception/);
  });
});

describe("doctor baseline checks", () => {
  const cfg = (yaml: string) => parseRepoConfig(yaml);

  it("ruff: pass when select covers the baseline, warn when a code is missing, pass when the exception names it", () => {
    const covered = tree({ "ruff.toml": `line-length = 100\n[lint]\nselect = [${RUFF_BASELINE.map((c) => `"${c}"`).join(", ")}]\n` });
    expect(at(baselineConfigChecks(covered, cfg(""), tools, none), "ruff baseline")!.status).toBe("ok");
    const missing = tree({ "ruff.toml": '[lint]\nselect = ["E", "F"]\n' });
    const gap = at(baselineConfigChecks(missing, cfg(""), tools, none), "ruff baseline")!;
    expect(gap.status).toBe("warn");
    expect(gap.detail).toMatch(/missing/);
    const excused = at(baselineConfigChecks(missing, cfg('tool_exceptions:\n  - { tool: ruff, rule: W, reason: later }\n  - { tool: ruff, rule: I, reason: later }\n  - { tool: ruff, rule: UP, reason: later }\n  - { tool: ruff, rule: B, reason: later }\n  - { tool: ruff, rule: S, reason: later }\n  - { tool: ruff, rule: BLE, reason: later }\n  - { tool: ruff, rule: C4, reason: later }\n  - { tool: ruff, rule: SIM, reason: later }\n  - { tool: ruff, rule: RUF, reason: later }\n  - { tool: ruff, rule: ASYNC, reason: later }\n'), tools, none), "ruff baseline")!;
    expect(excused.status).toBe("ok");
    const absent = at(baselineConfigChecks(tree({ "pyproject.toml": "[project]\nname='a'\n" }), cfg(""), tools, none), "ruff baseline")!;
    expect(absent.status).toBe("warn");
    expect(absent.detail).toMatch(/ruff-base.toml/);
  });

  it("ruff ignores: warn on a dead code, pass when the code is selected", () => {
    const dead = tree({ "ruff.toml": '[lint]\nselect = ["E"]\nignore = ["N803"]\n' });
    expect(at(baselineConfigChecks(dead, cfg(""), tools, none), "ruff ignores")).toMatchObject({ status: "warn", detail: expect.stringMatching(/N803/) });
    const live = tree({ "ruff.toml": '[lint]\nselect = ["E", "S"]\nignore = ["E501"]\n[lint.per-file-ignores]\n"tests/**" = ["S101"]\n' });
    expect(at(baselineConfigChecks(live, cfg(""), tools, none), "ruff ignores")!.status).toBe("ok");
    expect(at(baselineConfigChecks(tree(), cfg(""), tools, none), "ruff ignores")).toMatchObject({ status: "ok", detail: expect.stringMatching(/no Python/) });
  });

  it("type checker: standard and strict pass, basic and missing warn, non-python passes", () => {
    expect(at(baselineConfigChecks(tree({ "pyrightconfig.json": '{ "typeCheckingMode": "standard" }' }), cfg(""), tools, none), "type checker")).toMatchObject({ status: "ok" });
    expect(at(baselineConfigChecks(tree({ "pyrightconfig.json": '{ "typeCheckingMode": "strict" }' }), cfg(""), tools, none), "type checker")!.status).toBe("ok");
    expect(at(baselineConfigChecks(tree({ "pyrightconfig.json": '{ "typeCheckingMode": "basic" }' }), cfg(""), tools, none), "type checker")).toMatchObject({ status: "warn", detail: expect.stringMatching(/below standard/) });
    expect(at(baselineConfigChecks(tree({ "pyproject.toml": "[tool.mypy]\nstrict = True\n" }), cfg(""), tools, none), "type checker")).toMatchObject({ status: "ok", detail: expect.stringMatching(/mypy strict/) });
    expect(at(baselineConfigChecks(tree({ "pyproject.toml": "[tool.mypy]\nignore_errors = false\n" }), cfg(""), tools, none), "type checker")).toMatchObject({ status: "warn" });
    expect(at(baselineConfigChecks(tree({ "pyproject.toml": "[project]\nname='a'\n" }), cfg(""), tools, none), "type checker")).toMatchObject({ status: "warn", detail: expect.stringMatching(/no pyright or mypy/) });
    expect(at(baselineConfigChecks(tree(), cfg(""), tools, none), "type checker")!.status).toBe("ok");
  });

  it("semgrep: pass with registry rulesets and --error, warn when either is missing, exception covers a ruleset", () => {
    const repo = cfg(`checks:\n  - { name: semgrep, run: "${SEMGREP}", tier: full }\n  - { name: secrets, run: "${GITLEAKS}", tier: fast }\n`);
    expect(at(baselineConfigChecks(tree(), repo, tools, none), "semgrep")).toMatchObject({ status: "ok" });
    const noError = cfg(`checks:\n  - { name: semgrep, run: "semgrep scan --metrics=off --config p/default --config p/owasp-top-ten --config p/secrets", tier: full }\n  - { name: secrets, run: "${GITLEAKS}", tier: fast }\n`);
    expect(at(baselineConfigChecks(tree(), noError, tools, none), "semgrep")).toMatchObject({ status: "warn", detail: expect.stringMatching(/--error/) });
    const dropped = cfg(`checks:\n  - { name: semgrep, run: "semgrep scan --metrics=off --error --config p/python --config p/owasp-top-ten", tier: full }\n  - { name: secrets, run: "${GITLEAKS}", tier: fast }\ntool_exceptions:\n  - { tool: semgrep, rule: p/secrets, reason: "local rules cover secrets" }\n`);
    expect(at(baselineConfigChecks(tree(), dropped, tools, none), "semgrep")!.status).toBe("ok");
    expect(at(baselineConfigChecks(tree(), cfg(""), tools, none), "semgrep")).toMatchObject({ status: "warn", detail: expect.stringMatching(/no semgrep command/) });
  });

  it("trivy: pass when HIGH and CRITICAL block, warn without a scan or a reason, pass when there is no image", () => {
    expect(at(baselineConfigChecks(tree(), cfg(""), tools, none), "trivy")).toMatchObject({ status: "ok", detail: expect.stringMatching(/no image/) });
    const docker = tree({ Dockerfile: "FROM scratch\n" });
    expect(at(baselineConfigChecks(docker, cfg(""), tools, none), "trivy")).toMatchObject({ status: "warn", detail: expect.stringMatching(/no trivy command/) });
    const good = tree({ Dockerfile: "FROM scratch\n", ".trivyignore": "# accepted until the base image is rebuilt\nCVE-2024-0001\n" });
    expect(at(baselineConfigChecks(good, cfg(`checks:\n  - { name: trivy, run: "${TRIVY}", tier: full }\n`), tools, none), "trivy")!.status).toBe("ok");
    const bare = tree({ Dockerfile: "FROM scratch\n", ".trivyignore": "CVE-2024-0001\n" });
    const bad = at(baselineConfigChecks(bare, cfg(`checks:\n  - { name: trivy, run: "trivy image app", tier: full }\n`), tools, none), "trivy")!;
    expect(bad.status).toBe("warn");
    expect(bad.detail).toMatch(/CRITICAL/);
    expect(bad.detail).toMatch(/exit-code 1/);
    expect(bad.detail).toMatch(/CVE-2024-0001/);
  });

  it("gitleaks: pass on default rules, warn when defaults are replaced or an allowlist is a path", () => {
    const run = cfg(`checks:\n  - { name: secrets, run: "${GITLEAKS}", tier: fast }\n`);
    expect(at(baselineConfigChecks(tree(), run, tools, none), "gitleaks")).toMatchObject({ status: "ok" });
    const replaced = tree({ ".gitleaks.toml": '[[rules]]\nid = "only-mine"\n' });
    expect(at(baselineConfigChecks(replaced, run, tools, none), "gitleaks")).toMatchObject({ status: "warn", detail: expect.stringMatching(/useDefault = true/) });
    const pathOnly = tree({
      ".gitleaks.toml": '[extend]\nuseDefault = true\n\n[[allowlists]]\ndescription = "skip tests"\npaths = ["tests/"]\n',
    });
    expect(at(baselineConfigChecks(pathOnly, run, tools, none), "gitleaks")).toMatchObject({ status: "warn", detail: expect.stringMatching(/not content-bound/) });
    const bound = tree({
      ".gitleaks.toml": '[extend]\nuseDefault = true\n\n[[allowlists]]\ndescription = "docs example"\nregexTarget = "match"\nregexes = ["example-token"]\n',
    });
    expect(at(baselineConfigChecks(bound, run, tools, none), "gitleaks")!.status).toBe("ok");
    expect(at(baselineConfigChecks(tree(), cfg(""), tools, none), "gitleaks")).toMatchObject({ status: "warn", detail: expect.stringMatching(/no gitleaks check/) });
  });

  it("dependency audit: fail when the lockfile has no blocking audit, pass when it does, pass with nothing to audit", () => {
    expect(at(baselineConfigChecks(tree(), cfg(""), tools, none), "dependency audit")).toMatchObject({ status: "ok" });
    const py = tree({ "pyproject.toml": "[project]\nname='a'\n", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
    const missing = at(baselineConfigChecks(py, cfg(""), tools, none), "dependency audit")!;
    expect(missing.status).toBe("fail");
    expect(missing.detail).toMatch(/pip-audit/);
    expect(missing.detail).toMatch(/pnpm audit/);
    const swallowed = cfg('checks:\n  - { name: audit, run: "pip-audit || true", tier: full }\n  - { name: npm, run: "pnpm audit --audit-level critical", tier: full }\n');
    expect(at(baselineConfigChecks(py, swallowed, tools, none), "dependency audit")!.status).toBe("fail");
    const good = cfg('checks:\n  - { name: py, run: "pip-audit --progress-spinner off", tier: full }\n  - { name: js, run: "pnpm audit --audit-level high", tier: full }\n');
    expect(at(baselineConfigChecks(py, good, tools, none), "dependency audit")!.status).toBe("ok");
    const local = cfg('checks:\n  - { name: py, run: "pip-audit", tier: full, local_only: true }\n');
    expect(at(baselineConfigChecks(tree({ "requirements.txt": "requests==2.32.0\n" }), local, tools, none), "dependency audit")!.status).toBe("fail");
  });

  it("dependabot: pass when the stub is excluded, warn when github-actions would edit it, pass when there is no config", () => {
    expect(at(baselineConfigChecks(tree(), cfg(""), tools, none), "dependabot")).toMatchObject({ status: "ok" });
    const open = tree({ ".github/dependabot.yml": "version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /\n" });
    expect(at(baselineConfigChecks(open, cfg(""), tools, none), "dependabot")).toMatchObject({ status: "warn", detail: expect.stringMatching(/exclude-paths/) });
    const shut = tree({
      ".github/dependabot.yml": 'version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /\n    exclude-paths:\n      - ".github/workflows/factory.yml"\n',
    });
    expect(at(baselineConfigChecks(shut, cfg(""), tools, none), "dependabot")!.status).toBe("ok");
  });

  it("baseline tools: warn when a fast scanner is not on PATH", () => {
    expect(at(baselineConfigChecks(tree(), cfg(""), { gitleaks: false, semgrep: true }, none), "baseline tools")).toMatchObject({ status: "warn", detail: expect.stringMatching(/gitleaks/) });
    expect(at(baselineConfigChecks(tree(), cfg(""), tools, none), "baseline tools")!.status).toBe("ok");
  });

  it("secret scanning: fail on a public repo with it disabled, pass when enabled, warn when unreadable", () => {
    const dir = tree();
    expect(baselineGithubChecks(dir, { private: false, auto_merge_allowed: null, branch_protected: false, required_checks: [], secret_scanning: false, push_protection: true })).toMatchObject([
      { name: "secret scanning", status: "fail", detail: expect.stringMatching(/secret scanning/) },
    ]);
    expect(baselineGithubChecks(dir, { private: false, auto_merge_allowed: null, branch_protected: false, required_checks: [], secret_scanning: true, push_protection: false })[0]).toMatchObject({ status: "fail", detail: expect.stringMatching(/push protection/) });
    expect(baselineGithubChecks(dir, { private: false, auto_merge_allowed: null, branch_protected: false, required_checks: [], secret_scanning: true, push_protection: true })[0]).toMatchObject({ status: "ok" });
    expect(baselineGithubChecks(dir, { private: false, auto_merge_allowed: null, branch_protected: false, required_checks: [] })[0]).toMatchObject({ status: "warn" });
    expect(baselineGithubChecks(dir, { private: true, auto_merge_allowed: null, branch_protected: false, required_checks: [] })[0]).toMatchObject({ status: "ok", detail: expect.stringMatching(/private/) });
  });

  it("required checks: warn when a pull_request job or strict mode is missing, pass when both are set", () => {
    const dir = tree({
      ".github/workflows/factory.yml": "on: [pull_request]\njobs:\n  select: {}\n  check: {}\n  done: {}\n",
      ".github/workflows/lint.yml": "on:\n  pull_request:\njobs:\n  lint:\n    name: Lint\n",
      ".github/workflows/nightly.yml": "on:\n  schedule:\n    - { cron: '0 0 * * *' }\njobs:\n  nightly: {}\n",
    });
    const base = { private: true, auto_merge_allowed: null, branch_protected: true, required_checks: ["done"] };
    const missing = baselineGithubChecks(dir, base);
    expect(at(missing, "required checks")).toMatchObject({ status: "warn", detail: expect.stringMatching(/Lint/) });
    expect(at(missing, "status checks strict")).toBeUndefined();
    const good = baselineGithubChecks(dir, { ...base, required_checks: ["done", "Lint"], strict_required_checks: true });
    expect(at(good, "required checks")!.status).toBe("ok");
    expect(at(good, "status checks strict")).toMatchObject({ status: "ok" });
    expect(at(baselineGithubChecks(dir, { ...base, required_checks: ["done", "Lint"], strict_required_checks: false }), "status checks strict")).toMatchObject({ status: "warn", detail: expect.stringMatching(/up to date/) });
    expect(baselineGithubChecks(dir, { ...base, branch_protected: false }).some((c) => c.name === "required checks")).toBe(false);
  });
});

describe("baseline run gates", () => {
  const dir = () => tree({ "pyproject.toml": "[project]\nname='a'\n", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });

  it("fast scans the diff with shipped semgrep rules; full adds audits and workflow linters", () => {
    const fast = planBaselineGates({ tier: "fast", changed: ["src/app.py", "pnpm-lock.yaml"], baseSha: "abc1234", dir: dir(), toolchains: none });
    expect(Array.isArray(fast) ? fast.map((g) => g.name) : fast).toEqual(["gitleaks", "semgrep"]);
    if (!Array.isArray(fast)) throw new Error("expected a plan");
    const semgrep = fast[1]!.command;
    expect(semgrep).toContain("--metrics=off");
    expect(semgrep).toContain("--error");
    expect(semgrep).toContain("--disable-version-check");
    expect(semgrep).toContain(semgrepRulesDir());
    expect(semgrep).not.toMatch(/p\/default|p\/python|p\/owasp|p\/secrets/);
    expect(semgrep).toContain("src/app.py");
    expect(semgrep).not.toContain("pnpm-lock.yaml");
    expect(fast[0]!.command).toContain("--log-opts='abc1234..HEAD'");
    expect(fast[0]!.command).toContain("--redact");

    const full = planBaselineGates({
      tier: "full",
      changed: ["src/app.py", ".github/workflows/ci.yml"],
      baseSha: "abc1234",
      dir: dir(),
      toolchains: { ...none, uv: true, pnpm: true },
    });
    expect(Array.isArray(full) ? full.map((g) => g.name) : full).toEqual(["gitleaks", "semgrep", "pip-audit", "pnpm-audit", "actionlint", "zizmor"]);
    if (!Array.isArray(full)) throw new Error("expected a plan");
    expect(full.find((g) => g.name === "zizmor")!.command).toContain("--offline");
    expect(full.find((g) => g.name === "pnpm-audit")!.command).toContain("--audit-level high");
  });

  it("skips semgrep when nothing scannable changed, and does not run audits on the fast tier", () => {
    const planned = planBaselineGates({ tier: "fast", changed: ["pnpm-lock.yaml"], baseSha: "abc1234", dir: tree(), toolchains: none });
    expect(Array.isArray(planned) ? planned.map((g) => g.name) : planned).toEqual(["gitleaks"]);
    expect(planBaselineGates({ tier: "fast", changed: ["src/app.py"], baseSha: "not a sha", dir: tree(), toolchains: none })).toEqual({ error: expect.stringMatching(/sha/) });
  });

  it("a missing binary skips; a finding fails and is redacted; success passes", async () => {
    const ran: string[] = [];
    const skipped = await runBaselineGates({
      cwd: tree(),
      tier: "fast",
      changed: ["src/app.py"],
      baseSha: "abc1234",
      toolchains: none,
      timeoutMs: 1000,
      binExists: async () => false,
      run: async (command) => {
        ran.push(command);
        return { code: 0, output: "", durationMs: 0 };
      },
    });
    expect(ran).toEqual([]);
    expect(skipped.map((g) => g.ok)).toEqual([true, true]);
    expect(skipped.every((g) => g.detail.startsWith("SKIPPED"))).toBe(true);
    expect(skipped.map((g) => g.detail).join("\n")).toMatch(/not on PATH/);

    const required = await runBaselineGates({
      cwd: tree(),
      tier: "fast",
      changed: ["src/app.py"],
      baseSha: "abc1234",
      toolchains: none,
      timeoutMs: 1000,
      requireTools: true,
      binExists: async () => false,
      run: async () => {
        throw new Error("a missing binary must not run");
      },
    });
    expect(required.map((g) => g.ok)).toEqual([false, false]);
    expect(required.every((g) => g.detail.startsWith("SKIPPED"))).toBe(true);
    const asCheck = (g: { name: string; ok: boolean; detail: string }) => ({
      name: g.name,
      status: g.ok ? ("pass" as const) : ("fail" as const),
      output_tail: g.detail,
      kind: "builtin" as const,
      duration_ms: 0,
    });
    expect(skippedSecurityGates(skipped.map(asCheck))).toEqual(["gitleaks", "semgrep"]);
    expect(skippedSecurityGates(required.map(asCheck))).toEqual([]);
    expect(formatGateResults(skipped.map(asCheck))).toMatch(/^Skipped security gates: gitleaks, semgrep\n/);

    const failed = await runBaselineGates({
      cwd: tree(),
      tier: "fast",
      changed: ["src/app.py"],
      baseSha: "abc1234",
      toolchains: none,
      timeoutMs: 1000,
      secrets: ["super-secret-value"],
      binExists: async () => true,
      run: async () => ({ code: 1, output: "leak super-secret-value\n", durationMs: 1 }),
    });
    expect(failed.every((g) => !g.ok)).toBe(true);
    expect(failed.map((g) => g.detail).join("\n")).not.toContain("super-secret-value");
    expect(failed[0]!.detail).toContain("[redacted]");

    const passed = await runBaselineGates({
      cwd: tree(),
      tier: "fast",
      changed: [],
      baseSha: "abc1234",
      toolchains: none,
      timeoutMs: 1000,
      binExists: async () => true,
      run: async () => ({ code: 0, output: "", durationMs: 1 }),
    });
    expect(passed).toEqual([{ name: "gitleaks", ok: true, detail: "" }]);
  });
});

describe("doctor wires baseline failures into the exit code", () => {
  it("fails for a public repo with secret scanning off and a missing dependency audit", async () => {
    const dir = tree({ "pyproject.toml": "[project]\nname='a'\n" });
    mkdirSync(join(dir, ".factory"));
    writeFileSync(join(dir, ".factory", "repo.yaml"), "base_branch: main\n");
    const gh = new FakeGitHub();
    gh.settings = { private: false, auto_merge_allowed: false, branch_protected: false, required_checks: [], secret_scanning: false, push_protection: false };
    let out = "";
    const code = await doctorCommand({ factoryHome: mkdtempSync(join(tmpdir(), "fh-")), repo: dir, json: true, github: gh, view: { resolve: () => ({ baseUrl: "https://opencode.ai/inference/go/v1", api: "x" }), auth: () => ({ configured: true, subscription: false, source: "stored" }), modelsJsonBaseUrls: () => [], ping: async () => {} } }, { out: (s) => void (out += s), err: () => {} });
    expect(code).toBe(1);
    const report = JSON.parse(out) as DoctorReport;
    expect(report.checks.find((c) => c.name === "dependency audit")).toMatchObject({ status: "fail" });
    expect(report.checks.find((c) => c.name === "secret scanning")).toMatchObject({ status: "fail" });
    expect(out).not.toMatch(/ghp_|AKIA/);
  });
});
