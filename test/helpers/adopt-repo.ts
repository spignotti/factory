import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitIn } from "./repo.js";

/** A fresh git repo (branch main, one commit) with the given files. */
export function makeRepo(files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "factory-adopt-")), "repo");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  gitIn(dir, "add", "-A");
  gitIn(dir, "-c", "user.name=fixture", "-c", "user.email=fixture@test", "commit", "-q", "-m", "init");
  return dir;
}

export const NODE_PKG = JSON.stringify({
  name: "app",
  scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run", "test:e2e": "playwright test", build: "vite build" },
  dependencies: { react: "^19.0.0", pg: "^8.0.0" },
  devDependencies: { vitest: "^4.0.0", "@playwright/test": "^1.0.0" },
});

const CI_COVERED = `name: CI
on: [pull_request, push]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint && pnpm test
`;

const SECURITY = `name: security
on:
  pull_request:
jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: gitleaks detect --no-banner
`;

const CLAUDE_WF = `name: claude
on: [issue_comment]
jobs:
  claude:
    runs-on: ubuntu-latest
    steps:
      - uses: anthropics/claude-code-action@v1
`;

const DEPLOY = `name: deploy
on:
  push:
    tags: ["v*"]
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`;

const DEPLOY_ON_RELEASE = `name: release
on:
  release:
    types: [published]
jobs:
  r:
    runs-on: ubuntu-latest
    steps:
      - run: ./release.sh
`;

export const AGENTS_MD = `# AGENTS.md

## Rules
- Small commits.

## Coding workflow
Use opencode with the runner script for every change.
`;

/** A node repo with a legacy coding setup of every kind adopt knows. */
export function legacyNodeRepo(extra: Record<string, string> = {}): string {
  return makeRepo({
    "package.json": NODE_PKG,
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "src/index.ts": "export const x = 1;\n",
    "src/index.test.ts": "import { x } from './index';\n",
    "e2e/home.spec.ts": "// e2e\n",
    "AGENTS.md": AGENTS_MD,
    "CLAUDE.md": "Use Claude.\n",
    ".claude/settings.json": "{}\n",
    ".claude/agents/reviewer.md": "review\n",
    ".cursor/BUGBOT.md": "rules\n",
    ".cursor/config/bugbot.yaml": "a: 1\n",
    ".cursor/environment.json": "{}\n",
    ".grok/config.toml": "x = 1\n",
    ".grok/commands/maintain.md": "maintain\n",
    ".grok/skills/server-ops/SKILL.md": "ops\n",
    ".opencode/skills/vm/scripts/run.sh": "echo vm\n",
    "opencode.json": "{}\n",
    ".github/workflows/ci.yml": CI_COVERED,
    ".github/workflows/security.yml": SECURITY,
    ".github/workflows/claude.yml": CLAUDE_WF,
    ".github/workflows/deploy.yml": DEPLOY,
    ".github/workflows/release.yml": DEPLOY_ON_RELEASE,
    "notebooks/runners/01.py": "# not legacy\n",
    ...extra,
  });
}
