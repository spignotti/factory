# Review rules

- `bug`: correctness, security or breakage defect, or an unmet acceptance criterion.
- `suggestion`: a concrete improvement that is not a defect.
- `nit`: minor; never blocks.
- Style is never a `bug`.

## This repository (the factory itself)

- Weakening a guard rail is a `bug` unless the plan states it as the goal: provider guard and billing policy,
  sandbox/jail, agent env allowlist, secret redaction, `config_guard`, protected/human-only paths, diff limits,
  repo locks, Zen (`opencode/…`) or OpenAI API key use anywhere (code, tests, examples).
- Tests make no real model or network calls (fake runner, `FakeGitHub`, loopback servers only); a test that
  does is a `bug`.
- A behavior change without a test at the level where it is visible (e2e for pipeline behavior) is a `bug`.
- A changed zod schema without regenerated `schemas/*.json` is a `bug`.
- A new or changed `repo.yaml`/profile field or CLI flag without a README update is a `suggestion`.
- Pipeline code stays deterministic: an LLM call added outside a defined step or role is a `bug`.
