# AGENTS.md

Rules for coding agents in this repository. The code and README are the documentation; there is no separate spec.

## Purpose

`factory` is a CLI that takes a task (issue or text) through plan, implement, review, gates and evaluation to a reviewed pull request in a target repository. Agents run through the Pi SDK; the pipeline around them is deterministic TypeScript.

## Stack & commands

- Node >= 22.19, TypeScript (strict, ESM), pnpm, vitest, zod, Pi SDK (`@earendil-works/pi-coding-agent`).
- Setup: `pnpm install --frozen-lockfile`.
- Typecheck: `pnpm typecheck`. Lint: `pnpm lint`. Tests: `pnpm test`.
- Build: `pnpm build` (writes `dist/`; `node dist/cli.js <command>` runs the CLI).
- JSON schemas: `pnpm schemas` regenerates `schemas/*.json` from the zod schemas; a contract test fails when they are stale.

## Test strategy

- Unit tests in `test/unit/`, end-to-end pipeline tests in `test/e2e/` on throwaway git fixture repos (`test/fixtures/`, `test/helpers/`).
- Agents in tests are the fake runner (`src/agents/fake-runner.ts`) behind the `AgentRunner` interface; GitHub is `FakeGitHub`. No real model or network calls; a provider is at most a loopback HTTP server.
- A behavior change comes with a test at the level the behavior is visible (prefer an e2e scenario for pipeline behavior).

## Architecture

- `src/cli.ts`: argument parsing and command dispatch; `src/commands/`: one file per command (`adopt`, `doctor`, `gates`, `stats`, `eval`, `harden`, …).
- `src/pipeline/`: the run (lock, state, lanes, risk, merge policy, watchdog) and the run context; `src/steps/`: intake, plan, implement, review, gates, evaluate, finalize.
- `src/agents/`: model roles, fallback chains, the Pi runner, the provider guard, agent env and context isolation.
- `src/gates/`, `src/evaluate/`, `src/sandbox/`: checks, the browser evaluator and the bubblewrap jail for agent commands.
- `src/adopt/`: repo detection, check drafting, legacy-setup cleanup; `src/harden/`: memory and proposals from past runs.
- `src/schemas/`: zod schemas for profile, repo.yaml, plan, events and reports (the source of `schemas/*.json`).
- `profiles/default.yaml` (built-in profile), `roles/` (role prompts), `standards/` (review rules), `templates/` (CI stub).

## Conventions

- English in code, comments, commit messages and docs.
- Conventional Commits; one commit per change with its tests.
- Config is validated with zod at the boundary; inside, trust the types.
- Keep comments about why, not what; no references to documents that do not exist.

## Domain knowledge

- Profile layers: built-in `profiles/default.yaml` < `$FACTORY_HOME/profile.yaml` < `--profile` < `models:` in the repo's `.factory/repo.yaml`. `providers`, `sandbox` and `billing` come only from the built-in or user layer.
- A reviewer's model family differs from the implementer's; fallback chains are per role.
- Subscription providers (`billing:`) are reported in tokens, metered ones in USD.
- Agents see only the worktree's `AGENTS.md` as context, never ancestor or `$FACTORY_HOME/pi` files.

## Data & secrets

- Pi credentials live in `$FACTORY_HOME/pi/auth.json`; never read, print or log them or any environment variable value.
- Agent tool processes get an allowlisted environment (`src/agents/env.ts`); do not widen it without a reason in the PR.

## Do not

- Do not use the pay-per-use OpenCode Zen provider (`opencode/…`) or an OpenAI API key anywhere, including tests and examples; `opencode-go` and the ChatGPT login are the subscriptions.
- Do not edit `schemas/*.json` by hand; run `pnpm schemas`.
- Do not force-push, merge or tag; a human merges.

## Verify

- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass before a change is done.
- Changed zod schemas: `pnpm schemas`, commit the result.
- CLI behavior: `pnpm build` and run the command against a fixture or temp repo (`node dist/cli.js doctor --repo <path>`).
