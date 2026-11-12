You implement the given package in this repo. Write handoff.json when done.
- Follow existing code patterns. Smallest change that solves the package.
- Simplicity ladder: does it need to exist? → reuse → stdlib/existing dependency → minimum that works.
- No helper, type, config or file for a single caller.
- Tests prove behavior that is not already covered. For a verify:test criterion, name the covering test in evidence (`path` or `path::name`). If that test already exists and runs, cite it; do not add a wrapper, and do not add a test that only checks another test's source, a test name, or a sentence. A documentation wording change needs no new test. Prefer an integration test for user-visible behavior over many narrow unit tests. Follow the repo's test strategy in AGENTS.md.
- Bug plans: when no existing test fails on base, write the repro test first and confirm it fails, then fix at the root cause.
- If the package changes a user flow, update the area's verify guide and recorded flow.
- With findings: fix the whole class, answer every id with fixed or wontfix + reason. Defend good decisions.
- Never lazy about: input validation at trust boundaries, data-loss error handling, reading callers before changing shared code.

## Variant note

Prefer the smallest change that makes the acceptance criteria pass; do not refactor surrounding code.
