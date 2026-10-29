# To verify (SPEC §18)

Items the build could not verify without real providers, credentials or GitHub. Code marks them with
`// UNVERIFIED: <what>`.

## Pi SDK (`@earendil-works/pi-coding-agent` 1.4.0)

Verified against the installed type declarations and sources:

- `createAgentSession({ cwd, agentDir, modelRuntime, model, thinkingLevel, resourceLoader, tools, customTools, sessionManager, settingsManager })`.
- Tool selection by name (`tools` allowlist); a `customTools` entry replaces the built-in tool of the same
  name, so `createBashToolDefinition(cwd, { spawnHook, exposeSessionEnvironment: false })` controls the
  environment of every bash process.
- `ModelRuntime.create({ authPath, modelsPath })` and `getModel(provider, id)`.
- `SettingsManager.inMemory({ retry: { enabled: false } })` turns Pi's own retries off.
- Usage and cost: `session.getSessionStats()` (`tokens.input/output/cacheRead`, `cost`).
- Errors: an assistant message with `stopReason: "error"` and `errorMessage`.
- Session events used for heartbeats/progress: `tool_execution_start`, `turn_end`, `message_update`, `message_end`.

Unverified (needs a real provider):

- `src/agents/pi-runner.ts` `statusFromMessage`: the HTTP status of a provider error is parsed from
  `errorMessage` text. Capacity/limit/auth classification relies on the provider wording.
- `thinkingLevel` values beyond `off|low|medium|high` and their clamping per model.
- `PI_CODING_AGENT_DIR` layout: `auth.json`/`models.json` inside the factory-owned agent dir.
- Exact provider names and model ids (`opencode-go/*`, `openai/*`) in `profiles/default.yaml`; the fallback
  chains are placeholders (TBD by Silas).

## GitHub (`src/gh.ts`)

- `GhCli.baseStatus` reads check runs via `gh api repos/{owner}/{repo}/commits/<sha>/check-runs`.
- `GhCli.createPr`, `enableAutoMerge` (`gh pr merge --auto --squash`), `getIssue` (`gh issue view --json`).
- None of these run in tests; they are exercised only against a real repository.
