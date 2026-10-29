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

### Providers (checked in the Pi 1.4.0 model registry, not against live endpoints)

- `opencode` is **OpenCode Zen**: pay-per-use, base URL `https://opencode.ai/inference/v1`. Never used;
  the profile schema rejects every `opencode/*` model.
- `opencode-go` is the subscription, base URL `https://opencode.ai/inference/go/v1`. It reads the same
  `OPENCODE_API_KEY` as Zen, so a misconfigured model id (not the key) is what would bill pay-per-use;
  hence the allowlist (`ALLOWED_PROVIDERS` in `src/schemas/profile.ts`: `opencode-go`, `openai`).
- `openai` uses `OPENAI_API_KEY` (pay-per-use API) or ChatGPT OAuth in `auth.json` (subscription). Which
  one applies depends on the factory-owned `auth.json`; only OAuth is intended. `openai-codex` is legacy
  and not allowed.

### HTTP idle timeout

Pi aborts a provider request after `httpIdleTimeoutMs` without bytes (default `300_000` = 5 min, `0` =
off). The factory leaves the default (`SettingsManager.inMemory` does not set it). Its own silence
watchdog (`src/pipeline/watchdog.ts`) and `max_wall_minutes` (enforced inside every agent call) sit on top. Long silent reasoning phases
may hit the 5 min limit; unverified with real models.

### No filesystem sandbox

Agents run with the bash tool in the worktree, but nothing confines them to it. The env is scrubbed
(`spawnHook`), but an agent can still read `/proc/<pid>/environ` of the factory process (which holds the
provider keys), the real `gh` config/token under `$HOME`, and the main repository `.git` (shared object
store and refs of the worktree). Redaction only covers what the factory writes. Needs a sandbox
(bubblewrap/container, separate user) before running untrusted tasks; not part of M1.

### Abort

On SIGINT/SIGTERM or `max_wall_minutes` the factory aborts the Pi session and kills the process groups of
the gate commands it started itself. Killing bash children that Pi spawned relies on Pi's abort handling
(unverified with long-running tool calls).

## GitHub (`src/gh.ts`)

- `GhCli.baseStatus` reads check runs via `gh api repos/{owner}/{repo}/commits/<sha>/check-runs`.
- `GhCli.createPr`, `enableAutoMerge` (`gh pr merge --auto --squash`), `getIssue` (`gh issue view --json`).
- Resume: `GhCli.updatePr` (`gh pr edit <url> --title --body`) and `markReady` (`gh pr ready <url>`).
- `GhCli.push` is a plain `git push -u origin <branch>` (never forced); resume relies on the branch only
  moving forward (merges, no rebase). Verified against a local bare remote in the e2e tests.
- None of these run in tests; they are exercised only against a real repository.
