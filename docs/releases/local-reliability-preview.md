# Local reliability preview

Base: v1.1 feature branch, commit `eb6690a`. Implementation: `595e286`.

This preview preserves direct CLI and Cursor skill usage while keeping GitHub automation optional. No release version or tag has been changed.

## Changes

- Preserve uncommitted/new worktree files and refuse destructive generic worktree cleanup.
- Make Issue locking exclusive, validate stored Issue identity and use consistent verification gates on resumed execution.
- Resume managed AI branches only with a matching expected SHA; verify the production GitHub checkout and default branch.
- Combine CI checks/statuses, paginate list APIs, preserve CI deadlines and distinguish missing evidence from passed tests.
- Persist schema-v1 run results and event history. Keep numeric `runTask` compatibility with an optional result callback.
- Bound worker/test time, process count and captured output; filter worker environments and redact buffered output.
- Add independent `runs`, `memory`, `queue` and `routing` commands with no external service dependency.
- Provide beginner Persian/English installation and usage paths plus explicit recovery/limitation documentation.

## Validation

- Windows, Node 24.20.0: **221 passed, 0 failed** in the complete `npm test` suite.
- Syntax check: **82** source/bin `.mjs` files.
- Six command-help smoke checks and 16 local documentation-link checks.
- New regressions cover concurrent locks, preservation of new files, pinned branch resume, real run-result wiring with simulated workers, CI gates and pagination, process budgets, Unicode/redaction, repository memory, exclusive queue execution and measured routing.
- GitHub CI is configured for Windows Node 20 on main, feature and Codex branches. Its result must be checked independently after push.

Tests use temporary Git repositories and injected worker/GitHub adapters. They do not prove live provider compatibility or real GitHub runner behavior. Currency accounting, a full OS sandbox, distributed scheduling and automatic model learning remain outside this preview. See [the technical reference](../LOCAL-MODULES.md).

The first remote Windows Node 20 run exposed an existing short-path identity problem (`RUNNER~1` versus `runneradmin`). A follow-up fix uses native path resolution, including the existing ancestor of not-yet-created worktrees, and adds a dedicated Windows alias regression. The suite now contains 222 tests; consult the CI run on the delivered commit for its result.
