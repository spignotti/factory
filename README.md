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
4. **Ratchet toward determinism.** Recurring findings and checklist items become checks (`factory harden`).
5. **Tests prove criteria.** Every test proves an acceptance criterion the plan names.
6. **Minimal prompts.** `roles/*.md` are short, role-specific and the factory's only global agent
   instructions; repo facts live in the repo's `AGENTS.md`.
7. **Evidence over feelings.** Prompt, profile or pipeline changes need an `eval` comparison.

All models run through Pi; no Claude/Codex CLI, no production data, one run per repository at a time.

## Pipeline

`intake → plan → implement → loop { fast gates → evaluate → review → merge findings → exit? → fix } → finalize`

- **Intake** (`src/steps/intake.ts`): issue / plan file / text; ```` ```factory-plan ```` blocks are used as
  is; `--plan-effort none` runs `plan_normalize` with a code-level `source_quote` fidelity check; questions
  → `needs_input`; per-repo lock (`--wait` queues); base check (`base_red`; pending CI on the base is polled up to `limits.base_ci_wait_minutes`); worktree and branch
  `factory/<task>-<slug>`.
- **Plan** (`src/steps/plan.ts`, `src/schemas/plan.ts`): zod schema plus code checks (ids, DAG, limits,
  bug → repro, risk rule, `changes_flows`, `verify: evaluator` only with `ui`, quote fidelity). The planner
  reads the repo's `AGENTS.md` at the base commit.
- **Implement** (`src/steps/implement.ts`): DAG order, fresh session per package, handoff validation with one
  re-prompt, fast gates with the failure tail back into the same session (max 3), factory commits,
  cascade-skip. Bug plans prove the repro red on base and green after the fix.
- **Gates** (`src/gates/`, `src/steps/gates.ts`): tier/path selection shared with CI, flaky re-run, built-ins
  (forbidden paths, diff size, test presence, evidence, guide update, scope report, red-green proof, config
  guard). The config guard fails the gates when the change loosens lint/type/format/test-runner config
  (`ruff.toml`, `[tool.ruff|mypy|pyright|…]`, eslint/biome/prettier config, `tsconfig` strictness flags,
  coverage thresholds) or adds inline suppressions (`noqa`, `type: ignore`, `eslint-disable`, `@ts-ignore`,
  `biome-ignore`, …), unless the plan lists that config file in a package's `files` or names the suppression.
  A `.factory/repo.yaml` change that weakens the factory's own checks (removing or changing a check,
  dropping `human_only_paths`/`sensitive_paths`/`forbidden_paths` entries, raising merge or diff limits,
  changing secrets, `setup`, `env_command`, services, models, adding `agent_env`) fails it even when declared.
  The `protected_paths` gate fails on any changed `human_only_paths` file the plan does not declare (see
  [Protected config](#protected-config)).
- **Evaluate** (only with `ui`, see below) runs before the reviewers; any evaluator bug skips review that round.
- **Review** (`src/steps/review.ts`): reviewers decided in code, read-only tools, structured findings,
  continued sessions with the incremental diff in round ≥ 2.
- **Merge/exit** (`src/pipeline/merge.ts`, `loop.ts`): ids, dedupe, nit cap, stalemate, exit rules, fix rounds.
- **Finalize** (`src/steps/finalize.ts`, `src/pipeline/risk.ts`): full gates; if the base moved, a merge (no
  rebase, so never a force-push) plus full gates again, conflict → `needs_human`; risk class and merge
  policy; PR body from `standards/pr-template.md`; push/PR through `src/gh.ts`.
- **Agents** (`src/agents/`): one `AgentRunner` interface, `fake-runner` (tests) and `pi-runner` (Pi SDK);
  env allowlist and isolated `HOME`; capacity/network/limit/auth/invalid_output classification with same-model
  backoff before fallback, `implement` never crossing model families; heartbeats and a silence watchdog
  (a frozen box/VM is not counted as silence, `progress` event `suspended_ms`); every agent bash command
  is killed after `limits.command_timeout_minutes` (default 10, also the maximum the model can ask for)
  and the model gets "Command timed out" back.
  Pi sees only the worktree root `AGENTS.md` as context (no `~/.pi`, ancestor or `AGENTS.override.md` files;
  an override is ignored with a warning).
- **Events** (`src/events.ts`): `events.jsonl` and a one-line `result.json` per run.

## Commands

| Command | Purpose |
| --- | --- |
| `factory run --repo <p> (--issue n \| --plan f \| --text f)` | one task → one PR (`--lane fast`, `--plan-effort`, `--no-pr`, `--wait`) |
| `factory resume <run-id>` | continue after a human fix |
| `factory doctor [--repo <p>] [--ping] [--services]` | setup, provider policy, models per role, agent context, CI stub |
| `factory status` / `stats` / `gc` | runs and PRs, period stats, cleanup |
| `factory gates (--select \| --run <check>)` | check selection and execution (local and CI) |
| `factory adopt --repo <p> [--ref <tag>]` | onboarding PR |
| `factory harden --repo <p>` | signals → ranked proposals |
| `factory eval` / `experiment` | compare profiles on curated tasks |
| `factory ci-stub [--ref <tag>]` | print the CI workflow |
| `factory notify set <owner/name>` / `list` / `remove <owner/name>` | manage bot webhooks in `notify.yaml` (URL and key typed hidden on the TTY, never printed) |
| `factory notify test <owner/name>` | send a test ping to the repo's bot webhook (see [docs/BOTS.md](docs/BOTS.md)) |
| `factory --version` | package version (plus the commit for a checkout install) |

`factory` without arguments prints every flag. All commands take `--json` where the output is machine-readable.

## Resume

Every run keeps `state.json` (current step, package status, rounds, PR) next to `result.json` in
`~/.factory/runs/<run-id>/`. After a `needs_human` stop, fix things in the run's worktree (or push to the
PR branch), then `factory resume <run-id>`: it commits the uncommitted fix as `fix: human changes before
resume`, merges new commits from `origin/<branch>` and the moved base (conflict → `needs_human` again),
re-runs the gates (red → one fixer round) and continues from the saved step. It never force-pushes; an
existing PR is updated and marked ready when the run ends `done`. After an interrupted/failed run,
uncommitted leftovers are discarded instead and the step re-runs. A resumed review starts with a fresh round
budget; a resume at `finalize` only re-runs the gates (no new review of the human change).

## Notify (bots)

On every `run_finished` (also after `resume`) the factory POSTs `{run_id, repo, result, reason, pr,
finished_at}` to the webhook routine of the bot that owns the repo, configured in `~/.factory/notify.yaml`
(`0600`, hidden from agents). Retries with backoff; a failed notification is logged and never fails the run.
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
`current` and `~/.local/bin/factory` links are renamed over atomically. A failed build changes nothing;
the switch waits while a factory run holds a live lock or a factory process runs; running processes keep
their release (node runs the entry's real path); the newest 3 releases are kept. `deploy-self.sh once` checks
once (`git ls-remote`; one `deploy: <result>` line, exit 0 deployed/up to date, 1 error/build failed, 3 deferred),
`ensure` starts a background loop (every 5 min) unless one runs, `status` prints
`state.json`; the log is `deploy.log` next to it. It needs `node`, `git`, `jq`, `flock` and a source clone in
`~/.local/share/factory` (paths and the interval via `FACTORY_DEPLOY_*` / `FACTORY_RELEASES`).

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
services:                            # one instance per run; see Services
  - { name: db, start: "…", stop: "…", env: { DATABASE_URL: "postgresql://…:{port:db}/postgres" } }
env_command: ""                      # prefix for every check command (prefer secrets: below for secrets)
secrets: { provider: env_file, names: [DATABASE_URL] }   # checks, services, ui only, never agents; see Secrets
tests: { globs: ["tests/**"], run: "uv run pytest {files}" }   # run enables the red-green proof of bug plans
sensitive_paths: ["src/auth/**"]     # security reviewer, fast-lane escalation, at least medium risk
human_only_paths: [".github/**", ".factory/repo.yaml", "AGENTS.md"]   # changed only as declared protected_changes
review: { max_rounds: 2, checklist: true, skip_paths: ["uv.lock"], max_nits: 5 }
fast_lane: { max_diff_lines: 150 }
merge:
  auto_merge_max_risk: none          # none | low | medium [none]; high is never auto
  policy: { low: human_review, medium: human_review }   # bot_review | human_review
  low_max_diff_lines: 300            # larger diffs are at least medium
limits: { max_diff_lines: 1500, max_wall_minutes: 90, stall_minutes: 15, command_timeout_minutes: 10, forbidden_paths: [".env*"], diff_exclude: ["src/gen/**"] }
# limits.base_ci_wait_minutes [20]: pending CI on the base is polled this long (0–120; 0 = base_red at
# once); only red or a timeout ends the run as base_red. The wait does not count against max_wall_minutes.
# Diff line limits (limits.max_diff_lines, fast_lane.max_diff_lines, merge.low_max_diff_lines) count
# added + removed lines since base, without lockfiles (package-lock.json, pnpm-lock.yaml, uv.lock, …;
# not manifests), binary files and limits.diff_exclude (generated paths; test files under tests.globs
# always count, catch-all globs are rejected). The gate names what it left out:
# "943 lines (+533 excluded: package-lock.json; 4 binary files)". Lockfiles still are dependency
# changes for lane escalation and risk. Adding a diff_exclude entry is a loosening (config_guard).
ui: { start: "…--port {port:app}", url: "http://localhost:{port:app}", paths: ["src/app/**"], pages: ["/"], devices: ["Desktop Chrome"] }
verify:
  areas: [{ name: tours, paths: ["src/app/tours/**"], guide: ".factory/verify/tours.md", flows: ["tests/e2e/test_tours.py"], pages: ["/tours"] }]
  run: "uv run pytest {files}"       # runs recorded flows [tests.run]
harden: { max_proposals: 5 }
git: { author: factory, email: "…" }
agent_env: []                        # extra env var names for agent tools and checks
docs_lookup: { roles: [plan, implement, fix] }   # steps with the Context7 docs tool [profile's list]; [] = off
models: {}                           # per-repo role chains, see Model configuration
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
3. **Always a human's OK.** Risk is `high`, the merge policy `human_review` whatever `merge:` says (never
   auto-merge), the PR gets the label `factory:protected-config` and a "⚠️ Changes protected config
   (CI / factory)" section with each declared change and the exact diff of the protected files. CI on the PR
   runs the changed workflow files, so read that diff before approving.

Agents still never get secret values; a protected change does not change what agents see.

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
  (`path`, default `~/.factory/secrets/<repo dir name>.env`, and `credentials`) must lie outside the
  repo with mode `0600`.
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
read-only, host loopback, Docker bridge, metadata service and LAN are unreachable, the internet works. File
tools are confined to the worktree. Set `sandbox: required | preferred | off` in
`~/.factory/profile.yaml` (default `preferred`, which degrades with a warning). Needs `bwrap`
(bubblewrap), `pasta` (passt) and `ip` (iproute2); `factory doctor` shows what is in effect.

## Services

Checks that need a database or a dev server name it: `services: [db]` on the check, plus a `services:`
entry in `repo.yaml` (`start` in the foreground, optional `ready`/`stop`/`env`). The factory starts it once
before the first check that needs it and stops it at run end. Ports come from a per-run slot, so parallel
runs never collide: `{port:web}` (a named port), `{port:5432}` (a default port shifted by the slot) and
`{port_offset}`. In the sandbox a service must listen on `0.0.0.0`; only its own ports are forwarded, and
only to the checks that use it. `host: true` runs it outside the sandbox (e.g. Docker); `doctor` warns.
`factory doctor --repo . --services` starts and stops each service once.

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

Any evaluator bug skips the reviewers that round and goes to fix. Evidence is pushed to the orphan branch
`factory-evidence` (one folder per run, pruned after 30 days by `factory gc`) and embedded in the PR.
Needs the Chromium headless shell (`npx playwright-core install --only-shell chromium`) and `ffmpeg` for
GIFs; `factory doctor --repo .` checks both.

## CI

`factory ci-stub [--ref <tag>] > .github/workflows/factory.yml` writes the CI stub (`--ref` defaults to `v<version>`, the release tag of the installed factory): on every pull request it
selects the checks with the same code as a local run and runs each one (`factory gates --run`); the single
required status is `factory / done`. `factory doctor --repo .` checks the file is the unedited template
for its ref. Bumping the ref is a deliberate PR. The ref must be a published tag of this repo.

## Adopt

`factory adopt --repo <path> [--ref <tag>]` (default `v<version>`) onboards a repository in one PR (branch `factory/adopt`, from the
base branch; the user's checkout is not touched):

- **Detect** (code): stack (node: package manager and scripts; python: uv/poetry/pip, nox sessions or
  ruff/mypy/pytest; rust; go), test files and the command that runs specific ones, UI, database, cloud/secrets,
  CI workflows and special jobs (gitleaks, pip-audit, cosign, `systemd-analyze` …). Mutating commands
  (`--fix`, `--write`, `format` without `--check`, …) become their read-only variant or are skipped, never a
  check that rewrites files; identical commands are drafted once.
- **Measure**: setup and every check once in a clean base worktree, in the sandbox (`--no-measure` skips).
- **Draft**: `.factory/repo.yaml` (tiers: e2e/build, CI `services:` or > 120 s → `full`; secrets or failing on
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
- **Settings** are never changed: branch protection (`factory / done`) and auto-merge are printed hints, so
  no admin token or GitHub Pro is needed. `--no-pr` commits the branch locally only. An adopted repo (with
  `.factory/repo.yaml`) is refused unless `--force`.
- **After the merge**: set up the repo bot's webhook routine and `notify.yaml` entry, then
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

## Evals and experiments

```
factory eval --validate                                   # tasks sane? (no agents)
factory eval --profile baseline --repeat 2                # pass rate, cost, time, real findings
factory experiment --base baseline --variant my-variant.yaml --repeat 2   # JSON verdict
```

Results go to `evals/results/<date>.jsonl` and `.md`. Every eval run spends real model time; see
[`evals/README.md`](evals/README.md) for the task format, metrics and the decision rule.

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
(not readable via API). `--ping` sends one tiny request per model. With `--repo` it checks repo `secrets:` (see Secrets), `gh` and gives
hints on auto-merge and branch protection (neither needs admin rights or GitHub Pro). The run applies the
same Zen and ChatGPT-login rules before every agent session. It also checks `~/.factory/notify.yaml`
(`0600`, valid, key files readable) and lists the repos with a hook, never the URLs; with `--repo`, it warns
when that repo has none.

Log in once for the factory: `PI_CODING_AGENT_DIR=~/.factory/pi npx pi`, then `/login` (ChatGPT for OpenAI,
API key for OpenCode Go).

## Status, stats, cleanup

```
factory status [--json]                     # running, waiting for you, interrupted; open factory PRs
factory stats --since 7d [--repo <path>] --json  # results, rounds, gates, providers, cost vs the previous 7 days
factory gc [--dry-run] [--force]            # remove worktree and branches of merged/closed factory PRs
```

`gc` deletes only `factory/*` branches, and the remote branch only if nobody pushed to it after the factory; a worktree with uncommitted changes needs `--force`.

## JSON contracts

Machine-readable outputs have JSON Schemas in [`schemas/`](schemas/): `result.json`, `events.jsonl` lines,
`status`, `stats`, `gc` and `doctor` with `--json`, the findings memory, the reviewer outputs, eval tasks,
eval profiles, eval result lines and the experiment verdict. They are
generated from the zod schemas in code (`pnpm schemas`); a test keeps them in sync.

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
