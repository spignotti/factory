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

/** Everything the factory does on GitHub. Only the factory process calls it (Amendment b). */
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
}

async function gh(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("gh", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** `gh` CLI implementation. Not exercised in tests (see docs/VERIFY.md). */
export class GhCli implements GitHub {
  async baseStatus(repoDir: string, sha: string): Promise<BaseStatus> {
    // UNVERIFIED: check-runs response shape on the user's repos.
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
}
