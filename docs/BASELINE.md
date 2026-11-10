# Tool baseline

Central quality and security tools for every repo the factory runs. The files live in
`templates/baseline/` (version in `templates/baseline/VERSION`, currently read by `factory doctor`).
A repo keeps the CI stub, its `.factory/repo.yaml` checks, and justified exceptions. It does not
copy a workflow per tool.

## CI: one stub, not a reusable workflow

`factory ci-stub` renders `templates/ci/factory.yml` when a check is not `local_only` (including
`tier: manual`, so `workflow_dispatch` can run it), and `templates/ci/factory-minimal.yml` when every
check is `local_only` (or there is none).
Doctor hashes the rendering that matches the repo. Branch protection requires one status, `done`,
when the stub runs checks; that status is red when selection or any check fails. When the stub is
minimal, `done` gates nothing beside the repo's own jobs, so doctor and adopt do not suggest
requiring it. `pull_request` has no branch filter. A draft event does not run select/check (the
minimal stub runs a `draft` marker instead), but `done` still runs and fails, so a draft is never a
skipped (and therefore passing) required check. A failed or cancelled `done` on a ready pull request
is red: the marker is skipped there, so that failure is not a draft hold. Dependabot and other ready
pull requests run the full matrix when there is one. Nothing is skipped because of author, branch,
labels, or the PR body.

A reusable workflow would be a second file and a second required check. The tool commands live in
`.factory/repo.yaml` `checks`; the stub file is one of the two renderings, not a copy per tool.

The stub runs on pull requests, on tags `v*` (a release), and on `workflow_dispatch` (a deploy). It
does not run on pushes to the base branch: that commit was already checked as a PR, and a base
commit with no check run makes a factory run execute the fast checks locally.

A pull request selects checks whose paths match the diff. A tag push and `workflow_dispatch` pass
`factory gates --select --all`: the tag is a commit already on the base, so a diff against
`origin/main` is empty and would drop every path-scoped check. `--all` runs every check of the
tier (`full` on a tag; the dispatch input, default `manual`, on a manual run).

Dependabot must not edit the stub (a bump changes the hash). On the `github-actions` ecosystem:

```yaml
exclude-paths:
  - ".github/workflows/factory.yml"
```

`factory doctor` warns when that exclude is missing.

## What to turn on

Vendor the files you need from `templates/baseline/` and point the tool at them.

| Tool | Baseline | Where it runs |
| --- | --- | --- |
| ruff | `python/ruff-base.toml`: `extend = "ruff-base.toml"`, line length 100, tests ignore S101/S105/S106 | CI check |
| pyright or mypy | pyright `typeCheckingMode` `standard` or stricter. A `pyrightconfig.json` or `[tool.pyright]` table that omits the key uses pyright's default, `standard`. mypy `strict = True` | CI check |
| pip-audit | blocking full check or a pull_request job step (a nox session that step runs counts when it calls pip-audit). Do not swallow the exit code | CI and factory full gates |
| semgrep | CI: `--metrics=off --error` and `p/default` or `p/python`, plus `p/owasp-top-ten` and `p/secrets`, plus the repo's own rules | CI uses the registry. Factory fast gates use `templates/baseline/semgrep/rules/` only, offline |
| gitleaks | default rules (`[extend] useDefault = true`). Allowlist entries are content-bound (`regexes` or `regexTarget = "match"`) and have a `description`. A `commits` list does not make an entry content-bound | CI check and factory fast gates (`base..HEAD`, `--redact`) |
| pnpm or npm audit | `--audit-level high` or stricter (`low`, `moderate`; not `critical` alone) | CI and factory full gates |
| TypeScript | `strict` and `noUncheckedIndexedAccess` (`typescript/tsconfig.baseline.json`). ESLint `recommendedTypeChecked` | CI check |
| shellcheck | `-S style -x` and `shellcheckrc` | CI check |
| actionlint, zizmor | both, when workflows change. zizmor `--offline` in factory gates | CI; factory full gates |
| trivy | `CRITICAL,HIGH`, `exit-code: 1`, `ignore-unfixed: true`. Every `.trivyignore` id needs a reason comment | CI only |
| hadolint | `hadolint.yaml` | CI only |

The semgrep run gate receives changed paths that still exist in the worktree. A deleted path, and the old path of a rename, are not scan targets. When that list is empty the gate passes (`no scan needed`) and does not scan the repo. More than 200 remaining paths scans the worktree root instead of putting every path on the command line. Lockfiles and common binary assets are left off the list. shellcheck, hadolint and ruff stay CI checks; they are not factory file-list gates. Any later file-list gate uses the same existing-path filter.

Factory run gates skip a scanner that is not on `PATH`. The gate detail starts with `SKIPPED`, and
the run's `result.json` (`skipped_gates`) and the PR gate list name those gates, so a reviewing
bot sees them. `baseline.require_tools: true` in `.factory/repo.yaml` turns a missing binary into
a failing gate. The default is `false`. Turning it off later is a config_guard loosening.
`factory doctor` still warns (`baseline tools`). Install gitleaks and semgrep on the box.

## An exception

A gap that should stay needs an entry in `.factory/repo.yaml`. `reason` is required. Adding an entry
loosens the factory's own checks, so config_guard rejects it in an agent PR (a human commits it).

```yaml
tool_exceptions:
  - tool: ruff
    rule: S
    reason: "Bandit S is noisy on this service until the subprocess calls are replaced."
```

`tool` is the tool name doctor knows (`ruff`, `semgrep`). `rule` is the ruff code or the semgrep
ruleset id (`p/secrets`). `--error` and a missing dependency audit cannot be excepted: the audit
check fails doctor, it does not warn.

Doctor warns, with the fix in the detail, for a ruff select below the baseline, a dead ignore, a
type checker below standard, semgrep without a registry ruleset or `--error`, trivy that does not
block HIGH and CRITICAL, gitleaks without default rules or with an allowlist that is not
content-bound (a `commits` list still warns), branch protection or a ruleset that omits a
pull_request job that gates the merge or is not strict, and a dependabot config that would edit
the stub. Release, publish, path-filter (`changes`) and automerge (`enable`, `meta`) jobs are not
merge gates, and neither is a job whose `if` skips pull requests. Ruleset required checks come from
`GET /repos/{owner}/{repo}/rules/branches/{branch}`. It fails only when a public repo has secret
scanning or push protection off, or when a Python or npm/pnpm lockfile has no blocking dependency
audit.

## Config guard

These files are tool config. A change that the plan does not name fails the gate:

`.semgrep/**`, `.gitleaks.toml`, `.gitleaksignore`, `.shellcheckrc`, `.trivyignore`, `.hadolint.yaml`.

So do new suppression markers: `nosemgrep`, `gitleaks:allow`, `# shellcheck disable`, `# nosec`,
`pragma: no cover` (plus the markers the guard already knew: `noqa`, `type: ignore`, and the
TypeScript and ESLint ones). Name the marker in the package or criterion text when it is intentional.
