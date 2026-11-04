# Tool baseline

Central quality and security tools for every repo the factory runs. The files live in
`templates/baseline/` (version in `templates/baseline/VERSION`, currently read by `factory doctor`).
A repo keeps the CI stub, its `.factory/repo.yaml` checks, and justified exceptions. It does not
copy a workflow per tool.

## CI: one stub, not a reusable workflow

`factory ci-stub` renders `templates/ci/factory.yml`. Doctor hashes that one file. Branch protection
requires one status, `done`, which is red when selection or any check fails. `pull_request` has no
branch filter and drafts are not skipped, so the stub blocks every merge, including Dependabot.

A reusable workflow would be a second file and a second required check. The stub stays identical in
every repo; the tool commands live in `.factory/repo.yaml` `checks`.

The stub runs on pull requests, on tags `v*` (a release), and on `workflow_dispatch` (a deploy). It
does not run on pushes to the base branch: that commit was already checked as a PR, and a base
commit with no check run makes a factory run execute the fast checks locally.

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
| pyright or mypy | pyright `typeCheckingMode` `standard` or stricter; mypy `strict = True` | CI check |
| pip-audit | blocking full check (do not swallow the exit code) | CI and factory full gates |
| semgrep | CI: `--metrics=off --error` and `p/default` or `p/python`, plus `p/owasp-top-ten` and `p/secrets`, plus the repo's own rules | CI uses the registry. Factory fast gates use `templates/baseline/semgrep/rules/` only, offline |
| gitleaks | default rules (`[extend] useDefault = true`). Allowlist entries are content-bound (`regexes` or `regexTarget = "match"`) and have a `description` | CI check and factory fast gates (`base..HEAD`, `--redact`) |
| pnpm or npm audit | `--audit-level high` or stricter (`low`, `moderate`; not `critical` alone) | CI and factory full gates |
| TypeScript | `strict` and `noUncheckedIndexedAccess` (`typescript/tsconfig.baseline.json`). ESLint `recommendedTypeChecked` | CI check |
| shellcheck | `-S style -x` and `shellcheckrc` | CI check |
| actionlint, zizmor | both, when workflows change. zizmor `--offline` in factory gates | CI; factory full gates |
| trivy | `CRITICAL,HIGH`, `exit-code: 1`, `ignore-unfixed: true`. Every `.trivyignore` id needs a reason comment | CI only |
| hadolint | `hadolint.yaml` | CI only |

Factory run gates skip a scanner that is not on `PATH` and `factory doctor` warns (`baseline tools`).
Install gitleaks and semgrep on the box. The skip is not a passing scan.

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
block HIGH and CRITICAL, gitleaks without default rules, branch protection that omits a
pull_request job or is not strict, and a dependabot config that would edit the stub. It fails only
when a public repo has secret scanning or push protection off, or when a Python or npm/pnpm
lockfile has no blocking dependency audit.

## Config guard

These files are tool config. A change that the plan does not name fails the gate:

`.semgrep/**`, `.gitleaks.toml`, `.gitleaksignore`, `.shellcheckrc`, `.trivyignore`, `.hadolint.yaml`.

So do new suppression markers: `nosemgrep`, `gitleaks:allow`, `# shellcheck disable`, `# nosec`,
`pragma: no cover` (plus the markers the guard already knew: `noqa`, `type: ignore`, and the
TypeScript and ESLint ones). Name the marker in the package or criterion text when it is intentional.
