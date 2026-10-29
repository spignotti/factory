# Evals (§13)

`factory eval` measures the pipeline on curated tasks; `factory experiment` compares two profiles and
returns a verdict. Both spend real model time: nothing here runs in CI or tests (the tests use the
fake runner on a fixture repo).

```sh
factory eval --validate                                  # no agents: hidden tests red on base, green on the fix
factory eval --profile baseline --repeat 2               # all shipped tasks
factory eval --profile baseline --tasks 'evals/tasks/unjs__*.yaml'
factory experiment --base baseline --variant evals/profiles/example-variant.yaml --repeat 2
```

## Task format (`evals/tasks/<id>.yaml`, schemas/eval-task.schema.json)

| field | |
|---|---|
| `id`, `repo`, `base` | clone URL (or local path, relative to the task file) and the full base sha |
| `task` | the task text as the user would send it (here: the upstream issue) |
| `plan_effort` | `none` / `medium` (default) / `high`; a profile's `flags.plan_effort` overrides it |
| `hidden.from_commit`, `hidden.paths`, `hidden.check` | after the run, `paths` are checked out from `from_commit` into the run's worktree and `check` runs there; exit 0 = pass |
| `timeout_min` | wall limit of the run (default 30) |
| `repo_config` | the `.factory/repo.yaml` for the run (committed on top of `base` as `factory-eval`); public repos have none |
| `exclude` | added to `.git/info/exclude` (default `.venv/`, `node_modules/`) |
| `license`, `source`, `notes` | provenance |

## Harness

Per task × profile × repeat (interleaved per task and repeat, so drift hits all profiles alike):

1. Fresh clone: `git init` + `git fetch --depth 1 <repo> <base>`. The hidden commit is **not** fetched
   before the run, so agents cannot find the hidden tests in the object store.
2. `run --no-pr` with the profile's models, prompts and flags, against a throwaway factory home
   (`<work-dir>/<task>--<profile>--<n>/home`): fresh findings memory, no entries in your `runs/`
   or `stats`. Pi credentials and the provider policy come from your factory home.
3. Hidden tests copied in, `hidden.check` run (jailed like the run's checks when the sandbox is on).
4. Metrics into `evals/results/<date>.jsonl` (schemas/eval-record.schema.json) and a Markdown table
   into `evals/results/<date>.md`.

A harness failure (clone, setup, crash) is recorded with result `error` and counts as a failed run.
The run is aborted at `timeout_min` (`timed_out: true`).

## Metrics

- **pass rate**: share of runs whose hidden check passed.
- **cost**: USD from provider usage; tokens in + out alongside. Subscription providers report 0 USD.
- **wall time**: whole eval step (clone, run, hidden check, real-findings verification).
- **rounds**, **gate failures** (red non-flaky checks over all gate runs, base excluded),
  **bug findings** (bug-severity findings in the final round's merged review).
- **real findings**: a `bug` finding that the implementer answered `fixed` in round n's fix session
  counts when some check is red on the commit reviewed in round n and green on the commit after the
  fix (the next round's reviewed commit, or the branch head after the last round). Checks: the hidden
  check (hidden tests copied in) and the repo's `fast`/`full` checks without services. Several bugs
  fixed in the same session share the credit (all count). Findings that change no check result are
  not counted: they may still be real, but the eval cannot tell.
- **determinism ratio**: over the tasks a profile ran at least twice, the share whose repeats all
  agree on hidden pass *and* on the run result; `–` (null) when nothing ran twice.

## Experiments and the decision rule

A variant profile (`profiles/<name>.yaml` or any file, schemas/eval-profile.schema.json) may set
`roles`, `retry`, `env` (a model layer), `prompts` (role prompt name → file replacing
`roles/<name>.md`) and `flags` (`lane`, `plan_effort`). In an experiment the variant is layered on the
base: models built-in < user < base < variant; prompts and flags merged key by key. `baseline`
pins the default role chains of 2026-10-29.

B beats A when B's pass rate ≥ A's **and** at least one of: a higher pass rate, ≥ 10 % lower mean
cost, ≥ 10 % lower mean wall time. Cost is USD, or tokens when both profiles report 0 USD.
`experiment` needs `--repeat` ≥ 2. Verdict: `win` (variant beats base, not vice versa), `loss`
(the reverse), `tie` (neither, or each ahead on a different measure); a tie keeps the simpler
profile, the base. The verdict is JSON on stdout (schemas/verdict.schema.json).

## Curated tasks

Seven tasks from [SWE-bench Verified](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified)
(MIT) and three TypeScript tasks from [unjs/ufo](https://github.com/unjs/ufo). The task text is the
upstream issue; the hidden tests are the upstream test file at the fix commit (for SWE-bench: the
merge commit, whose test file equals base + `test_patch`). Code stays in the upstream repos and is
only cloned at eval time.

| task | repo | license | hidden test |
|---|---|---|---|
| pallets__flask-5014 | pallets/flask | BSD-3-Clause | tests/test_blueprints.py |
| psf__requests-6028 | psf/requests | Apache-2.0 | tests/test_utils.py |
| pytest-dev__pytest-10081 | pytest-dev/pytest | MIT | testing/test_unittest.py |
| django__django-16485 | django/django | BSD-3-Clause | tests/template_tests/filter_tests/test_floatformat.py |
| django__django-16819 | django/django | BSD-3-Clause | tests/migrations/test_optimizer.py |
| sympy__sympy-16886 | sympy/sympy | BSD-3-Clause | sympy/crypto/tests/test_crypto.py |
| sympy__sympy-15809 | sympy/sympy | BSD-3-Clause | sympy/functions/elementary/tests/test_miscellaneous.py |
| unjs__ufo-242 | unjs/ufo | MIT | test/utilities.test.ts |
| unjs__ufo-313 | unjs/ufo | MIT | test/base.test.ts |
| unjs__ufo-335 | unjs/ufo | MIT | test/base.test.ts |

The hidden check runs the whole test file, not only SWE-bench's FAIL_TO_PASS tests (listed in each
task's `notes`), so regressions in the same file fail the task too (sympy__sympy-15809 deselects one
test that also fails on the fix commit). Python setups use `uv` (it must be on PATH) with a few pins
(pytest < 8 for flask, werkzeug 2.3.7, mpmath 1.3.0); TypeScript setups use pnpm via corepack. All ten
passed `factory eval --validate` on 2026-10-29 in the sandbox (hidden check red on `base`, green on
the upstream fix). Run it again after changing a task.
