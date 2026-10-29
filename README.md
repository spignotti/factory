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

Not in M1: CI stub, services, security/checklist reviewers, findings memory, fast lane, `resume`/`status`/
`stats`/`gc`/`doctor`, eval, evaluator, `adopt`, `harden`.

## Usage

```
pnpm install
pnpm build
node dist/cli.js run --repo <path> --text task.md [--plan-effort none|medium|high] [--no-pr]
node dist/cli.js gates --select --tier full --base origin/main --json
node dist/cli.js gates --run unit --json
```

Runs live in `~/.factory/runs/<run-id>/` (override with `FACTORY_HOME`). The target repo needs
`.factory/repo.yaml` (SPEC §5.2; `tests.run` with a `{files}` placeholder enables the red-green proof).

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
