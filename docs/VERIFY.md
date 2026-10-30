# To verify

What the build could not verify without real providers, credentials or GitHub. Code marks open items with
`// UNVERIFIED: <what>`. Remove an item here (and its marker) once it is verified.

## Settled

- **Sandbox**: agents, `setup`, checks and red-green runs are jailed with bubblewrap + pasta (Linux);
  `sandbox: required | preferred | off` in the user profile. Covered by tests on Linux.
- **Model chains**: the defaults and the cross-family `implement` backup in `profiles/default.yaml` are decided.
- **Provider policy**: configurable (`providers: { allow, deny }`, user profile or built-in only); the
  default allows every Pi provider except `opencode` (OpenCode Zen, pay-per-use), which is also refused by
  the Zen guard in `doctor` and before every agent session.
- **Billing**: per provider (`billing:`); subscriptions are reported in tokens, metered providers in USD.
- **Agent context**: Pi loads only the worktree root `AGENTS.md` (no `~/.pi`, ancestor or override files);
  covered by a loopback Pi request in `test/unit/context-files.test.ts`.
- **gh field shapes** (checked 2026-10-29 on `spignotti/factory`, public): `gh run list --json
  databaseId,headSha,workflowName,event,conclusion,createdAt`, `gh run view --json jobs`
  (`name/conclusion/startedAt/completedAt`), `commits/<sha>/check-runs` (`status/conclusion`), `tags`.

## Pi SDK (`@earendil-works/pi-coding-agent` 1.4.0)

Verified against the installed type declarations and sources: `createAgentSession`, tool selection by name
(a `customTools` entry replaces the built-in tool, so the bash `spawnHook` controls every bash env),
`ModelRuntime.create({ authPath, modelsPath })`, `SettingsManager.inMemory({ retry: { enabled: false } })`,
usage via `session.getSessionStats()`, errors as `stopReason: "error"` + `errorMessage`, session events
for heartbeats.

Unverified (needs a real provider):

- `src/agents/pi-runner.ts` `statusFromMessage`: the HTTP status of a provider error is parsed from
  `errorMessage` text; capacity/limit/auth classification relies on the provider wording.
- `thinkingLevel` clamping per model beyond `off|low|medium|high`.
- `doctor --ping` against the live endpoints (`completeSimple` with `maxTokens: 16` and a session id, which
  OpenCode Go requires). The ping needs the ChatGPT login in `$FACTORY_HOME/pi` first.
- Whether a provider's OAuth flow can set a different `baseUrl` per request (`ModelAuth.baseUrl`); the Zen
  guard checks the resolved model, not the per-request auth.
- Pi's HTTP idle timeout (`httpIdleTimeoutMs`, default 5 min) against long silent reasoning phases; the
  factory's watchdog and `max_wall_minutes` sit on top.
- Abort: killing bash children Pi spawned relies on Pi's abort handling with long-running tool calls.
- Bash timeout: Pi's bash has no default timeout; the factory sets `timeout` per call
  (`withCommandTimeout`), and Pi kills the process tree and throws "Command timed out after N seconds"
  (verified in `test/unit/bash-timeout.test.ts` against Pi 1.4.0). Stdin is `ignore` in Pi's local shell.

### Providers (Pi 1.4.0 registry, not live endpoints)

- `opencode` = OpenCode Zen (`https://opencode.ai/inference/v1`), pay-per-use, never used.
- `opencode-go` = subscription (`https://opencode.ai/inference/go/v1`). It reads the same
  `OPENCODE_API_KEY` as Zen, so a wrong model id, not the key, would bill per use; hence the guard.
- `openai`: ChatGPT OAuth in the factory-owned `auth.json` (subscription) wins over `OPENAI_API_KEY`;
  `doctor` and `PiRunner` refuse OpenAI without the OAuth login. `openai-codex` is not allowed.

## GitHub (`src/gh.ts`)

- `createPr`, `enableAutoMerge` (`gh pr merge --auto --squash`), `getIssue`, `updatePr`, `markReady` and
  `prStatus` have not yet run from a factory run against a real repository (tests use `FakeGitHub`;
  `push` is verified against a local bare remote).
- Branch protection and auto-merge hints on a private repository without GitHub Pro.

## Evaluate

- The browser tools as Pi custom tools are covered by the fake runner only; a real `evaluate` session
  driving them is unverified.
- Evidence links and the inline GIF are verified as text against a local bare remote; GitHub's rendering
  (private repos: viewers need access) is unverified. The push retry on a non-fast-forward has no test.
- Mobile web builds (Expo / React Native Web) are covered through Playwright device emulation only.
