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

## Pi SDK (`@earendil-works/pi-coding-agent` 1.5.2)

Verified against the installed type declarations and sources: `createAgentSession`, tool selection by name
(a `customTools` entry replaces the built-in tool, so the bash `spawnHook` controls every bash env),
`ModelRuntime.create({ authPath, modelsPath })`, `SettingsManager.inMemory({ retry: { enabled: false } })`,
usage via `session.getSessionStats()`, errors as `stopReason: "error"` + `errorMessage`, session events
for heartbeats.

Unverified (needs a real provider):

- `src/agents/pi-runner.ts` `statusFromMessage`: the HTTP status of a provider error is parsed from
  `errorMessage` text; capacity/limit/auth classification relies on the provider wording.
  A header-only `Retry-After` is not available: Pi's `formatProviderError` puts status and body into
  `errorMessage` and drops response headers (checked against the installed SDK, not a live 429).
  The factory parses the text form (`try again in N`, `retry-after: N`) and retries a 429 as capacity.
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
  (verified in `test/unit/bash-timeout.test.ts` against Pi 1.4.0, re-run on 1.5.2). Stdin is `ignore` in Pi's local shell.

### Providers (Pi 1.4.0 registry, not live endpoints; 1.5 uses protocol-specific paths under the same hosts)

- `opencode` = OpenCode Zen (`https://opencode.ai/inference/v1`), pay-per-use, never used.
- `opencode-go` = subscription (`https://opencode.ai/inference/go/v1`). It reads the same
  `OPENCODE_API_KEY` as Zen, so a wrong model id, not the key, would bill per use; hence the guard.
- `openai`: ChatGPT OAuth in the factory-owned `auth.json` (subscription) wins over `OPENAI_API_KEY`;
  `doctor` and `PiRunner` refuse OpenAI without the OAuth login. `openai-codex` is not allowed.

## GitHub (`src/gh.ts`)

- `repoSettings` reads `security_and_analysis.secret_scanning.status`,
  `secret_scanning_push_protection.status`, and `required_status_checks.strict` (plus check contexts).
  UNVERIFIED against a live repository: non-admin tokens omit `security_and_analysis`, and doctor then
  warns on public repos instead of failing. The jq was checked against sample JSON only.
- `repoSettings` also reads `GET /repos/{owner}/{repo}/rules/branches/{branch}` and merges a
  `required_status_checks` rule (`context`, `strict_required_status_checks_policy`) into those fields.
  Classic branch protection does not return ruleset checks. UNVERIFIED against a live repository.
  The parser was checked against the documented JSON shape in `test/unit/baseline.test.ts` (no `gh`
  process and no network). A failed rules request leaves the classic result in place.
- Factory full gates invoke `zizmor --offline`. UNVERIFIED against a current zizmor binary (the flag is
  the documented switch that skips the GitHub API). Tests inject the command and do not spawn it.
- `createPr`, `enableAutoMerge` (`gh pr merge --auto --squash --match-head-commit <sha>`), `disableAutoMerge` (`gh pr merge --disable-auto`; ignore when auto-merge was not enabled), `getIssue`, `updatePr`, `markReady` and
  `prStatus` have not yet run from a factory run against a real repository (tests use `FakeGitHub`;
  `push` is verified against a local bare remote).
- `getIssue` also reads `state` (`OPEN` / `CLOSED`) for `queue add`. UNVERIFIED against a live `gh`.
- `ciRunsInWindow` pages `GET /repos/{owner}/{repo}/actions/runs?per_page=100&page=N&created=>=YYYY-MM-DD`
  (at most 10 pages; the API's 1000-run cap). Identity is `path`, not the run `name`. The workflow name
  comes from `GET /repos/{owner}/{repo}/actions/workflows` (or `gh run list` `workflowName` when there is
  no path). An HTTP 422 on a later page keeps the pages already read and sets `truncated`. Then
  `gh run view --json jobs` per id. A failed view skips that run (`skipped`) and keeps the rest; it does not
  discard the window. Step timestamps on that view are UNVERIFIED. A short page ends the window.
  UNVERIFIED against a live `gh`. Tests fold recorded pages and do not spawn `gh`. The 200-run
  `gh run list` audit is unchanged.
- `listOpenIssues` pages `gh api repos/{owner}/{repo}/issues?state=open&per_page=100` (issues and pull
  requests; pull requests are dropped). A short page ends the list. Fifty full pages is incomplete: improve
  does not create an issue. UNVERIFIED against a live `gh`. Tests drive `paginateOpenIssues` without `gh`.
- `findFactoryPr` lists with `gh pr list --state all --search head:factory/<issue> --json number,state,headRefName`
  and keeps only a head that is exactly `factory/<issue>` or `factory/<issue>-*`. UNVERIFIED against a live `gh`.
- `updateBranch` runs `gh pr update-branch <pr>` (merge from the base, no `--rebase`, no force-push).
  For `auto` and `bot_review` the worker disables auto-merge and approves the new head; CI has to pass on that head.
  UNVERIFIED against a live `gh`. Tests use `FakeGitHub`.
- `openFactoryPrFiles` uses `gh pr list --state open --limit 1000 --json number,headRefName,isCrossRepository,files`.
  UNVERIFIED against a live `gh`: `files` is an exportable field; the parser accepts `{path}` / `{filename}`
  and a `{nodes}` wrapper. A page that hits 1000 is incomplete: the run blocks instead of treating it as every open PR.
  Whatever file page `gh` requests is still a separate cap.
- Branch protection and auto-merge hints on a private repository without GitHub Pro.
- `baseStatus` joins check runs to workflow runs by `check_suite_id` and reads workflow run `name` as the
  workflow file's `name:` (not `display_title`). UNVERIFIED against a live repository. A missing name keeps
  the job-name recognition.

## Evaluate

- The browser tools as Pi custom tools are covered by the fake runner only; a real `evaluate` session
  driving them is unverified.
- Evidence links and the inline GIF are verified as text against a local bare remote; GitHub's rendering
  (private repos: viewers need access) is unverified. The push retry on a non-fast-forward has no test.
- Mobile web builds (Expo / React Native Web) are covered through Playwright device emulation only.
