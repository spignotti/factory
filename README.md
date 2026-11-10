# Software Factory

A deterministic pipeline that turns a task (issue, plan file or plain text) into a reviewed, verified pull
request. LLMs (via Pi) only plan, implement, review and summarize; everything else is code. The code is the
source of truth; this README is the reference for concepts, configuration and commands.

## Principles

1. **Code first.** Control flow, limits, check selection, model selection and fallback, merging findings,
   stalemates, risk and merge policy, git and PR assembly are code. LLMs plan, implement, judge, summarize.
2. **Derive, don't ask.** What git, the filesystem or GitHub can tell is computed; verifiable LLM claims are
   verified in code.
3. **Checks in CI, judgment in review.** Lint, types, tests, scanners and recorded flows are checks; LLM
   review covers plan fidelity, simplicity, impact and security reasoning.
4. **Ratchet toward determinism.** Recurring findings and checklist items become checks (`factory harden`). Security, performance and structure are judged on demand (`factory audit`).
5. **Tests prove criteria.** Every test proves an acceptance criterion the plan names.
6. **Minimal prompts.** `roles/*.md` are short, role-specific and the factory's only global agent
   instructions; repo facts live in the repo's `AGENTS.md`.
7. **Evidence over feelings.** Prompt, profile or pipeline changes need an `eval` comparison.
8. **Adapt to the repo, never the repo to the factory.** `factory adopt`, `factory doctor` and runs use the
   repo's existing tools, layout and conventions (test runner, linter, formatter, folders) and never introduce
   their own. If something is missing, the factory reports it or proposes it; it does not silently restructure
   the repo.

All models run through Pi; no Claude/Codex CLI, no production data. One run per repository unless the repo sets `concurrency.max_runs`.

**Where runs happen.** A `factory run` targets only repositories that have `.factory/repo.yaml` (enrolled
via `factory adopt`). Today that is **tourenpilot** and **tourenpilot-ops**. This repository ships the CLI
and uses the **`ci`** GitHub workflow for its own PRs (no `.factory/` here). Every other repo uses the Cloud
Agent path ([docs/BOTS.md](docs/BOTS.md#choosing-the-path-for-a-code-change)).

## Pipeline

`intake → plan → implement → loop { fast gates → evaluate → review → merge findings → exit? → fix } → finalize`

- **Intake** (`src/steps/intake.ts`): issue / plan file / text; ```` ```factory-plan ```` blocks are used as
  is; `--plan-effort none` runs `plan_normalize` with a code-level `source_quote` fidelity check; questions
  → `needs_input`; per-repo lock (`concurrency.max_runs`, default 1; `--wait` queues on a full slot or on overlapping plans); base check (`base_red`; pending CI on the base is polled up to `limits.base_ci_wait_minutes`; a GitHub-CI `base_red` resumes itself once that commit is green, see Cleanup); worktree and branch
  `factory/<task>-<slug>` (with `-<run id>-s<slot>` when `max_runs` is above 1).
- **Plan** (`src/steps/plan.ts`, `src/schemas/plan.ts`): zod schema plus code checks (ids, DAG, limits,
  bug → repro, risk rule, `changes_flows`, `verify: evaluator` only with `ui`, quote fidelity, and a scope check that
  warns the plan reviewer when the plan says "only" a path the task does not). The planner reads the repo's
  `AGENTS.md` at the base commit. `plan_normalize` retries once with the zod paths and the JSON schema of the failing
  fields (the first prompt does not include that schema) before the run falls back to the planner; the progress
  event lists both attempts.
- **Implement** (`src/steps/implement.ts`): DAG order, fresh session per package, handoff validation with one
  re-prompt, fast gates with the failure tail back into the same session (max 3), factory commits,
  cascade-skip. Bug plans prove the repro red on base and green after the fix. A plan opts out only with
  `red_green: not_applicable` and `red_green_reason`, or the issue label `factory:red-green-not-applicable` plus that
  reason (test-stabilization, where the repro cannot fail on base). That opt-out is a loosening: the reason is required,
  and the gate result, config guard and PR body name it. The plan reviewer must justify it. Without the field and the
  label, the proof is unchanged.
- **Gates** (`src/gates/`, `src/steps/gates.ts`): tier/path selection shared with CI, flaky re-run, built-ins
  (forbidden paths, diff size, test presence, evidence, guide update, scope report, red-green proof, config
  guard). The config guard fails the gates when the change loosens lint/type/format/test-runner config
  (`ruff.toml`, `[tool.ruff|mypy|pyright|…]`, eslint/biome/prettier config, `tsconfig` strictness flags,
  coverage thresholds) or adds inline suppressions (`noqa`, `type: ignore`, `eslint-disable`, `@ts-ignore`,
  `biome-ignore`, …), unless the plan lists that config file in a package's `files` or names the suppression.
  A `.factory/repo.yaml` change that weakens the factory's own checks (removing or changing a check,
  making one `local_only`, adding a `host: true` service, dropping `human_only_paths`/`sensitive_paths`/`forbidden_paths` entries, raising merge or diff limits,
  raising `concurrency.max_runs`, removing `concurrency.exclusive_paths`, changing secrets, `setup`, `env_command`, services, models, adding `agent_env`) fails it even when declared.
  The `protected_paths` gate fails on any changed `human_only_paths` file the plan does not declare (see
  [Protected config](#protected-config)).
- **Evaluate** (only with `ui`, see below) runs before the reviewers; any evaluator bug skips review that round.
- **Review** (`src/steps/review.ts`): reviewers decided in code, read-only tools, structured findings,
  continued sessions with the incremental diff in round ≥ 2.
- **Merge/exit** (`src/pipeline/merge.ts`, `loop.ts`): ids, dedupe, nit cap, stalemate, exit rules, fix rounds.
- **Finalize** (`src/steps/finalize.ts`, `src/pipeline/risk.ts`): full gates; if the base moved, a merge (no
  rebase, so never a force-push) plus full gates again, conflict → `needs_human`; risk class and merge
  policy stay in `result.json`. The PR body (`standards/pr-template.md`) has one **Risk & Security** section:
  five yes/no rows (data/migrations, auth/permissions, secrets handling, prod deploy/infra, dependencies)
  and an overall rating (low/medium/high) with a one-line reason. When the plan carries `host_steps` and
  the repo sets `pr.host_steps_section`, the body also has that section (copy-paste commands, verify, roll back);
  otherwise it is omitted. Push/PR through `src/gh.ts`. After the PR exists, `none` and pending
  CI on the head are polled up to `limits.pr_ci_wait_minutes` and do not fail the run. Still none or pending
  leaves an auto policy as `human_review` (no auto-merge). Auto-merge is enabled only when that CI is green.
  Red CI ends it `needs_human` and converts the PR back to draft.
- **Agents** (`src/agents/`): one `AgentRunner` interface, `fake-runner` (tests) and `pi-runner` (Pi SDK);
  env allowlist and isolated `HOME`; capacity/network/stream/limit/auth/invalid_output classification with same-model
  backoff before fallback, `implement` never crossing model families; heartbeats and a silence watchdog
  (a frozen box/VM is not counted as silence, `progress` event `suspended_ms`). Provider timeouts and dropped
  streams (`Request timed out.`, `Connection error.`, `terminated`, `ECONNRESET`, …) are `network` errors and
  retried on the same model (`retry.attempts`). A provider that closes the token stream before a finish reason
  (`Stream ended without finish_reason`, premature EOF, connection reset while streaming) is a `stream` error:
  the same model is retried up to `limits.stream_retries` (default 2) with the profile backoff, recorded as
  `step_retry` and shown by `factory status` while that call is still in flight. The retry is the current agent
  call only (the implement package that was running); earlier packages stay committed. Auth, quota/limit,
  invalid output and other errors are not retried this way. A call that failed while the box was frozen gets up
  to two extra retries that do not count as attempts (`model_retry` with `after_suspend`). When the chain gives
  up on a capacity/network/stream error the run ends `needs_human` (reason `transient …` or
  `provider stream aborted after N retries: …; factory resume <id>`), not `failed`. One call whose `tokens_in`
  reaches `limits.step_token_warn` (default 1_000_000; `0` disables) emits a `progress` warning
  (`warning: step_tokens`) and still continues. Every agent bash command
  is killed after `limits.command_timeout_minutes` (default 10, also the maximum the model can ask for)
  and the model gets "Command timed out" back. Gate checks, base checks and the red-green proof are killed after
  `limits.gate_timeout_minutes` (default 10, 600s), a check's `timeout_s`, or `timeout_minutes`, capped by
  the remaining wall budget. The process tree is killed. A timed-out check is recorded as `timeout` (not a pass)
  and is not retried as flaky. A red-green timeout on the base worktree is inconclusive: it is not treated as a
  failing repro, and the run result says so. While a check runs, progress and heartbeat events name it so
  `factory status` can show the current check.
  Pi sees only the worktree root `AGENTS.md` as context (no `~/.pi`, ancestor or `AGENTS.override.md` files;
  an override is ignored with a warning).
- **Events** (`src/events.ts`): `events.jsonl` and a one-line `result.json` per run.

## Commands

| Command | Purpose |
| --- | --- |
| `factory run --repo <p> (--issue n \| --plan f \| --text f)` | one task → one PR (`--lane fast`, `--plan-effort`, `--no-pr`, `--wait`, `--no-notify`) |
| `factory resume <run-id>` | continue after a human fix |
| `factory abandon <run-id>` | mark abandoned, drop the lock and worktree; keep result and logs |
| `factory doctor [--repo <p>] [--ping] [--services]` | setup, node (path/version), provider policy, models per role, agent context, CI stub, tool baseline ([docs/BASELINE.md](docs/BASELINE.md)), disk/inodes |
| `factory status` / `stats` / `gc` | runs (running, queued, stalled, orphaned), PRs, period stats, cleanup |
| `factory gates (--select \| --run <check>)` | check selection and execution (local and CI) |
| `factory adopt --repo <p> [--ref <tag>]` | onboarding PR |
| `factory harden --repo <p>` | signals → ranked proposals |
| `factory audit --repo <p> --type <t>` | one read-only audit → ranked proposals |
| `factory eval` / `experiment` | compare profiles on curated tasks |
| `factory ci-stub [--ref <tag>] [--repo <path>]` | print the CI workflow (minimal when no check runs in CI) |
| `factory notify test <owner/name> [--target <name>]` | send a test ping to the repo hook or a named target (see [docs/BOTS.md](docs/BOTS.md)) |
| `factory notify flush` | retry pending run-end notifications from `~/.factory/outbox/` (also at run/resume start) |
| `factory --version` | package version (plus the commit for a checkout install) |

`factory` without arguments prints every flag. All commands take `--json` where the output is machine-readable.

## Resume

Every run keeps `state.json` (current step, package status, rounds, PR) next to `result.json` in
`~/.factory/runs/<run-id>/`. After a `needs_human` stop, fix things in the run's worktree (or push to the
PR branch), then `factory resume <run-id>`: it commits the uncommitted fix as `fix: human changes before
resume`, merges new commits from `origin/<branch>` and the moved base (conflict → `needs_human` again),
re-runs the gates (red → one fixer round) and continues from the saved step. It never force-pushes; an
existing PR is updated and marked ready when the run ends `done`. After an interrupted/failed run, or a
`needs_human` stop on a transient provider error, uncommitted agent leftovers are discarded instead and the
step re-runs. A resumed review starts with a fresh round
budget; a resume at `finalize` only re-runs the gates (no new review of the human change).
`result.json` always describes the latest finished attempt: a resume removes it when it starts and writes
its own outcome at the end. The PR step is idempotent: a push that errors but landed (origin's branch at
HEAD) counts as pushed, and an open PR on the run's branch at HEAD is adopted and updated instead of a second
`gh pr create`.

## Notify (bots)

On every `run_finished` (also after `resume`, `abandon` and a `gc` abandon) the factory POSTs `{run_id, repo, result, reason, pr,
finished_at}` to the webhook of the bot that started the run. `factory run --notify <target>` stores that
name on the run (`notify_target` in `state.json`) and POSTs to `targets.<name>` in `~/.factory/notify.yaml`,
adding `"target"` to the body. Without `--notify`, the repo's `repos:` hook is used as before. The file is
`0600` and hidden from agents inside a run; each bot writes its own entry. A removed target falls back to the
repo hook. Retries with backoff; a failed notification is logged and never fails the run. URLs and keys are
never written to events, state, the outbox, status, doctor output or the PR.
A background shell that ends does not wake a bot; this hook does. Setup, payload, routine prompt and the
onboarding checklist: [docs/BOTS.md](docs/BOTS.md).

## Usage

Without a checkout (builds on install through `prepare`):

```
npx github:spignotti/factory#<tag> doctor
npx github:spignotti/factory#<tag> run --repo <path> --issue 12
```

On a long-lived box, `scripts/deploy-self.sh` keeps an installed CLI on the newest `main` commit:
each new commit is built in its own release directory (`~/.local/share/factory-releases/<sha>`,
`pnpm install --frozen-lockfile`, `pnpm build`, smoke test `./dist/cli.js --version`), then the
`current` and `~/.local/bin/factory` links are renamed over atomically, including while factory runs
are active. A failed build changes nothing. Running processes keep their release (node runs the entry's
real path). The newest 3 releases are kept; a release a running process still has on its command line or
as its working directory, or that a live lock's process still has open, is kept as well and pruned on a
later check once it is unused. `deploy-self.sh once` checks once (`git ls-remote`; one `deploy: <result>`
line, exit 0 deployed/up to date, 1 error/build failed, 3 busy when another deploy holds the lock),
`ensure` starts a background loop (every 5 min) unless one runs, `status` prints
`state.json`; the log is `deploy.log` next to it. It needs `node`, `git`, `jq`, `flock` and a source clone in
`~/.local/share/factory` (paths and the interval via `FACTORY_DEPLOY_*` / `FACTORY_RELEASES`). Node is resolved like
the installed `factory` launcher: `FACTORY_NODE`, then `PATH`, then `~/.local/share/factory-node/bin/node`
(`factory doctor` reports the result).

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
`.factory/repo.yaml` (see below; `factory adopt` drafts it).

## Repo contract

```
.factory/repo.yaml         # checks, services, policies (required)
.factory/review-rules.md   # repo-specific review rules
.factory/checklist.md      # optional checklist reviewer items
.factory/verify/<area>.md  # verification guides per app area (not human-only: they evolve with the app)
.github/workflows/factory.yml   # CI stub, generated, never edited by hand
AGENTS.md                  # repo facts for every agent (purpose, commands, test strategy, do-not rules)
```

`repo.yaml` reference (every key is optional except what a run needs; defaults in brackets):

```yaml
base_branch: main
setup: "uv sync --frozen"            # once per worktree
checks:                              # tier: fast = every package and fix round, full = before the PR,
                                     # manual = never by the factory (CI workflow_dispatch only)
  - { name: lint, run: "nox -s lint", tier: fast }
  - { name: unit, run: "nox -s test_unit", tier: fast, paths: ["src/**", "tests/unit/**"] }   # paths: run only if touched
  - { name: db,   run: "nox -s test_db", tier: full, services: [db] }
  - { name: stack, run: "nox -s test_stack", tier: full, services: [stack], local_only: true }   # never in CI
services:                            # one instance per run; see Services
  - { name: db, start: "…", stop: "…", env: { DATABASE_URL: "postgresql://…:{port:db}/postgres" } }
  - { name: stack, host: true, start: "…", stop: "…", ports: [5432], env_from: { command: "…", map: { DB_URL: DB_URL } } }
env_command: ""                      # prefix for every check command (prefer secrets: below for secrets)
secrets: { provider: env_file, names: [DATABASE_URL] }   # checks, services, ui only, never agents; see Secrets
tests: { globs: ["tests/**"], run: "uv run pytest {files}", timeout_s: 600 }   # run enables the red-green proof; timeout_s caps it
sensitive_paths: ["src/auth/**"]     # security reviewer, fast-lane escalation, at least medium risk
human_only_paths: [".github/**", ".factory/repo.yaml", "AGENTS.md"]   # changed only as declared protected_changes
review: { max_rounds: 2, checklist: true, skip_paths: ["uv.lock"], max_nits: 5 }
fast_lane: { max_diff_lines: 150 }
merge:
  auto_merge_max_risk: none          # none | low | medium [none]; high is never auto
  policy: { low: human_review, medium: human_review }   # bot_review | human_review
  low_max_diff_lines: 300            # larger diffs are at least medium
limits: { max_diff_lines: 1500, max_wall_minutes: 240, stall_minutes: 15, command_timeout_minutes: 10, gate_timeout_minutes: 10, forbidden_paths: [".env*"], diff_exclude: ["src/gen/**"], diff_count_tests: true, stream_retries: 2, step_token_warn: 1000000 }
# limits.stream_retries [2]: same-model retries after a provider stream abort (0–5; 0 = off). The current
# agent call only. Auth, quota and invalid output are not retried. Exhausted retries end needs_human.
# limits.step_token_warn [1000000]: progress warning when one call's tokens_in reaches this (0 = off).
# limits.gate_timeout_minutes [10]: each gate check, base check and red-green proof is killed after this
# (600s) unless the check sets timeout_s or timeout_minutes. timeout_s (seconds) wins over timeout_minutes.
# tests.timeout_s caps the red-green command the same way. Effective timeout is min(that, remaining
# max_wall_minutes). The process tree is killed; the result is `timeout`, not a pass, and is not retried
# as flaky. A timeout of the repro on the base worktree is inconclusive (not a red repro) and is named in
# the run result. Progress and heartbeat events name the running check for `factory status`.
# Raising a timeout is a loosening (config_guard); lowering is not. `factory adopt` sets timeout_minutes
# from measured durations (5×, at least 5 min).
# limits.base_ci_wait_minutes [20]: pending CI on the base is polled this long (0–120; 0 = base_red at
# once); only red or a timeout ends the run as base_red. The wait does not count against max_wall_minutes.
# limits.base_red_resume_hours [48]: a base_red caused by GitHub CI on the base commit is resumed (same run
# id) once that commit is green or has no checks, if it stopped within this many hours (0–168; 0 = off).
# `factory gc` and the start of `factory run` do the check. A local fast-check base_red is not resumed.
# limits.pr_ci_wait_minutes [20]: after the PR is pushed, none and pending CI on the head are polled
# this long (0–120; 0 = one sample). Still none or pending does not fail the run and does not enable
# auto-merge (an auto policy becomes human_review). Only green enables auto-merge. Red CI ends it
# needs_human and marks the PR draft again. The wait is not work time.
# max_wall_minutes [240, 4 h] is active time: time the box was suspended (VM paused, laptop asleep) is credited
# back, as for the stall watchdog. It is enforced between steps, inside agent calls and before gate
# commands; the run ends needs_human ("… exceeded (N active min; M min box suspended, not counted);
# factory resume <run-id>"), the worktree keeps the work and resume re-runs the gates over it.
# Diff line limits (limits.max_diff_lines, fast_lane.max_diff_lines, merge.low_max_diff_lines) count
# added + removed lines since base (renames detected: a moved file counts only its changed lines; a
# move into or out of an excluded path counts as delete + add), without lockfiles (package-lock.json, pnpm-lock.yaml, uv.lock, …;
# not manifests), binary files and limits.diff_exclude (generated paths; test files under tests.globs
# always count, catch-all globs are rejected). The gate names what it left out:
# "943 lines (+533 excluded: package-lock.json; 4 binary files)". Lockfiles still are dependency
# changes for lane escalation and risk. Adding a diff_exclude entry is a loosening (config_guard).
# limits.diff_count_tests [true]: set false when test coverage would otherwise force a higher
# max_diff_lines. Files the test gates already classify as tests (`tests.globs`) are then left out of
# limits.max_diff_lines only. Production code, docs and fixtures outside those globs still count.
# fast_lane.max_diff_lines and merge.low_max_diff_lines still count test files, and diff_exclude is
# unchanged (it still cannot drop a test file). The gate detail, the run log and result.json
# (counted_lines, excluded_test_lines) report both numbers. Turning it off is a loosening (config_guard).
ui: { start: "…--port {port:app}", url: "http://localhost:{port:app}", paths: ["src/app/**"], pages: ["/"], devices: ["Desktop Chrome"] }
# ui.auth logs the evaluator in before the session; credentials are secret names, never inline values. See Evaluate.
verify:
  areas: [{ name: tours, paths: ["src/app/tours/**"], guide: ".factory/verify/tours.md", flows: ["tests/e2e/test_tours.py"], pages: ["/tours"] }]
  run: "uv run pytest {files}"       # runs recorded flows [tests.run]
harden: { max_proposals: 5 }
audit:                              # absent: no types enabled, `factory audit` refuses without a model call
  types: [security, performance, refactor, simplify]
  max_proposals: 5                 # 1..10; --max overrides
  thinking: { security: high, performance: high, refactor: medium, simplify: medium }
  focus:                           # optional; one note per type, injected only into that type's prompt
    security: "Privacy and GDPR: personal data in logs, fixtures, exports and retention."
git: { author: factory, email: "…" }
agent_env: []                        # extra env var names for agent tools and checks
docs_lookup: { roles: [plan, implement, fix] }   # steps with the Context7 docs tool [profile's list]; [] = off
ci: { toolchains: { uv: true, python: "3.12" } }  # what the CI stub installs [detected], see CI
models: {}                           # per-repo role chains, see Model configuration
concurrency:                     # parallel runs; see Parallel runs [max_runs 1]
  max_runs: 1                    # 1..32 lock slots; raising it is a loosening
  exclusive_paths: []            # globs that run alone (e.g. supabase/migrations/**); removing one is a loosening
pr:
  host_steps_section: "Mac install steps"   # omit to leave host steps out of the PR; see Risk & Security
```

`repo.yaml` defines *when* a check runs, the command (nox session, npm script) *how*; the CI workflow is
wiring. The JSON Schema of every contract is in [`schemas/`](schemas/).

## Protected config

`human_only_paths` (by default `.factory/**` and `.github/workflows/**`; `.factory/verify/**` is never
protected) are the CI and factory config. A run may change them, the sanctioned way:

1. **Declared in the plan.** Each file is in a package's `files` and in
   `protected_changes: [{ file, change, reason }]` (exact paths, no globs). A protected file in `files`
   without a declaration, or a declaration outside `human_only_paths`, makes the plan invalid. The plan
   reviewer checks that each change is required by the task and that the diff matches it.
2. **Checked against the base.** The run's `repo.yaml` (checks, policies, secrets, models) is read from the
   base commit, never from the user's checkout or the run branch, so a changed check list takes effect only
   after a human merged it. The `protected_paths` gate fails on any undeclared protected file, and the
   config guard fails on `repo.yaml` loosening even when declared (see Gates).
3. **High risk, no auto-merge.** Risk is `high`, so the recorded merge policy is `human_review` whatever
   `merge:` says (never auto-merge). The PR gets the label `factory:protected-config` and a "⚠️ Changes
   protected config (CI / factory)" section with each declared change and the exact diff of the protected
   files. CI on the PR runs the changed workflow files.

Agents still never get secret values; a protected change does not change what agents see.

These rules bind agents *inside a run*. Outside a run, the repo's own bot maintains its factory config
(`.factory/repo.yaml`, `.factory/review-rules.md`, `AGENTS.md`) through normal PRs from its clone; a human
still reviews and merges them (see [docs/BOTS.md](docs/BOTS.md#who-changes-what)). Factory code, the global
config and model choice are changed in this repository via Cloud Agent PRs (not `factory run` on this repo).

## Parallel runs

`concurrency.max_runs` (default 1) is how many factory runs may hold the repo at once. Each run still has its own worktree, run directory and branch. The lock is N slot files under `$FACTORY_HOME/locks/`, named `<owner>-<repo>-<hash>.lock` (further slots `.<n>.lock`). The hash is of the canonical origin (`host/owner/repo`, credentials and `.git` stripped), so a URL with an embedded token never becomes a filename. A live lock left under the old sanitized-URL name still blocks the repo; a stale one is deleted.

With `max_runs` above 1 the branch is `factory/<task>-<slug>-<run id>-s<slot>`, and port slots prefer lock slot + 1 (`{port_offset}` stays per run). Fixed host ports (`host: true` plus `ports`) are not shifted: the second run that needs them ends `env_missing`. `factory doctor` reports `max_runs`, `exclusive_paths` when set or when `max_runs` is above 1, and warns in that fixed-port case.

After the plan names files, the run publishes those paths. Overlap with another live run's paths (a directory covers its children; `src/auth` does not cover `src/authz`; globs match either way) waits with `--wait` or returns `locked`. A plan that touches `exclusive_paths` is exclusive with every other such plan, even when the files differ — use it for database migrations (`supabase/migrations/**`). A run that is still planning has no paths yet and does not block; the later one yields. `factory gc` metadata archive takes every slot first. Worktree cleanup does not: it uses a short git-ops lock so a busy repo still loses merged worktrees (see Cleanup).

`concurrency` is read from the checkout's `.factory/repo.yaml` at the start of the run. `pr.host_steps_section` is read from the base commit, with the rest of the PR policy.

## Risk & Security

The PR body has a single **Risk & Security** section: whether the diff touches data/migrations, auth/permissions, secrets handling, prod deploy/infra, or dependencies (yes/no plus a short note), then the overall rating and a one-line reason. The rating is the same `risk` as `result.json`. Merge policy stays on the result and in `factory status`; the PR body does not recommend a merge.

When the change needs manual steps on the production host (launchd plists, restic, Docker Desktop, files outside the repo), the plan includes `host_steps`: `{ commands, verify, rollback }` with the commands in order. The section is rendered only when both that object and `pr.host_steps_section` are set; the heading is the configured title (for example `Mac install steps` on tourenpilot-ops, see [docs/examples/tourenpilot-ops.yaml](docs/examples/tourenpilot-ops.yaml)). Other repos leave the key unset. An empty plan omits the key, and the section is omitted with it.

## Model configuration

Layers, most specific wins, each replacing whole role chains:

1. built-in `profiles/default.yaml`;
2. your user profile `$FACTORY_HOME/profile.yaml` (default `~/.factory/profile.yaml`);
3. `--profile <name|file>` for one invocation (experiments);
4. the repo's `.factory/repo.yaml` `models:`.

```yaml
# ~/.factory/profile.yaml
providers: { allow: [opencode-go, openai], deny: [opencode] }   # only here or built-in
billing: { opencode-go: subscription, openai: subscription }    # only here or built-in
sandbox: preferred                                              # only here or built-in
retry: { base_ms: 2000, max_ms: 60000, attempts: 4 }            # same-model backoff on capacity and dropped-connection errors
env: { implement: [MY_TOOL_TOKEN] }                             # extra env var names per role
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

`billing` names each provider's billing kind: `subscription` usage is reported in tokens (PR body, `stats`),
`metered` usage in USD. Unlisted providers are metered; the built-in default lists
`opencode-go` and `openai` as subscriptions.

## Docs lookup (Context7)

Planner, implementer and fix rounds get a `docs_lookup` tool (`library`, `topic`, optional `version`):
it resolves the library on [Context7](https://context7.com) (`GET /api/v2/libs/search`) and returns
current docs for the topic (`GET /api/v2/context`, at most ~3k tokens per call, cached per run). The tool
runs in the factory process, not in the sandbox, and only talks to `https://context7.com` (redirects are
not followed). Every call is a `docs_lookup` event (library, resolved id, topic, estimated tokens, status);
errors and rate limits come back to the model as a tool error, never fail the run.

The API key is optional: without one Context7 serves an anonymous, lower rate limit; set
`CONTEXT7_API_KEY` in the factory's environment for your plan's limit. The key is sent only as the bearer
header to Context7, never to agent processes (`NEVER_PASSED`), and redacted from logs. Choose the steps
with `docs_lookup: { roles: [...] }` (`plan`, `implement`, `fix`, `review`, `evaluate`) in a profile
layer or in repo.yaml; `roles: []` turns it off. `factory doctor` checks that Context7 is reachable and
that a configured key is accepted. Evals use the profile's setting, so `factory experiment` can compare
with and without it.

## Secrets

Checks, red-green test runs, services and the app the evaluator starts often need secrets (a database
URL, an API key). Declare them per repo; the values never reach agent sessions, their tools, bash or prompts:

```yaml
# .factory/repo.yaml: a dotenv file outside the repo
secrets: { provider: env_file, path: ~/.factory/secrets/shop.env, names: [DATABASE_URL, STRIPE_KEY] }

# or a generic wrapper that runs a command with the secrets in its env (a secrets manager CLI)
secrets:
  provider: command
  command: "vault-cli run --"               # the factory runs `<command> env -0` and keeps `names`
  credentials: ~/.factory/secrets/shop.env  # the wrapper's own auth vars (optional), only for the wrapper
  names: [DATABASE_URL, STRIPE_KEY]
```

- The factory resolves the names once per run (and on `resume`), in the user's checkout, outside the
  sandbox; a name that does not resolve stops the run with `needs_human` before any agent call. Files
  (`path`, default `~/.factory/secrets/<repo name>.env`, and `credentials`) must lie outside the
  repo with mode `0600`. `<repo name>` comes from the origin URL (`git@github.com:me/shop.git` → `shop.env`),
  so every clone shares it; without an origin it is the checkout directory's name. A file still named after
  the checkout directory is used while `<repo name>.env` does not exist; `doctor` warns to rename it.
- Values go only to checks, red-green runs, services, the ui and recorded flows, through the process env
  (jailed commands too: never on a command line). Agent tool processes never get them, even when a name
  is also in `agent_env`; the secret files are hidden from the jail.
- The wrapper gets the base env (`PATH`, `HOME`, locale) plus the `credentials` variables; those stay
  with the wrapper and are never passed to checks or agents.
- Every value (and every credential) is redacted by exact match from events, run files (service logs
  included), gate output, prompts, browser tool results, PR title and body. Values shorter than 6
  characters are not redacted; `factory doctor` warns about them.
- `factory gates` resolves them too, unless the caller's env already sets every name (CI).
- `factory doctor --repo` checks the file (outside the repo, `0600`) and that every name resolves, by
  count, never printing a value. `factory adopt` drafts the block from `.env.example` names (never
  values): the `command` provider with the Infisical login-then-run command below (project id from
  `.infisical.json` `workspaceId`) when the repo has `.infisical.json`, else `env_file`.

Example: Infisical with a per-repo, read-only machine identity (nothing in the factory is
Infisical-specific; any CLI that runs a command with secrets in its env works the same way):

1. In the Infisical project, create a project role (e.g. `factory-read-dev`) that may only **read**
   secrets, restricted to the `dev` environment. Custom roles need a paid plan; on the free plan give
   the factory its own small project (only the dev secrets it needs) and add the identity as *Viewer*.
2. Create a machine identity per repo (e.g. `factory-shop`, organization role *No Access*) with
   Universal Auth, add it to the project with that role, and create a client secret.
3. Write its credentials (and `INFISICAL_DOMAIN` for EU Cloud or self-hosting) to the credentials file:

   ```sh
   install -m 600 /dev/null ~/.factory/secrets/shop.env
   printf 'INFISICAL_CLIENT_ID=%s\nINFISICAL_CLIENT_SECRET=%s\nINFISICAL_DOMAIN=https://eu.infisical.com\n' "$ID" "$SECRET" >> ~/.factory/secrets/shop.env
   ```

4. Let the wrapper log in with them for each resolution, then run with that token. Without a login
   session a bare `infisical run` falls into the interactive login flow and fails. The token stays in
   an unexported shell variable, so it never reaches the resolved env:

   ```yaml
   secrets:
     provider: command
     command: >-
       t="$(infisical login --method=universal-auth --client-id="$INFISICAL_CLIENT_ID"
       --client-secret="$INFISICAL_CLIENT_SECRET" --domain="${INFISICAL_DOMAIN:-https://app.infisical.com}"
       --silent --plain)" && infisical run --token="$t" --projectId=<project-id> --env=dev
       --domain="${INFISICAL_DOMAIN:-https://app.infisical.com}" --
     credentials: ~/.factory/secrets/shop.env
     names: [DATABASE_URL, STRIPE_KEY]
   ```

   `<project-id>` is the `workspaceId` in `.infisical.json`; a failed login stops the wrapper before
   `run`. Only when you are logged in yourself (`infisical login`) is the plain
   `infisical run --env=dev --` enough. Then run `factory doctor --repo <path>`.

Residual risks: checks run code the agents wrote, so a test can read a value from its env and encode it
somewhere exact-match redaction does not catch (e.g. base64 into a file in the worktree), or send it
over the network; use dev-only, read-only, low-value secrets. Screenshots and videos are not redacted.
With `sandbox: off` agents can read the secret files themselves.

## Sandbox (Linux)

Agent bash, repo `setup`, gate checks and red-green test runs are jailed with bubblewrap inside a pasta
network namespace: only the run's worktree and agent HOME are writable, git metadata is
read-only, host loopback, Docker bridge, metadata service and LAN are unreachable, the internet works.
Jailed commands run as the factory's own uid/gid with all capabilities dropped (never root, so file
permissions apply as in CI). File tools (read, write, edit, grep, find, ls) stay confined to the
worktree even when no OS sandbox is active (`sandbox: off`, or `preferred` degraded to unjailed).
Set `sandbox: required | preferred | off` in
`~/.factory/profile.yaml` (default `preferred`, which degrades with a warning). Needs `bwrap`
(bubblewrap), `pasta` (passt) and `ip` (iproute2); `factory doctor` shows what is in effect.

## Services

Checks that need a database or a dev server name it: `services: [db]` on the check, plus a `services:`
entry in `repo.yaml` (`start` in the foreground, optional `ready`/`stop`/`env`). The factory starts it once
before the first check that needs it and stops it at run end. Ports come from a per-run slot, so parallel
runs never collide: `{port:web}` (a named port), `{port:5432}` (a default port shifted by the slot) and
`{port_offset}`. In the sandbox a service must listen on `0.0.0.0`; only its own ports are forwarded, and
only to the checks that use it. `host: true` runs it outside the sandbox (e.g. Docker); `doctor` warns.
`factory doctor --repo . --services` starts and stops each service once (and resolves `env_from`).
`stop` runs at run end whatever the result (done, red gates, needs_human, max_wall_minutes, SIGINT/SIGTERM),
and when the service fails to come up; a second signal exits at once and skips it.

**Host stacks with fixed ports.** A tool that runs its own containers (a local database stack via Docker)
cannot run in the sandbox (no Docker socket) and usually listens on ports from its own config. For it:

- `host: true` plus `ports: [...]`: the fixed host loopback ports. Checks that name the service reach exactly
  these ports from the sandbox (pasta forwards); the default ready probe waits until all of them accept and
  hold a connection. Agents get no forwards. The ports are not shifted, so there is one instance per box:
  the service claims `$FACTORY_HOME/ports/host-<port>.json` while it runs, and another run, a manual
  `factory gates` or `doctor --services` that needs it ends with env_missing instead of restarting the stack
  under a running check. Inside one run, the evaluator's base capture shares the running instance.
- `env_from: { command, map }`: after the service is ready, `command` runs on the host (worktree, the
  service's env) and prints `KEY=VALUE` lines (dotenv: quotes and `export` allowed, other lines ignored);
  `map` is target name → printed key. The targets go only to the checks (and recorded flows) that need the
  service, never to agents (repo.yaml rejects a target listed in `agent_env`). Every value it prints is
  redacted like a secret (events, run files, gate output in prompts, the PR). A missing key or a non-zero
  exit is env_missing.
- `local_only: true` on the check: CI (`CI` set, as on GitHub Actions) does not select it, so the CI stub
  never needs the stack; factory runs and local `factory gates` run it. `doctor` warns about a CI check that
  needs a fixed-port service.

The repo owns every step: what `start` does (start the stack, restore a data snapshot, apply new
migrations), what `stop` does (restore the snapshot) and what the status command prints. Example for a
Docker-based database stack whose CLI prints its connection settings as `KEY=VALUE`:

```yaml
services:
  - name: dbstack
    host: true
    start: "dbstack start && scripts/db-snapshot.sh restore && dbstack migrate --pending"
    stop: "scripts/db-snapshot.sh restore"
    ports: [55431, 55432]            # from the stack's own config
    ready_timeout_s: 300
    env_from:
      command: "dbstack status --format env"
      map: { APP_DB_URL: DB_URL, APP_API_URL: API_URL, APP_API_KEY: SERVICE_KEY }
checks:
  - { name: test_db, run: "uv run pytest tests/db", tier: full, services: [dbstack], local_only: true }
```

Runs of one repo share `concurrency.max_runs` lock slots (default 1). A manual `factory gates` takes no lock (it only meets a run on
the fixed-port claim above). With `max_runs` above 1, shifted ports follow the lock slot; fixed host ports stay one instance per box, and `factory doctor` warns. Residual risk as for secrets: checks run agent-written code with these
values and reach the stack's ports (for a local database usually as its superuser, inside its containers);
use a dev-only stack with demo data. A `start` that prints keys puts them in the service log, which is
redacted at run end once `env_from` resolved them.

## Evaluate (UI)

With a `ui:` block in `repo.yaml` (start command, URL, `paths`), every round whose change touches `ui.paths`
first runs the evaluator, before the reviewers:

- the app starts (with its services, in the sandbox); recorded flows of affected `verify.areas` run via
  `verify.run` (`{files}`, `BASE_URL`); a red flow in an area the plan does not declare in `changes_flows`
  is a regression bug;
- `ui.pages` and the affected areas' `pages` are captured on HEAD and on the base commit for each device in
  `ui.devices` (Playwright names; use a phone such as `iPhone 15` or `Pixel 7` for the web build of an
  Expo / React Native Web app); new console errors and failed requests are bugs; pixel diffs are evidence;
- `verify: evaluator` criteria are checked by the `evaluate` role with browser tools (`goto`, `click`,
  `fill`, `text`, `screenshot`, `console`, `network`), a screenshot per criterion and a recorded video/GIF.

`ui.auth` logs in before that session, in Playwright, not through the model. The factory opens
`login_path`, fills the `fields` selectors (`user`, `password`, `submit`) and waits until `success`
(a path such as `/app`, a Playwright URL glob such as `**/app`, or a selector). It keeps the browser
storage state (cookies, localStorage, IndexedDB) and starts the page captures and the evaluator session
with it, so the model never sees the password and the session video does not include the login form.
An optional `setup` command runs first, in the worktree, with the same secrets as checks (seed a test
user); it also runs before recorded flows. Credentials are names, never inline values:

- `{ secret: NAME }` — resolved by the repo's `secrets:` provider (the same values checks and services get);
- `{ env: NAME }` — a `NAME=value` line printed by `setup` (required when any credential uses `env`).

Values are added to the run's redaction list before login and never written into events, tool output,
screenshot metadata or the PR. A value shorter than 6 characters is not redacted (it would match inside
other words); doctor already warns about short secrets. `factory doctor --repo .` checks that the
selectors are set, that `secret` names resolve, and that credentials are names rather than inline values.
It does not run `setup`. A failed login on HEAD ends the run as `needs_human`; a failed login against the
base commit is reported as a missing base comparison.

```yaml
ui:
  auth:
    login_path: /login
    fields: { user: "#email", password: "#password", submit: "button[type=submit]" }
    success: { url: "/app" }                # or { selector: "[data-logged-in]" }
    credentials:
      user: { secret: EVAL_USER }           # name in secrets:
      password: { secret: EVAL_PASSWORD }   # or { env: EVAL_PASSWORD } printed by setup
    setup: "node scripts/seed-test-user.mjs" # optional; required for env credentials
```

Any evaluator bug skips the reviewers that round and goes to fix. Evidence is pushed to the orphan branch
`factory-evidence` (one folder per run, pruned after 30 days by `factory gc`) and embedded in the PR.
Needs the Chromium headless shell (`npx playwright-core install --only-shell chromium`) and `ffmpeg` for
GIFs; `factory doctor --repo .` checks both.

## CI

`factory ci-stub [--ref <tag>] [--repo <path>] > .github/workflows/factory.yml` writes the CI stub (`--ref` defaults to `v<version>`, the release tag of the installed factory; `--repo` defaults to the current directory). When a non-manual check is not `local_only`, on every pull request it
selects the checks with the same code as a local run and runs each one (`factory gates --run`).
It does not run on pushes to the base branch (the PR run already checked the merged tree; a base commit
without check runs makes the factory run the fast checks locally). It does run on tags `v*` and on
`workflow_dispatch`. Those runs pass `factory gates --select --all` (every check of the tier): a
release tag is a commit already on the base, so a diff against `origin/main` would select nothing
path-scoped. Only a newer push to the same PR
cancels a run, so no cancelled check marks a base commit red. The npx install of the pinned factory is
cached per ref. The tool baseline those checks implement is [docs/BASELINE.md](docs/BASELINE.md): one
stub, not a reusable workflow, because doctor hashes this file and branch protection requires `done` when the stub runs checks.

**Required status check:** `done`, the stub's last job, when the stub runs checks. GitHub Actions reports a check run under its job
name without the workflow name, so branch protection (or a ruleset) must require `done` from GitHub
Actions; requiring `factory / done` blocks every PR, because nothing ever reports that context
(`factory doctor --repo .` warns about it). When no check runs in CI, do not require `done`.

**Draft pull requests.** The pipeline opens every PR as a draft and pushes while it is still a draft.
It marks the PR ready only after the local gates have passed and that push has finished, and only
then waits for GitHub CI. A local failure does not mark the PR ready; a PR that was already ready
is converted back to draft (`gh pr ready --undo`) before the push. On a draft `pull_request` the
stub does not run `select` or `check`. `done` still runs and exits non-zero. A skipped required
check counts as passed, so skipping `done` would be a green gate. `ready_for_review`, and
`synchronize` / `reopened` on a PR that is not a draft, run the full matrix. `converted_to_draft`
cancels an in-flight full run and fails `done`. Tags `v*` and `workflow_dispatch` still pass `--all`.
The decision uses the draft flag on the event, never the author, branch, labels, or PR text.

A failed draft `done` does not by itself end the factory run: while no select/check suite has
finished, that failure is still pending and the run keeps polling. A real failure is red
immediately. The latest completed run of a check name wins, so the draft failure does not stick
after the ready run succeeds, and converting the PR back to draft fails `done` again. A skipped
`done` is red to the factory.

**Downstream rollout.** Merging this repository does not change private repos. After the change is
merged and tagged, update the stub in order: tourenpilot, then tourenpilot-ops, then pm, each with
`factory ci-stub --ref <tag>` in its own PR. Actions minutes in those repos stay as they are until
that stub is running and a draft event shows `done` failing with `select` and `check` skipped, and
the following ready event shows the full matrix on that head.

**Local-only checks:** `local_only: true` checks (a host stack CI does not have, see Services) are left out
of the selection when `CI` is set, so the stub neither lists nor runs them; the factory runs them locally
before the PR. When every non-manual check is `local_only` (or there is none), `factory ci-stub` renders
`templates/ci/factory-minimal.yml` instead: `done` only, no npx, no `select`, no `check`. It fails on a draft
or a cancelled run and succeeds on a ready pull request. Doctor accepts that file for those repos and does
not suggest requiring `done` (it gates nothing beside the repo's own jobs). A repo that still has a CI check
keeps the full stub.

**Toolchains:** GitHub runners (`ubuntu-latest`) have node and python3 but no pnpm or uv. Before the
checks, the stub installs what `factory gates --toolchains` resolves for the repo: `pnpm/action-setup`
(pnpm lockfile or `packageManager: pnpm@…`; the `packageManager` version, else pnpm 10), `actions/setup-node`
(`.nvmrc` / `.node-version`, never below 22, the factory runs on it; default 22), `actions/setup-python`
(`.python-version`; otherwise the runner's python3 or the one uv picks) and `astral-sh/setup-uv` (`uv.lock` or
`[tool.uv]` in `pyproject.toml`). `ci.toolchains` in repo.yaml overrides field by field: a version string,
`true` (install, default version) or `false` (never), e.g. `ci: { toolchains: { uv: "0.9.5", python: "3.12" } }`.
`factory doctor --repo .` and the adopt PR show the result; `repo.yaml setup` no longer has to install tools.

`factory doctor --repo .` checks the file is the unedited template of the installed factory for its ref.
The template belongs to the factory version, so after a factory upgrade with a template change the stub
differs until its pin is bumped (`factory ci-stub --ref <new tag>`); bumping the ref is a deliberate PR.
The ref is the pinned git commit or tag (CI runs that ref through `npm exec` on npm 11.21.1, because Node 22's npm 10.9.9 cannot pack a `github:` spec).

## Adopt

`factory adopt --repo <path> [--ref <tag>]` (default `v<version>`) onboards a repository in one PR (branch `factory/adopt`, from the
base branch; the user's checkout is not touched):

- **Detect** (code): stack (node: package manager and scripts; python: uv/poetry/pip, nox sessions or
  ruff/mypy/pytest; rust; go), test files and the command that runs specific ones, UI, database, cloud/secrets,
  CI workflows and special jobs (gitleaks, pip-audit, cosign, `systemd-analyze` …). Mutating commands
  (`--fix`, `--write`, `format` without `--check`, …) become their read-only variant or are skipped, never a
  check that rewrites files; identical commands are drafted once.
- **Measure**: setup and every check once in a clean base worktree, in the sandbox (`--no-measure` skips).
- **Draft**: `.factory/repo.yaml` (the CI toolchains detected for the stub as a header comment; tiers: e2e/build, CI `services:` or > 120 s → `full`; secrets or failing on
  the base → `manual`; reasons as comments), `.factory/review-rules.md`, the CI stub for `--ref`, and
  `AGENTS.md`: a full template (purpose, stack & commands, test strategy, architecture, conventions, domain,
  data & secrets, do not, verify) when there is none, else a "Test strategy" section when missing.
- **Legacy setup**: Claude Code (`CLAUDE.md`, `.claude/`), Cursor rules and Bugbot, opencode and grok configs,
  workflows running coding bots, and PR/push workflows whose every command a drafted check covers are deleted
  in the same PR. Operator tooling (commands, skills, agents someone runs by hand), skills with scripts, other
  assistants' files, uncovered or special workflows are only proposed. Review rules from removed review
  configs are migrated into `.factory/review-rules.md`. In `AGENTS.md`, rules and commands under
  tool-specific headings move to "Do not" / "Stack & commands"; workflow sections are proposed for removal.
  Duplicate rules across AGENTS.md and CLAUDE.md and a CLAUDE.md that differs from AGENTS.md are warnings.
  Deploy, release and scheduled workflows stay. `--keep <glob|path|dir>` (repeatable) spares paths. The PR
  description lists every removed, proposed, kept and moved item and every warning.
- **Baseline plan** (`plan_medium`): saved as ticket `<date>-adopt` with one proposal (see Harden); run it after the merge
  with `factory run --plan <plan_path>`. An invalid plan is noted in the PR, not fatal (`--no-plan` skips).
- **Settings** are never changed: branch protection (required check `done`, omitted when no check runs in CI) and auto-merge are printed hints, so
  no admin token or GitHub Pro is needed. `--no-pr` commits the branch locally only. An adopted repo (with
  `.factory/repo.yaml`) is refused unless `--force`.
- **After the merge**: if the repo has tests, check that `tests.globs` and `tests.run` are set (bug plans
  stop with `needs_human` without `tests.run`; adopt prints a hint when it found tests but no runner). The
  repo bot sets up its webhook routine and writes its own `notify.yaml` entry, then runs
  `factory notify test <owner/name>` (checklist in [docs/BOTS.md](docs/BOTS.md#onboarding-checklist-new-repo--new-bot)).

## Harden

`factory harden --repo <path>` (weekly or by hand) turns recurring problems into deterministic checks, one
proposal at a time. State lives outside the repo in `$FACTORY_HOME/memory/<repo>/`:

1. **Lifecycle** (per proposal): an open proposal whose factory run (matched by its plan file, plan goal or
   `resolves_findings`) merged is `resolved` (its findings too); all its PRs closed, or no merged/open PR after
   28 days, is `dropped` and its findings are reopened.
2. **Compaction** (`plan_medium`, no tools): near-duplicate open findings are merged; counts, runs and dates
   are merged in code (`--no-compact` skips).
3. **Signals** (code): findings seen twice or checkable, flaky checks, unchecked checklist items, a 30-day
   CI audit via `gh` (failure/flaky rates, median/p90 durations, minutes per week, checks that never fail,
   slow checks without `paths`, CI stub behind the latest factory tag), run stats, stale verify guides,
   reverted factory PRs, pages the evaluator verified repeatedly without a recorded flow.
4. **Metrics**: one line per call in `metrics.jsonl` (determinism ratio, open findings, CI minutes, flaky,
   done and revert rate, median rounds).
5. **Ticket** (`harden` role, read-only tools): ONE file `proposals/<date>.json` with up to 5 ranked proposals
   (`repo.yaml` `harden.max_proposals`, `--max`), each validated as a plan (one retry; overlapping or invalid
   ones are dropped and listed), with its own `<date>.<rank>.plan.json`; their findings become `proposed`.
   No signals, no LLM call. A proposal may change `.factory/` or CI files only as declared
   `protected_changes` (see [Protected config](#protected-config)). Each proposal is its own run and PR:
   `factory run --plan <dir>/<date>.<rank>.plan.json`.

## Audit

`factory audit --repo <path> --type security|performance|refactor|simplify` judges the repository against its
purpose in one dimension and writes a ranked list of proposals. It does not schedule itself and it does not
start the runs. A type runs only when it is listed in `audit.types`. With no `audit` block every type is
refused (exit 1, no model call).

The session is read-only (the same tools as harden's ticket step). Roles `audit_security`,
`audit_performance`, `audit_refactor` and `audit_simplify` default to the strongest plan chain (`plan_high`'s
model) and are overridden by the profile layers like every other role, including `models:` in repo.yaml.
`audit.thinking` sets the reasoning level for that call (default high for security and performance, medium
for refactor and simplify) and replaces the thinking level on the chain. One call, one type.

The model sees open findings from memory, the latest `metrics.jsonl` line, and — for `performance` only —
harden's CI audit. There is no fixed checklist. `audit.focus.<type>` is an optional short note for that
dimension only (a string, or a list of bullet points, at most 2000 characters once joined). It is added to
that type's prompt as data and to no other prompt; the role prompt stays the same. The note says what to
weigh, it does not add a checklist. A security audit can be pointed at privacy and GDPR — personal data in
logs, fixtures, exports and retention — without changing performance, refactor or simplify. Leave `focus`
out and the prompt is unchanged. Do not put secrets or customer data in it.

Output reuses the proposal pipeline: ticket
`proposals/<date>-audit-<type>.json`, plan files `<date>-audit-<type>.<rank>.plan.json`, the same plan
validation (one retry; overlapping or invalid proposals are dropped and listed), and the same lifecycle
(a later `factory audit` or `factory harden` marks a proposal `resolved` when its factory PR merges, or
`dropped` when the PR is closed or the ticket goes stale). A proposal may change `.factory/` or CI files
only as declared `protected_changes`. Findings it names become `proposed`.

```bash
factory audit --repo <path> --type security
factory run --repo <path> --plan <plan_path>
```

`--json` matches `schemas/audit.schema.json`. `factory status` and `factory stats` list open audit tickets
per repository (`stats --repo` limits the list to that repo).

A practical rhythm, run by the repo's bot (see [docs/BOTS.md](docs/BOTS.md#audit)): security and performance
weekly, alongside harden; refactor and simplify monthly. Only enabled types.

## Evals and experiments

```
factory eval --validate                                   # tasks sane? (no agents)
factory eval --profile baseline --repeat 2                # pass rate, cost, time, real findings
factory experiment --base baseline --variant my-variant.yaml --repeat 2   # JSON verdict
```

Results go to `evals/results/<date>.jsonl` and `.md`. Every eval run spends real model time; see
[`evals/README.md`](evals/README.md) for the task format, metrics and the decision rule.

## Fast lane

`factory run … --lane fast` is for small, single-package changes: the task is translated by `plan_normalize` (no planner), gates run as usual, `plan` and `simplicity` review in one session and there is at most one fix round. The run moves to the standard lane when `plan_normalize` stays schema-invalid (it then falls back to the planner), when the task needs more than one package, or after implement when the diff exceeds `fast_lane.max_diff_lines` (default 150) or touches dependencies, `sensitive_paths`, `human_only_paths` or migrations. Escalations are logged, listed in the PR and recorded as `lane: standard` in `result.json`. They are not a risk reason: risk is paths, diff size (`merge.low_max_diff_lines`) and protected files only.

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
(not readable via API). `--ping` sends one tiny request per model. With `--repo` it checks repo `secrets:` (see Secrets), `gh` and gives
hints on auto-merge and branch protection (neither needs admin rights or GitHub Pro). The run applies the
same Zen and ChatGPT-login rules before every agent session. It also checks `~/.factory/notify.yaml`
(`0600`, valid, key files readable) and lists the repos with a hook, never the URLs; with `--repo`, it warns
when that repo has none.

Log in once for the factory: `PI_CODING_AGENT_DIR=~/.factory/pi npx pi`, then `/login` (ChatGPT for OpenAI,
API key for OpenCode Go).

## Status, stats, cleanup

```
factory status [--json]                     # running, queued, stalled, orphaned, waiting, interrupted; open factory PRs; open audit tickets
factory stats --since 7d [--repo <path>] --json  # results, rounds, gates, providers, cost vs the previous 7 days; open audit tickets
factory gc [--dry-run] [--scheduled] [--force] [--retention-days 7] [--strip-after-hours 12] [--archive-days 90] [--json]
factory abandon <run-id>          # mark abandoned, release a stale lock, remove the worktree; keep result and logs
```

What `gc` cleans (see [docs/GC_RETENTION.md](docs/GC_RETENTION.md) for defaults and scheduling):
- **PR merged or closed:** worktree, local `factory/*` branch, and the remote branch only if nobody pushed to it after the factory.
- **No PR** (failed, needs_input, needs_human, interrupted): worktree after 7 idle days (failed) or 14 days (needs_input / needs_human / base_red); branch kept unless unpushed commits block removal.
- **PR open, run finished,** idle for `--strip-after-hours` (default 12): only `node_modules`, `.venv` and `.nox` at the worktree root.
- **needs_input** with no answer for 2 working days (Mon–Fri, Europe/Berlin, from `state.updated_at`): the run is abandoned (worktree removed, result and logs kept) and the repo's notify hook is POSTed so the bot can tell the owner. A live lock is left alone.
- **Sandbox home/** after 24 h idle (no repo lock; a live run is kept): terminal runs, and `needs_input` / `needs_human` / `base_red` whose PR is already merged or closed. An open or missing PR keeps `home/`. **Metadata** tarballed to `$FACTORY_HOME/archive/runs/` after 90 d (180 d for failed), keeping the newest 20 runs per repo; **archive/runs** tarballs dropped after 180 d. Protected: active runs; needs_input / needs_human / base_red worktrees and metadata while idle &lt; 14 d; unpushed commits; dirty worktrees (no `--force` on `--scheduled`).

`factory abandon <run-id>` does the same abandon by hand (stale lock released; a process that is still running must be stopped first). The branch is kept. `factory resume` refuses an abandoned run.

A `base_red` that stopped because GitHub CI on the base commit was red or still pending is resumed by `factory gc` and by the start of `factory run`, once that commit is green or has no checks and the run is younger than `limits.base_red_resume_hours` (default 48). The same run id continues; the bot gets another `run_finished`. `--dry-run` does not resume. Local fast checks that failed on the base are not resumed. The daily cron below is the timer when nothing else starts a run.

A live run (one that holds a lock slot) is left untouched, and a worktree with uncommitted changes needs `--force`. Removing `home/` does not take the repo lock. Worktree removal and local `factory/*` branch deletion take a short `factory.gitops.lock` in the git common dir (the same lock as `git worktree add` / `remove` / `prune` elsewhere) and wait up to 60s for it, so they proceed while another run of the repo is active. Metadata archive still takes every slot. When deploy-self's `once` holds its deploy flock, gc skips deletions; the flock dies with that process, so a finished deploy cannot skip the daily run permanently.
`factory run` starts with the same gc, best effort: at most 60 s, no `--force`, no evidence pruning, a 5s git-ops wait, and a failure never stops the run (`FACTORY_NO_AUTO_GC=1` turns it off). The base_red resume sweep still runs.
Evidence pruning (30 days) runs only with an explicit `factory gc`. On this box the scheduled gc already runs daily at 04:30 via supercronic, supervisord program `factory-gc`, with `gc.retention.dry_run: false` (see [ops/supercronic/factory-gc.crontab](ops/supercronic/factory-gc.crontab) and [docs/GC_RETENTION.md](docs/GC_RETENTION.md)). The built-in profile default remains `dry_run: true` until a box flips it after reviewing `$FACTORY_HOME/gc.log`.
`factory doctor` reports space and inode usage of the filesystems holding `$FACTORY_HOME` and the temp dir: warn from 85 %, fail from 95 %.

## JSON contracts

Machine-readable outputs have JSON Schemas in [`schemas/`](schemas/): `result.json`, `events.jsonl` lines,
`status`, `stats`, `gc` and `doctor` with `--json`, the findings memory, the reviewer outputs, eval tasks,
eval profiles, eval result lines and the experiment verdict. They are
generated from the zod schemas in code (`pnpm schemas`); a test keeps them in sync.

## Releases

Versions and tags come from [Release Please](https://github.com/googleapis/release-please)
(`.github/workflows/release-please.yml`, `release-please-config.json`, `.release-please-manifest.json`).
On every push to `main` it updates one release PR (`chore: release <version>`) that bumps `package.json`
and `CHANGELOG.md` from the conventional-commit squash titles since the last tag (`feat` → minor and
`fix` → patch while below 1.0; `docs`, `ci`, `chore` and `test` alone cut no release). A human merges the
release PR per the merge matrix; the workflow then tags `v<version>` and publishes the GitHub release.
Tags are what `factory ci-stub --ref` and `adopt --ref` pin. The box deploy is separate: `deploy-self.sh`
builds every new `main` commit (a merged release PR is just one more), never a tag.
The release PR and the tag are pushed with `GITHUB_TOKEN`, which starts no workflows: run
`gh workflow run ci.yml --ref <release-branch>` so the required `check` reports before the merge.

## Development

```
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

Tests never call an LLM, the network, `gh` or `git push`: agents are the scripted `FakeRunner`
(`test/fixtures/scripts/*.json`), GitHub is `FakeGitHub`, and E2E tests create a fixture git repo from
`test/fixtures/repo/` (or the web app in `test/fixtures/ui-repo/`) in a temp dir per test. Evaluate tests
drive a real headless shell against the fixture app (skipped when it is not installed).

## Unverified

What could not be verified without real providers or GitHub is listed in [`docs/VERIFY.md`](docs/VERIFY.md)
and marked `// UNVERIFIED:` in code.
