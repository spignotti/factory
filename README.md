# Software Factory

A deterministic pipeline that turns a task (issue, plan file or plain text) into a reviewed, verified pull
request. LLMs (via Pi) only plan, implement, review and summarize; everything else is code. `SPEC.md` is the
source of truth.

## Status: M1 — core loop

Implemented (SPEC §17 M1 plus Amendments v1.4.1 a–d where they touch M1):

- **Intake** (`src/steps/intake.ts`): issue / plan file / text; ```` ```factory-plan ```` blocks used as is;
  `--plan-effort none` runs `plan_normalize` with a code-level `source_quote` fidelity check (one retry,
  then plan step at `medium`); questions → `needs_input`; per-repo lock (one run per repository; `--wait` queues, `queued` event); base check (`base_red`); worktree
  and branch `factory/<task>-<slug>`.
- **Plan** (`src/steps/plan.ts`, `src/schemas/plan.ts`): zod schema plus code checks (ids, DAG, limits,
  bug → repro, risk rule, `changes_flows`, `verify: evaluator` only with `ui`, quote fidelity).
- **Implement** (`src/steps/implement.ts`): DAG order, fresh session per package, handoff validation with one
  re-prompt, fast gates with the failure tail back into the same session (max 3), factory commits, cascade-skip.
- **Gates** (`src/gates/`, `src/steps/gates.ts`): tier/path selection shared with CI, flaky re-run, built-ins
  (forbidden paths, diff size, test presence, evidence, guide update, scope report, red-green proof).
- **Review** (`src/steps/review.ts`): `plan` and `simplicity` reviewers, read-only tools, structured findings,
  continued sessions with the incremental diff in round ≥ 2.
- **Merge/exit** (`src/pipeline/merge.ts`, `loop.ts`): ids, dedupe, nit cap, stalemate, exit rules, fix rounds.
- **Finalize** (`src/steps/finalize.ts`, `src/pipeline/risk.ts`): full gates; if the base moved, a merge (not a
  rebase, so no force-push is ever needed) plus full gates again, conflict → `needs_human`; risk class,
  merge policy (Amendment a: `merge.auto_merge_max_risk: none|low|medium`, default `none`), PR body from
  `standards/pr-template.md`, push/PR through the `GitHub` interface (`src/gh.ts`).
- **Agents** (`src/agents/`): one `AgentRunner` interface; `fake-runner` (scripted fixtures) and `pi-runner`
  (Pi SDK); env allowlist and isolated `HOME` (Amendment b); capacity/limit/auth/invalid_output/other
  classification with same-model backoff before fallback, `implement` never crossing model families
  (Amendment c); heartbeat/progress events and the watchdog (Amendment d).
- **Events** (`src/events.ts`): `events.jsonl` and one-line `result.json`.

Not in M1: CI stub, services, security/checklist reviewers, findings memory, fast lane, `status`/
`stats`/`gc`/`doctor`, eval, evaluator, `adopt`, `harden`.

## Resume

Every run keeps `state.json` (current step, package status, rounds, PR) next to `result.json` in
`~/.factory/runs/<run-id>/`. After a `needs_human` stop, fix things in the run's worktree (or push to the
PR branch), then `factory resume <run-id>`: it commits the uncommitted fix as `fix: human changes before
resume`, merges new commits from `origin/<branch>` and the moved base (conflict → `needs_human` again),
re-runs the gates (red → one fixer round) and continues from the saved step. It never force-pushes; an
existing PR is updated and marked ready when the run ends `done`. After an interrupted/failed run,
uncommitted leftovers are discarded instead and the step re-runs. A resumed review starts with a fresh round
budget; a resume at `finalize` only re-runs the gates (no new review of the human change).

## Usage

Without a checkout (builds on install through `prepare`):

```
npx github:spignotti/factory#<tag> doctor
npx github:spignotti/factory#<tag> run --repo <path> --issue 12
```

From a checkout:

```
pnpm install
pnpm build
node dist/cli.js run --repo <path> --text task.md [--plan-effort none|medium|high] [--no-pr]
node dist/cli.js resume <run-id> [--wait] [--no-pr]
node dist/cli.js gates --select --tier full --base origin/main --json
node dist/cli.js gates --run unit --json
```

Runs live in `~/.factory/runs/<run-id>/` (override with `FACTORY_HOME`). The target repo needs
`.factory/repo.yaml` (SPEC §5.2; `tests.run` with a `{files}` placeholder enables the red-green proof).

## Model configuration

Layers, most specific wins (SPEC Amendment i), each replacing whole role chains:

1. built-in `profiles/default.yaml`;
2. your user profile `$FACTORY_HOME/profile.yaml` (default `~/.factory/profile.yaml`);
3. `--profile <name|file>` for one invocation (experiments);
4. the repo's `.factory/repo.yaml` `models:`.

```yaml
# ~/.factory/profile.yaml
providers: { allow: [opencode-go, openai], deny: [opencode] }   # only here or built-in
roles:
  pr_writer: [{ model: opencode-go/mimo-v2.6-flash }]
```

```yaml
# .factory/repo.yaml: cheaper models for this repo
models:
  plan_high: [{ model: openai/gpt-6.1-sol, thinking: medium }]
```

The default provider policy allows any Pi provider except `opencode` (OpenCode Zen, pay-per-use). Safety
rules (provider policy, reviewers in another model family than every `implement` model, a cross-family
`implement` backup must be `capacity_only`) are checked after the merge. `factory doctor [--repo <path>]`
shows the effective model per role and the layer it came from.

## Sandbox (Linux)

Agent bash, repo `setup`, gate checks and red-green test runs are jailed with bubblewrap inside a pasta
network namespace (SPEC Amendment j): only the run's worktree and agent HOME are writable, git metadata is
read-only, host loopback, Docker bridge, metadata service and LAN are unreachable, the internet works. File
tools are confined to the worktree. Set `sandbox: required | preferred | off` in
`~/.factory/profile.yaml` (default `preferred`, which degrades with a warning). Needs `bwrap`
(bubblewrap), `pasta` (passt) and `ip` (iproute2); `factory doctor` shows what is in effect.

## Fast lane

`factory run … --lane fast` is for small, single-package changes: the task is translated by `plan_normalize` (no planner), gates run as usual, `plan` and `simplicity` review in one session and there is at most one fix round. The run moves to the standard lane when the task needs more than one package or after implement when the diff exceeds `fast_lane.max_diff_lines` (default 150) or touches dependencies, `sensitive_paths`, `human_only_paths` or migrations. Escalations are logged and listed in the PR.

## Reviewers

`plan` and `simplicity` review every change. `security` joins when the change touches `sensitive_paths` or any dependency manifest or lockfile. `checklist` joins when `review.checklist` is on (default) and `.factory/checklist.md` has unmarked items:

```markdown
- Every API route checks the session
- Migrations are reversible <!-- check: migrations -->
```

One list item per rule. Mark an item with `<!-- check: <check name> -->` once a deterministic check enforces it; marked items are no longer reviewed by an LLM. The checklist is read from the base commit.

## Findings memory

Open review findings left at the end of a run (no nits) and flaky checks are remembered per repository in `$FACTORY_HOME/memory/<repo>/findings.json` (outside the repo, keyed by the canonical origin URL). The ten most frequent open entries are shown to the implementer and the reviewers of the next run; they never appear in PRs. `factory harden` (M3) turns them into checks. Delete the file to forget.

## Doctor and the Zen guard

`factory doctor [--repo <path>] [--ping]` checks the setup before you spend anything: every configured model
is resolved through the factory's own Pi config (`$FACTORY_HOME/pi`), and it fails if a model would hit the
pay-per-use OpenCode Zen endpoint (also via a `models.json` override), if OpenAI is not on the ChatGPT login
(an API key bills per use), or if a provider has no credential. It warns that "Extra Usage" must be off
(not readable via API). `--ping` sends one tiny request per model. With `--repo` it checks `gh` and gives
hints on auto-merge and branch protection (neither needs admin rights or GitHub Pro). The run applies the
same Zen and ChatGPT-login rules before every agent session.

Log in once for the factory: `PI_CODING_AGENT_DIR=~/.factory/pi npx pi`, then `/login` (ChatGPT for OpenAI,
API key for OpenCode Go).

## Status, stats, cleanup

```
factory status [--json]                     # running, waiting for you, interrupted; open factory PRs
factory stats --since 7d [--repo <path>] --json  # results, rounds, gates, providers, cost vs the previous 7 days
factory gc [--dry-run] [--force]            # remove worktree and branches of merged/closed factory PRs
```

`gc` deletes only `factory/*` branches, and the remote branch only if nobody pushed to it after the factory; a worktree with uncommitted changes needs `--force`.

## Development

```
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

Tests never call an LLM, the network, `gh` or `git push`: agents are the scripted `FakeRunner`
(`test/fixtures/scripts/*.json`), GitHub is `FakeGitHub`, and E2E tests create a fixture git repo from
`test/fixtures/repo/` in a temp dir per test.

## Unverified

What could not be verified without real providers or GitHub is listed in [`docs/VERIFY.md`](docs/VERIFY.md)
and marked `// UNVERIFIED:` in code.
