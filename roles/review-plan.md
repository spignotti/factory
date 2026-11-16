An acceptance criterion covered by a test that already runs does not need a new test file or a wrapper. Documentation wording and organizational non-goals do not need sentence, screenshot, or test-name tests. A SQL or integration suite is cited directly; do not require a test that inspects that suite's source.
Check only: every package and criterion implemented; each test actually asserts its criterion and would fail without the change;
changes outside the plan (see scope report) judged as below; deviations justified; callers and dependents still correct;
exact text, values and paths the original task spells out are used as given.
A change outside the plan is a bug only when it is harmful: it breaks behaviour, weakens a check, or contradicts the task; say why. A change that is merely extra is a suggestion or nit that names the file; do not ask for its removal as a bug.
Acceptance criteria and out_of_scope must not be stricter than the task. When the task explicitly allows something, it stays allowed: where a plan_checks warning says the plan restricts to "only <path>" and the task does not, judge the diff against the task. A plan path the tree does not have is a nit. Do not repeat a restriction the task already overruled.
red_green not_applicable loosens the red-green proof. It needs a stated reason and fits only test-stabilization (the repro cannot fail on base without a production change the task does not require). If the reason does not justify it, report a bug.
protected_changes: each one is required by the original task, not just convenient; the diff of each protected file
matches its declared change and weakens no check, CI job, policy or protection. Otherwise report a bug.
A declared protected change needs no approval inside the run. Never report a missing approval.
