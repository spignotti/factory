import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { git } from "./git.js";
import { aggregateCheckRuns, type CheckRunView } from "./pipeline/ci-status.js";

const execFileP = promisify(execFile);

export type BaseStatus = "green" | "red" | "pending" | "none";

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

export interface PrRequest {
  repoDir: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  /** Labels to add (created if missing). */
  labels?: string[];
}

/** Everything the factory does on GitHub. Only the factory process calls it. */
export interface GitHub {
  baseStatus(repoDir: string, sha: string): Promise<BaseStatus>;
  getIssue(repoDir: string, n: number): Promise<Issue>;
  push(repoDir: string, branch: string): Promise<void>;
  createPr(req: PrRequest): Promise<string>;
  /** Sha of `branch` on origin, null when it does not exist there. Throws when origin cannot be asked. */
  remoteBranchSha(repoDir: string, branch: string): Promise<string | null>;
  /** The open PR whose head is `branch` (same repo), null when there is none. */
  findOpenPr(repoDir: string, branch: string): Promise<OpenPr | null>;
  enableAutoMerge(repoDir: string, pr: string): Promise<void>;
  /** Adds a label to a PR, creating it if missing; best effort. */
  addLabel(repoDir: string, pr: string, label: string): Promise<void>;
  /** Resume: refresh title/body of the run's existing PR. */
  updatePr(repoDir: string, pr: string, update: { title: string; body: string }): Promise<void>;
  /** Resume: a draft PR whose run is now done becomes ready for review. */
  markReady(repoDir: string, pr: string): Promise<void>;
  /** A ready PR whose run is not done, or whose next push must stay cheap, becomes a draft. */
  markDraft(repoDir: string, pr: string): Promise<void>;
  /** `status` / `gc`: current state of a factory PR. */
  prStatus(repoDir: string, pr: string): Promise<PrStatus>;
  /** `doctor`: is `gh` logged in (no token is read or printed)? */
  authenticated(repoDir: string): Promise<boolean>;
  /** `doctor` hints; readable without admin rights. Unknown values are null. */
  repoSettings(repoDir: string, branch: string): Promise<RepoSettings>;
  /** `harden` CI audit: workflow runs created since `since` (ISO date), newest first, with their jobs; at most `limit`. */
  ciRuns(repoDir: string, since: string, limit: number): Promise<CiRun[]>;
  /** `harden`: newest release tag of the factory itself (`owner/repo`), null when there is none. */
  latestTag(repoDir: string, ownerRepo: string): Promise<string | null>;
}

export interface CiJob {
  name: string;
  /** success | failure | cancelled | skipped | … ; null while running. */
  conclusion: string | null;
  seconds: number | null;
}

export interface CiRun {
  id: number;
  sha: string;
  workflow: string;
  event: string;
  conclusion: string | null;
  created_at: string;
  jobs: CiJob[];
}

/** Highest `v<semver>`-like tag (numeric compare), else null. */
export function newestTag(tags: string[]): string | null {
  const parse = (t: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(t)?.slice(1).map(Number);
  const valid = tags.filter((t) => parse(t));
  valid.sort((a, b) => {
    const x = parse(a)!;
    const y = parse(b)!;
    return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
  });
  return valid.at(-1) ?? null;
}

export interface RepoSettings {
  private: boolean | null;
  auto_merge_allowed: boolean | null;
  branch_protected: boolean | null;
  required_checks: string[] | null;
  /**
   * `required_status_checks.strict`. Null when the branch is unprotected or the field was not readable.
   * UNVERIFIED: live GitHub response shape (see docs/VERIFY.md).
   */
  strict_required_checks?: boolean | null;
  /** GitHub secret scanning. Null when the API omits `security_and_analysis` (non-admin tokens). UNVERIFIED. */
  secret_scanning?: boolean | null;
  /** Push protection for secrets. Null when not readable. UNVERIFIED. */
  push_protection?: boolean | null;
  error?: string;
}

export interface OpenPr {
  url: string;
  draft: boolean;
  /** Head commit as GitHub sees it. */
  headSha: string | null;
}

export interface PrStatus {
  state: "open" | "merged" | "closed";
  draft: boolean;
}

async function gh(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("gh", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** GitHub reports secret scanning as "enabled" or "disabled"; anything else is unknown. */
function securityFlag(value: string | undefined): boolean | null {
  if (value === "enabled") return true;
  if (value === "disabled") return false;
  return null;
}

export interface BranchRules {
  /** A `required_status_checks` rule applies to the branch. */
  present: boolean;
  contexts: string[];
  /** `strict_required_status_checks_policy`. Null when the rule omits it. True wins across rules. */
  strict: boolean | null;
}

/** `GET /repos/{owner}/{repo}/rules/branches/{branch}` payload. Non-arrays are ignored. */
export function parseBranchRules(payload: unknown): BranchRules {
  if (!Array.isArray(payload)) return { present: false, contexts: [], strict: null };
  let present = false;
  const contexts: string[] = [];
  let strict: boolean | null = null;
  for (const rule of payload) {
    if (!rule || typeof rule !== "object" || (rule as { type?: unknown }).type !== "required_status_checks") continue;
    present = true;
    const params = (rule as { parameters?: unknown }).parameters;
    if (!params || typeof params !== "object") continue;
    const row = params as { required_status_checks?: unknown; strict_required_status_checks_policy?: unknown };
    if (Array.isArray(row.required_status_checks)) {
      for (const check of row.required_status_checks) {
        const context = typeof check === "string" ? check : check && typeof check === "object" ? (check as { context?: unknown }).context : undefined;
        if (typeof context === "string" && context.trim()) contexts.push(context.trim());
      }
    }
    if (row.strict_required_status_checks_policy === true) strict = true;
    else if (row.strict_required_status_checks_policy === false && strict !== true) strict = false;
  }
  return { present, contexts: [...new Set(contexts)], strict };
}

/**
 * Classic branch protection does not carry ruleset status checks. Union the ruleset contexts
 * and treat the branch as protected when a required-status rule applies. Unknown payloads are a no-op.
 */
export function mergeBranchRules(settings: RepoSettings, payload: unknown): RepoSettings {
  const rules = parseBranchRules(payload);
  if (!rules.present) return settings;
  const strict =
    settings.strict_required_checks === true || rules.strict === true
      ? true
      : settings.strict_required_checks === false || rules.strict === false
        ? false
        : (settings.strict_required_checks ?? null);
  return {
    ...settings,
    branch_protected: true,
    required_checks: [...new Set([...(settings.required_checks ?? []), ...rules.contexts])],
    strict_required_checks: strict,
  };
}

/** `gh` CLI implementation. Not exercised in tests (see docs/VERIFY.md). */
export class GhCli implements GitHub {
  async authenticated(repoDir: string): Promise<boolean> {
    try {
      await gh(repoDir, ["auth", "status", "--hostname", "github.com"]);
      return true;
    } catch {
      return false;
    }
  }

  async repoSettings(repoDir: string, branch: string): Promise<RepoSettings> {
    const out: RepoSettings = { private: null, auto_merge_allowed: null, branch_protected: null, required_checks: null };
    try {
      // UNVERIFIED: security_and_analysis is omitted for non-admin tokens; status strings are "enabled"|"disabled".
      const repo = JSON.parse(
        await gh(repoDir, [
          "api",
          "repos/{owner}/{repo}",
          "--jq",
          "{private, allow_auto_merge, secret_scanning: (.security_and_analysis.secret_scanning.status // \"\"), push_protection: (.security_and_analysis.secret_scanning_push_protection.status // \"\")}",
        ]),
      ) as { private?: boolean; allow_auto_merge?: boolean | null; secret_scanning?: string; push_protection?: string };
      out.private = repo.private ?? null;
      out.auto_merge_allowed = repo.allow_auto_merge ?? null;
      out.secret_scanning = securityFlag(repo.secret_scanning);
      out.push_protection = securityFlag(repo.push_protection);
      const b = JSON.parse(
        await gh(repoDir, [
          "api",
          `repos/{owner}/{repo}/branches/${encodeURIComponent(branch)}`,
          "--jq",
          "{protected, strict: .protection.required_status_checks.strict, contexts: ((.protection.required_status_checks.contexts // []) + ((.protection.required_status_checks.checks // []) | map(.context)))}",
        ]),
      ) as { protected?: boolean; strict?: boolean | null; contexts?: string[] | null };
      out.branch_protected = b.protected ?? null;
      out.strict_required_checks = typeof b.strict === "boolean" ? b.strict : null;
      out.required_checks = b.contexts ?? null;
      // Rulesets do not fill protection.required_status_checks. UNVERIFIED live (docs/VERIFY.md).
      try {
        const rules = JSON.parse(await gh(repoDir, ["api", `repos/{owner}/{repo}/rules/branches/${encodeURIComponent(branch)}`]));
        const merged = mergeBranchRules(out, rules);
        out.branch_protected = merged.branch_protected;
        out.required_checks = merged.required_checks;
        out.strict_required_checks = merged.strict_required_checks;
      } catch {
        // A missing rules API keeps the classic result. It must not hide secret scanning.
      }
    } catch (e) {
      out.error = (e as Error).message.split("\n")[0]!.slice(0, 200);
    }
    return out;
  }

  async baseStatus(repoDir: string, sha: string): Promise<BaseStatus> {
    const out = await gh(repoDir, ["api", `repos/{owner}/{repo}/commits/${sha}/check-runs`, "--jq", "[.check_runs[] | {name, status, conclusion, started_at, id, suite: .check_suite.id}]"]);
    const raw = JSON.parse(out || "[]") as { name?: string; status?: string; conclusion?: string | null; started_at?: string | null; id?: number; suite?: number | null }[];
    const runs: CheckRunView[] = [];
    for (const run of raw) {
      if (!run.name || !run.status) continue;
      runs.push({ name: run.name, status: run.status, conclusion: run.conclusion || null, started_at: run.started_at, id: run.id, suite: run.suite });
    }
    return aggregateCheckRuns(runs);
  }

  async getIssue(repoDir: string, n: number): Promise<Issue> {
    const out = await gh(repoDir, ["issue", "view", String(n), "--json", "number,title,body,labels"]);
    const j = JSON.parse(out) as { number: number; title: string; body: string; labels: { name: string }[] };
    return { number: j.number, title: j.title, body: j.body, labels: j.labels.map((l) => l.name) };
  }

  async push(repoDir: string, branch: string): Promise<void> {
    await git(repoDir, ["push", "-q", "-u", "origin", branch]);
  }

  async remoteBranchSha(repoDir: string, branch: string): Promise<string | null> {
    const { stdout } = await execFileP("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], { cwd: repoDir, timeout: 60_000 });
    return /^([0-9a-f]{40,64})\s/m.exec(stdout)?.[1] ?? null;
  }

  async findOpenPr(repoDir: string, branch: string): Promise<OpenPr | null> {
    const list = JSON.parse(await gh(repoDir, ["pr", "list", "--head", branch, "--state", "open", "--limit", "5", "--json", "url,isDraft,headRefOid,headRefName"]) || "[]") as {
      url: string;
      isDraft: boolean;
      headRefOid?: string;
      headRefName?: string;
    }[];
    const pr = list.find((p) => (p.headRefName ?? branch) === branch);
    return pr ? { url: pr.url, draft: pr.isDraft, headSha: pr.headRefOid ?? null } : null;
  }

  async createPr(req: PrRequest): Promise<string> {
    const args = ["pr", "create", "--head", req.head, "--base", req.base, "--title", req.title, "--body", req.body];
    if (req.draft) args.push("--draft");
    const url = (await gh(req.repoDir, args)).trim();
    for (const label of req.labels ?? []) await this.addLabel(req.repoDir, url, label);
    return url;
  }

  async addLabel(repoDir: string, pr: string, label: string): Promise<void> {
    // The PR body carries the same warning; a missing label permission must not fail the run.
    await gh(repoDir, ["label", "create", label, "--force", "--color", "B60205", "--description", "Changes CI or factory config"]).catch(() => "");
    await gh(repoDir, ["pr", "edit", pr, "--add-label", label]).catch(() => "");
  }

  async enableAutoMerge(repoDir: string, pr: string): Promise<void> {
    await gh(repoDir, ["pr", "merge", pr, "--auto", "--squash"]);
  }

  async updatePr(repoDir: string, pr: string, update: { title: string; body: string }): Promise<void> {
    await gh(repoDir, ["pr", "edit", pr, "--title", update.title, "--body", update.body]);
  }

  async markReady(repoDir: string, pr: string): Promise<void> {
    await gh(repoDir, ["pr", "ready", pr]);
  }

  async markDraft(repoDir: string, pr: string): Promise<void> {
    await gh(repoDir, ["pr", "ready", "--undo", pr]);
  }

  async ciRuns(repoDir: string, since: string, limit: number): Promise<CiRun[]> {
    const list = JSON.parse(
      await gh(repoDir, ["run", "list", "--limit", String(limit), "--created", `>=${since.slice(0, 10)}`, "--json", "databaseId,headSha,workflowName,event,conclusion,createdAt"]),
    ) as { databaseId: number; headSha: string; workflowName: string; event: string; conclusion: string | null; createdAt: string }[];
    const out: CiRun[] = [];
    for (const r of list) {
      const view = JSON.parse(await gh(repoDir, ["run", "view", String(r.databaseId), "--json", "jobs"])) as {
        jobs: { name: string; conclusion: string | null; startedAt: string | null; completedAt: string | null }[];
      };
      const jobs = view.jobs.map((j) => {
        const ms = j.startedAt && j.completedAt ? Date.parse(j.completedAt) - Date.parse(j.startedAt) : NaN;
        return { name: j.name, conclusion: j.conclusion || null, seconds: Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null };
      });
      out.push({ id: r.databaseId, sha: r.headSha, workflow: r.workflowName, event: r.event, conclusion: r.conclusion || null, created_at: r.createdAt, jobs });
    }
    return out;
  }

  async latestTag(repoDir: string, ownerRepo: string): Promise<string | null> {
    const tags = (await gh(repoDir, ["api", `repos/${ownerRepo}/tags?per_page=100`, "--jq", ".[].name"])).split("\n").filter(Boolean);
    return newestTag(tags);
  }

  async prStatus(repoDir: string, pr: string): Promise<PrStatus> {
    const j = JSON.parse(await gh(repoDir, ["pr", "view", pr, "--json", "state,isDraft"])) as { state: string; isDraft: boolean };
    const state = j.state.toLowerCase();
    return { state: state === "merged" || state === "closed" ? state : "open", draft: j.isDraft };
  }
}

/** In-memory GitHub for tests: no network, no `gh`. */
export class FakeGitHub implements GitHub {
  status: BaseStatus = "none";
  issues = new Map<number, Issue>();
  readonly pushes: string[] = [];
  readonly prs: (PrRequest & { url: string })[] = [];
  readonly autoMerged: string[] = [];

  async baseStatus(): Promise<BaseStatus> {
    return this.status;
  }

  async getIssue(_repoDir: string, n: number): Promise<Issue> {
    const issue = this.issues.get(n);
    if (!issue) throw new Error(`issue #${n} not found`);
    return issue;
  }

  /** Branch → sha on the fake origin; a push records the worktree's HEAD. */
  readonly remoteShas = new Map<string, string>();

  async push(repoDir: string, branch: string): Promise<void> {
    this.pushes.push(branch);
    try {
      this.remoteShas.set(branch, execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    } catch {
      // not a git dir (unit tests): nothing to record
    }
  }

  async remoteBranchSha(_repoDir: string, branch: string): Promise<string | null> {
    return this.remoteShas.get(branch) ?? null;
  }

  async findOpenPr(_repoDir: string, branch: string): Promise<OpenPr | null> {
    const pr = this.prs.find((p) => p.head === branch && (this.prStates.get(p.url)?.state ?? "open") === "open");
    return pr ? { url: pr.url, draft: this.prStates.get(pr.url)?.draft ?? pr.draft, headSha: this.remoteShas.get(branch) ?? null } : null;
  }

  async createPr(req: PrRequest): Promise<string> {
    const url = `https://github.test/pr/${this.prs.length + 1}`;
    this.prs.push({ ...req, url });
    this.prStates.set(url, { state: "open", draft: req.draft });
    for (const label of req.labels ?? []) await this.addLabel(req.repoDir, url, label);
    return url;
  }

  readonly labels: { pr: string; label: string }[] = [];

  async addLabel(_repoDir: string, pr: string, label: string): Promise<void> {
    this.labels.push({ pr, label });
  }

  async enableAutoMerge(_repoDir: string, pr: string): Promise<void> {
    this.autoMerged.push(pr);
  }

  readonly updates: { pr: string; title: string; body: string }[] = [];
  readonly readied: string[] = [];
  readonly drafted: string[] = [];

  async updatePr(_repoDir: string, pr: string, update: { title: string; body: string }): Promise<void> {
    this.updates.push({ pr, ...update });
  }

  async markReady(_repoDir: string, pr: string): Promise<void> {
    this.readied.push(pr);
    const prev = this.prStates.get(pr);
    this.prStates.set(pr, { state: prev?.state ?? "open", draft: false });
  }

  async markDraft(_repoDir: string, pr: string): Promise<void> {
    this.drafted.push(pr);
    const prev = this.prStates.get(pr);
    this.prStates.set(pr, { state: prev?.state ?? "open", draft: true });
  }

  /** PR states by URL; created PRs are open. */
  readonly prStates = new Map<string, PrStatus>();

  authOk = true;
  settings: RepoSettings = { private: true, auto_merge_allowed: false, branch_protected: false, required_checks: [] };

  async authenticated(): Promise<boolean> {
    return this.authOk;
  }

  async repoSettings(): Promise<RepoSettings> {
    return this.settings;
  }

  /** CI history and the factory's newest tag as `harden` sees them. */
  runs: CiRun[] = [];
  factoryTag: string | null = null;
  readonly ciQueries: { since: string; limit: number }[] = [];

  async ciRuns(_repoDir: string, since: string, limit: number): Promise<CiRun[]> {
    this.ciQueries.push({ since, limit });
    return this.runs.filter((r) => r.created_at >= since).slice(0, limit);
  }

  async latestTag(): Promise<string | null> {
    return this.factoryTag;
  }

  async prStatus(_repoDir: string, pr: string): Promise<PrStatus> {
    const s = this.prStates.get(pr);
    if (s) return s;
    const created = this.prs.find((p) => p.url === pr);
    if (!created) throw new Error(`PR ${pr} not found`);
    return { state: "open", draft: created.draft };
  }
}
