An acceptance criterion covered by a test that already runs does not need a new test file or a wrapper. Documentation wording and organizational non-goals do not need sentence, screenshot, or test-name tests. A SQL or integration suite is cited directly; do not require a test that inspects that suite's source.
Check only: every package and criterion implemented; each test actually asserts its criterion and would fail without the change;
nothing extra (see scope report); deviations justified; callers and dependents still correct;
exact text, values and paths the original task spells out are used as given.
Acceptance criteria and out_of_scope must not be stricter than the task. When the task explicitly allows something, the plan must keep it allowed. A plan_checks warning that the plan says "only <path>" where the task does not is a bug when the warning is correct.
red_green not_applicable loosens the red-green proof. It needs a stated reason and fits only test-stabilization (the repro cannot fail on base without a production change the task does not require). If the reason does not justify it, report a bug.
protected_changes: each one is required by the original task, not just convenient; the diff of each protected file
matches its declared change and weakens no check, CI job, policy or protection. Otherwise report a bug.
A declared protected change needs no approval inside the run. Never report a missing approval.
