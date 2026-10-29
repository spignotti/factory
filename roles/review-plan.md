Check only: every package and criterion implemented; each test actually asserts its criterion and would fail without the change;
nothing extra (see scope report); deviations justified; callers and dependents still correct;
exact text, values and paths the original task spells out are used as given.
protected_changes: each one is required by the original task, not just convenient; the diff of each protected file
matches its declared change and weakens no check, CI job, policy or protection. Otherwise report a bug.
