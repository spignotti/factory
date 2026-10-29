# Software Factory: agent instructions

- Stack: Node >= 22, TypeScript (strict), pnpm, vitest.
- `SPEC.md` is the source of truth, including its "Amendments v1.4.1" section, which overrides conflicting text. If code and spec disagree, the spec wins; if the spec is unclear, choose the simplest reading and note it in the PR.
- Build milestone by milestone (SPEC §17). Do not start a later milestone's features unless the task says so.
- Tests: `pnpm test`. Typecheck: `pnpm typecheck`. Lint: `pnpm lint`. All three must pass before you finish.
- No real LLM or network calls in tests; use the fake runner behind the `AgentRunner` interface.
- English in code, comments, commit messages and docs.
- Small commits, one per component, each with its tests, so an interrupted session loses little.
- Never push, never use `gh`, never print or log environment variables or secrets.
