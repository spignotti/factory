# Changelog

## [0.5.1](https://github.com/spignotti/factory/compare/v0.5.0...v0.5.1) (2026-11-11)


### Bug Fixes

* **cli:** improve --aspect takes several values ([#146](https://github.com/spignotti/factory/issues/146)) ([f2ff195](https://github.com/spignotti/factory/commit/f2ff195961dfd3340ccfde4966bfec30fc3ad883))
* **finalize:** judge PR CI only by runs created after markReady ([#145](https://github.com/spignotti/factory/issues/145)) ([4a26ed1](https://github.com/spignotti/factory/commit/4a26ed1b5dd802141793c69d22aa602956e989ed))
* **gh:** base CI counts only GitHub Actions check runs ([#144](https://github.com/spignotti/factory/issues/144)) ([29318b3](https://github.com/spignotti/factory/commit/29318b3ed018707717fb9fad3dcd5bb0ee36fa96))
* **gh:** drop commits from the open-PR list query (GraphQL node limit) ([#143](https://github.com/spignotti/factory/issues/143)) ([cf45714](https://github.com/spignotti/factory/commit/cf45714f0a9a7100ed6aeb530a8998ba09ee8207))
* setup findings (ci-stub SHA, Context7 retry-after, --help, stale drafts) ([#141](https://github.com/spignotti/factory/issues/141)) ([3cd6ebf](https://github.com/spignotti/factory/commit/3cd6ebf6fc4af0071b04d93c230b16704686daff))

## [0.5.0](https://github.com/spignotti/factory/compare/v0.4.0...v0.5.0) (2026-11-11)


### Features

* factory improve (proposals as issues) ([#135](https://github.com/spignotti/factory/issues/135)) ([b307cb9](https://github.com/spignotti/factory/commit/b307cb91996e9e97333a1b91cabd6a832289d522))
* **improve:** aspects ci and tests ([#138](https://github.com/spignotti/factory/issues/138)) ([40c789b](https://github.com/spignotti/factory/commit/40c789bab6376b3d85c7c0f015f8d9f897fd354d))
* standards.md, standards reviewer, introduce-a-standard flow ([#136](https://github.com/spignotti/factory/issues/136)) ([78e3400](https://github.com/spignotti/factory/commit/78e3400c9dc0c5768cb99cd1d779cb247074e6f1))


### Bug Fixes

* **queue:** wait for an overlapping live run instead of parking for the night ([#139](https://github.com/spignotti/factory/issues/139)) ([de16538](https://github.com/spignotti/factory/commit/de1653815c9e05e3433f8e8f4015c237b7c19951))

## [0.4.0](https://github.com/spignotti/factory/compare/v0.3.0...v0.4.0) (2026-11-10)


### Features

* **audit:** add per-type focus notes for factory audit ([#59](https://github.com/spignotti/factory/issues/59)) ([5a9f6a0](https://github.com/spignotti/factory/commit/5a9f6a019790f8f8106c18a96de24214308b4cc9))
* **audit:** add read-only security, performance, and structure audits ([#57](https://github.com/spignotti/factory/issues/57)) ([f957eaa](https://github.com/spignotti/factory/commit/f957eaa048d9402a56467a75deac758851214520))
* central tool baseline, doctor checks and run gates ([#67](https://github.com/spignotti/factory/issues/67)) ([34bdfd3](https://github.com/spignotti/factory/commit/34bdfd3d868d8363accec3b210049ff59eb91f53))
* **ci:** minimal stub when no check runs in CI ([#122](https://github.com/spignotti/factory/issues/122)) ([b8fc0d6](https://github.com/spignotti/factory/commit/b8fc0d646677753ac8f8979784fbc1b89001b839))
* **evaluate:** log in before the UI session ([#33](https://github.com/spignotti/factory/issues/33)) ([aedb617](https://github.com/spignotti/factory/commit/aedb6178b07c84f7ac564262a7ea214b43b966da))
* factory queue (ordered per-repo ticket queue, worker, behind-PR updates) ([#131](https://github.com/spignotti/factory/issues/131)) ([014acc6](https://github.com/spignotti/factory/commit/014acc69194f0e5d15c878aefe74bac814b09f47))
* **gates:** per-check timeout for gate commands ([#55](https://github.com/spignotti/factory/issues/55)) ([b10783e](https://github.com/spignotti/factory/commit/b10783e6b7f4f2b85866c39cfd3c8ea52a3d2ee5)), closes [#51](https://github.com/spignotti/factory/issues/51)
* **gc:** clean up runs without PR, strip open-PR worktrees, auto gc at run start, doctor disk check ([#28](https://github.com/spignotti/factory/issues/28)) ([b6ec468](https://github.com/spignotti/factory/commit/b6ec468c4c4a282987fa5a910565ead9da616713))
* **gc:** retention for run home, metadata tarballs, and archive ([#49](https://github.com/spignotti/factory/issues/49)) ([c53eb39](https://github.com/spignotti/factory/commit/c53eb39f4c7f1b3d43fa0fd2e965648f8fdf02a4))
* **gc:** strip heavy run data at run end, keep logs, shared package cache ([#121](https://github.com/spignotti/factory/issues/121)) ([6da40e2](https://github.com/spignotti/factory/commit/6da40e25f7cf017562aad3961bdd881c13feb2e9))
* **limits:** leave test files out of max_diff_lines when asked ([#64](https://github.com/spignotti/factory/issues/64)) ([3d3a3d2](https://github.com/spignotti/factory/commit/3d3a3d2811ccbdb35b9901a5f92f81ce890b4db2))
* **notify:** outbox, flush, event_id, SIGTERM grace ([#37](https://github.com/spignotti/factory/issues/37)) ([38d6157](https://github.com/spignotti/factory/commit/38d6157ca17a8f4edfdf11979e518a20450df1fc))
* **notify:** send run-finished webhooks to the bot that started the run ([#56](https://github.com/spignotti/factory/issues/56)) ([6774b03](https://github.com/spignotti/factory/commit/6774b03bcc5c091813dd51862e5f663e0fde3c22))
* **ops:** add box heartbeat (supercronic + Healthchecks ping) ([#47](https://github.com/spignotti/factory/issues/47)) ([49848c9](https://github.com/spignotti/factory/commit/49848c9e6d319c6336b89e74afbd725da41ada1e))
* **ops:** status health, notify doctor checks, run --no-notify guard ([#38](https://github.com/spignotti/factory/issues/38)) ([8a8b9b8](https://github.com/spignotti/factory/commit/8a8b9b8164b622cdb1b13642ac98f66f4a20a824))
* parallel runs, risk section, and credential-free lock ids ([#36](https://github.com/spignotti/factory/issues/36)) ([ea01a3c](https://github.com/spignotti/factory/commit/ea01a3c99ede2ce4080eb4557fac59c8a0ffb6eb))
* pending PR CI, base_red resume, abandon, and run retention ([#34](https://github.com/spignotti/factory/issues/34)) ([7a892ed](https://github.com/spignotti/factory/commit/7a892ed3b8734bf01cfc5ba6611f5aafe587e8f7))
* **pipeline:** treat open factory PRs as path claims, release the slot before the finalize wait ([#118](https://github.com/spignotti/factory/issues/118)) ([e11df2a](https://github.com/spignotti/factory/commit/e11df2ab2ccbf5aac86ae1743ddbe408a1c71f2b))
* **services:** fixed host ports, env_from and local_only checks for host-side stacks ([#30](https://github.com/spignotti/factory/issues/30)) ([e8c21bb](https://github.com/spignotti/factory/commit/e8c21bb1e8a9d5622504a79ce8ababfe5a2059e5))
* **status:** morning summary with --since ([#120](https://github.com/spignotti/factory/issues/120)) ([cfba7cd](https://github.com/spignotti/factory/commit/cfba7cdade3178426e3d9627829e5dc7c89aeedf))


### Bug Fixes

* **adopt:** accept {file, change} objects in plan out_of_scope; name secrets files after the repo ([#29](https://github.com/spignotti/factory/issues/29)) ([f80b8bf](https://github.com/spignotti/factory/commit/f80b8bf228d94c7450e0e3f61c453cb522f3021b))
* **agents:** install guarded file tools without an OS sandbox ([#117](https://github.com/spignotti/factory/issues/117)) ([e737217](https://github.com/spignotti/factory/commit/e737217a7f99f0cddab36c95f7514515e1185bb4))
* **agents:** retry provider request timeouts and freeze-spanning calls; transient give-up ends needs_human, resumable ([#24](https://github.com/spignotti/factory/issues/24)) ([4c8efd7](https://github.com/spignotti/factory/commit/4c8efd72d01564bdbdd1e1f3d64d3e8f12d2f825))
* **agents:** retry provider stream aborts on the current call ([#97](https://github.com/spignotti/factory/issues/97)) ([8660339](https://github.com/spignotti/factory/commit/86603392f4c87f6b69aededf13d3602b205106f8))
* **ci:** defer draft pull request checks without skipping done ([#106](https://github.com/spignotti/factory/issues/106)) ([4bc2e6e](https://github.com/spignotti/factory/commit/4bc2e6e96fe814fc865f5d2868bb15128a30911d))
* **ci:** evaluate cancelled() only in the done step if ([#107](https://github.com/spignotti/factory/issues/107)) ([dbc3401](https://github.com/spignotti/factory/commit/dbc340170bf0ed2bc19c542f718f1e8f81821eab))
* **ci:** install the pinned git CLI with npm 11.21.1 ([#109](https://github.com/spignotti/factory/issues/109)) ([fdde34d](https://github.com/spignotti/factory/commit/fdde34d4bebab7fbe3c008657c58695c17f26959))
* **cli:** robust node resolution and doctor node check ([#35](https://github.com/spignotti/factory/issues/35)) ([dc14de6](https://github.com/spignotti/factory/commit/dc14de6f0f4d006933d1a2a32daf67ba53777770))
* **deploy-self:** test /proc cmdline content instead of -s so prune runs while runs are live ([#62](https://github.com/spignotti/factory/issues/62)) ([029a3b9](https://github.com/spignotti/factory/commit/029a3b9c9e2194d95620dae5d9b2bf561bdb6678))
* **deploy:** switch releases while runs are active ([#61](https://github.com/spignotti/factory/issues/61)) ([8bf25ea](https://github.com/spignotti/factory/commit/8bf25ea3dde82051f03378996536f09a68cf70c7))
* **doctor:** drop baseline false positives for nox, pyright, and rulesets ([#69](https://github.com/spignotti/factory/issues/69)) ([5bc1324](https://github.com/spignotti/factory/commit/5bc1324205772273ced390ae7e75a48b8f36db92))
* **eval:** rebuild the hidden-check environment after the run ([#103](https://github.com/spignotti/factory/issues/103)) ([4010b1d](https://github.com/spignotti/factory/commit/4010b1d373cfe4cd0802e9a2fa18ea94a09e1a7f))
* **finalize:** enable auto-merge only on green CI, back to draft on red ([#119](https://github.com/spignotti/factory/issues/119)) ([06557f5](https://github.com/spignotti/factory/commit/06557f510a6a52f2f0122b8d1fd9f58f028b9a2d))
* **gates:** drop deleted paths from semgrep scan targets ([#74](https://github.com/spignotti/factory/issues/74)) ([bcf6f44](https://github.com/spignotti/factory/commit/bcf6f44cca5220d0c823616af1c7e72280671e0c))
* **gates:** kill hung sandboxed checks and report a base timeout as inconclusive ([#72](https://github.com/spignotti/factory/issues/72)) ([4acc5aa](https://github.com/spignotti/factory/commit/4acc5aa2ba6ab30414beafb2f0bd001294366681))
* gc homes and merged worktrees while a repo slot is held ([#98](https://github.com/spignotti/factory/issues/98)) ([c2de940](https://github.com/spignotti/factory/commit/c2de940b8b8dcd743acf92b692fddefa743afb86))
* **gh:** skip PR and CI lookups in repos without a remote ([#125](https://github.com/spignotti/factory/issues/125)) ([25f607c](https://github.com/spignotti/factory/commit/25f607c3fc8853e1a21f41800dbcc73c5b22c7f0))
* **plan:** retry plan_normalize, keep issue scope, opt-in red_green exemption ([#95](https://github.com/spignotti/factory/issues/95)) ([5006d94](https://github.com/spignotti/factory/commit/5006d940ed514e98a0ad3d8d95d024296f1ffd07))
* pre-push path claims and alloc lock hardening ([#40](https://github.com/spignotti/factory/issues/40)) ([eaa6c5d](https://github.com/spignotti/factory/commit/eaa6c5def488374bb4d08900ed319138ab3c4cfe))
* rename-aware diff count; max_wall_minutes as active time, enforced mid-step ([#27](https://github.com/spignotti/factory/issues/27)) ([18f54e7](https://github.com/spignotti/factory/commit/18f54e7cdd0e6b98d4a5f0f3b4cb402c87489126))
* **resume:** fresh result.json per attempt; idempotent push and PR creation ([#26](https://github.com/spignotti/factory/issues/26)) ([3f7a995](https://github.com/spignotti/factory/commit/3f7a995348deb504768ced749523a4ef34e15f12))
* **risk:** fast-lane normalize failure no longer raises risk ([#123](https://github.com/spignotti/factory/issues/123)) ([21a9223](https://github.com/spignotti/factory/commit/21a92232f49a702f2934c533c8e3c8716bfb80d7))
* robustness batch (memory lock, retry-after, red-green exit, git/gh timeouts) ([#130](https://github.com/spignotti/factory/issues/130)) ([621550a](https://github.com/spignotti/factory/commit/621550aad1adfe7e71d43694f7da809bdc390aff))
* **sandbox:** run jailed commands as the host uid/gid with all capabilities dropped ([#25](https://github.com/spignotti/factory/issues/25)) ([f9736a1](https://github.com/spignotti/factory/commit/f9736a1dd9397e792753c73ec3e7cdd0be497b5a))
* strip sandbox home when a resume run's PR is merged or closed ([#100](https://github.com/spignotti/factory/issues/100)) ([a7d2d9a](https://github.com/spignotti/factory/commit/a7d2d9aecdbfbcca939a67221264f25bb699a02d))
