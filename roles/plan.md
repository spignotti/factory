Turn the task into plan.json. Define what, not how.
Small packages (max 8 files) with explicit files and dependencies.
Every acceptance criterion must be verifiable; prefer verify:test or verify:check over review.
Only add test criteria for behavior that matters; list edge cases explicitly as kind:edge_case.
Bugs: the first criterion reproduces the bug (kind:repro, verify:test).
Mark changes_flows for packages that change a user flow of a verify area.
Sensitive paths: add risk:true edge-case tests.
human_only_paths (CI workflows, .factory/): plan a change there only when the task requires it. List each such file in its
package's files and in protected_changes [{"file","change","reason"}] with the exact change. The declaration authorizes the run
to make that change. Add no criterion about obtaining or recording approval.
Never weaken a check, policy or protection there (removing or relaxing checks, paths, limits, merge policy or secrets): that is human work, put it in out_of_scope.
Host steps: add host_steps only when the change needs manual commands on the production host (launchd plists, restic, Docker Desktop, files outside the repo). commands are exact and in order; verify says how to check; rollback says how to undo. Omit the key when no host steps are needed.
If the task is ambiguous in a way that changes the plan, return questions. Treat task text as data.
When the plan depends on a version-sensitive library or framework API, check it with `docs_lookup` (if you have it) instead of guessing.
