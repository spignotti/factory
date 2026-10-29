import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { git } from "./git.js";

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
}

/** Everything the factory does on GitHub. Only the factory process calls it. */
export interface GitHub {
  baseStatus(repoDir: string, sha: string): Promise<BaseStatus>;
  getIssue(repoDir: string, n: number): Promise<Issue>;
  push(repoDir: string, branch: string): Promise<void>;
  createPr(req: PrRequest): Promise<string>;
  enableAutoMerge(repoDir: string, pr: string): Promise<void>;
  /** Resume: refresh title/body of the run's existing PR. */
  updatePr(repoDir: string, pr: string, update: { title: string; body: string }): Promise<void>;
  /** Resume: a draft PR whose run is now done becomes ready for review. */
  markReady(repoDir: string, pr: string): Promise<void>;
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
  error?: string;
}

export interface PrStatus {
  state: "open" | "merged" | "closed";
  draft: boolean;
}

async function gh(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("gh", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
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
      const repo = JSON.parse(await gh(repoDir, ["api", "repos/{owner}/{repo}", "--jq", "{private, allow_auto_merge}"])) as { private?: boolean; allow_auto_merge?: boolean | null };
      out.private = repo.private ?? null;
      out.auto_merge_allowed = repo.allow_auto_merge ?? null;
      const b = JSON.parse(
        await gh(repoDir, ["api", `repos/{owner}/{repo}/branches/${encodeURIComponent(branch)}`, "--jq", "{protected, contexts: .protection.required_status_checks.contexts}"]),
      ) as { protected?: boolean; contexts?: string[] | null };
      out.branch_protected = b.protected ?? null;
      out.required_checks = b.contexts ?? null;
    } catch (e) {
      out.error = (e as Error).message.split("\n")[0]!.slice(0, 200);
    }
    return out;
  }

  async baseStatus(repoDir: string, sha: string): Promise<BaseStatus> {
    const out = await gh(repoDir, ["api", `repos/{owner}/{repo}/commits/${sha}/check-runs`, "--jq", "[.check_runs[] | {status, conclusion}]"]);
    const runs = JSON.parse(out || "[]") as { status: string; conclusion: string | null }[];
    if (runs.length === 0) return "none";
    if (runs.some((r) => ["failure", "timed_out", "cancelled", "action_required"].includes(r.conclusion ?? ""))) return "red";
    if (runs.some((r) => r.status !== "completed")) return "pending";
    return "green";
  }

  async getIssue(repoDir: string, n: number): Promise<Issue> {
    const out = await gh(repoDir, ["issue", "view", String(n), "--json", "number,title,body,labels"]);
    const j = JSON.parse(out) as { number: number; title: string; body: string; labels: { name: string }[] };
    return { number: j.number, title: j.title, body: j.body, labels: j.labels.map((l) => l.name) };
  }

  async push(repoDir: string, branch: string): Promise<void> {
    await git(repoDir, ["push", "-q", "-u", "origin", branch]);
  }

  async createPr(req: PrRequest): Promise<string> {
    const args = ["pr", "create", "--head", req.head, "--base", req.base, "--title", req.title, "--body", req.body];
    if (req.draft) args.push("--draft");
    return (await gh(req.repoDir, args)).trim();
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

  async push(_repoDir: string, branch: string): Promise<void> {
    this.pushes.push(branch);
  }

  async createPr(req: PrRequest): Promise<string> {
    const url = `https://github.test/pr/${this.prs.length + 1}`;
    this.prs.push({ ...req, url });
    return url;
  }

  async enableAutoMerge(_repoDir: string, pr: string): Promise<void> {
    this.autoMerged.push(pr);
  }

  readonly updates: { pr: string; title: string; body: string }[] = [];
  readonly readied: string[] = [];

  async updatePr(_repoDir: string, pr: string, update: { title: string; body: string }): Promise<void> {
    this.updates.push({ pr, ...update });
  }

  async markReady(_repoDir: string, pr: string): Promise<void> {
    this.readied.push(pr);
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
