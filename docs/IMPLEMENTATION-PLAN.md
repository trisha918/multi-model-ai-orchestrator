# Reliability and optional modules

Implementation branch: `codex/reliable-local-and-optional-automation`.

Local `run` and Cursor skills remain usable without GitHub automation. No module may silently enable GitHub writes, model spending, or automatic merge.

- [x] Repair data preservation, locks, CI gates, model precedence and branch recovery.
- [x] Persist versioned execution results and append-only events; expose local history.
- [x] Validate privileged outputs and enforce run time/process budgets.
- [x] Add explicit, repository-scoped memory and a durable local queue.
- [x] Recommend routes from measured execution results; retain explicit overrides.
- [x] Document installation and each independent usage path in plain Persian and English.
- [x] Run local regressions and inspect changes: 221 passing tests, 82 syntax checks, six help-command smoke checks, 16 local guide links.

Delivery uses separate implementation and documentation commits on the branch above. See GitHub for the remote CI result; local validation did not call paid AI workers or run a live Issue/PR automation against a target repository. Release tags and main are unchanged.

Implemented contracts and intentionally deferred work are listed in [LOCAL-MODULES.md](LOCAL-MODULES.md). This is the first usable implementation of the five stages, not a claim that distributed execution, provider billing or OS sandboxing is complete.

Provider billing is often unavailable from CLI workers. Unknown cost must stay unknown; time/process limits must not be described as a guaranteed currency limit. Native Windows worktrees and filtered environments are not containers or a security sandbox.
