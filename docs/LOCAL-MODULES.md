# Local modules and execution contracts

[Beginner English guide](START-HERE.md) · [راهنمای فارسی](START-HERE-FA.md)

This development iteration keeps the existing global CLI and Cursor skills. There is no database server, scheduler service, Redis, vector database, or additional npm dependency. GitHub automation remains off by default. `github-options.mjs` contains cheap CLI parsing; the automation command loads the GitHub execution adapter only when selected.

## Commands and boundaries

| Component | Entry point | Effects |
| --- | --- | --- |
| Local execution | `run`, existing Cursor skills | Worker/test processes; isolated Git worktree by default; local commit only when requested |
| Results/history | `runs list/show/events` | Local reads |
| Notes | `memory add/list/search/remove` | Local repository-scoped storage; no model calls |
| Queue | `queue add/list/cancel/recover` | Local job records; no worker on add |
| Queue worker | `queue run --limit N` | Foreground sequential execution; same run pipeline and budgets |
| Route advisor | `routing stats/recommend` | Local history analysis; no model calls |
| GitHub | `github ...` | Separately configured API/push operations; no merge or publish |

Local operation requires only the chosen worker. AUTO can select an unavailable worker; use explicit modes on machines with partial installations. GEMINI currently means the project's `agy` adapter, not an interchangeable Gemini executable.

## Result schema v1

Every ordinary `run` creates `runs/<run-id>/result.json`. A validation failure inside the run also gets a failed result. Invalid CLI syntax can be rejected before a run is allocated. The legacy diagnostic print-task hook creates no run.

```json
{
  "version": 1,
  "runId": "20260911T100000Z-task-abcdef",
  "status": "COMPLETED",
  "ok": true,
  "exitCode": 0,
  "repository": "C:\\Projects\\MyApp",
  "route": "CODEX",
  "tests": "PASS",
  "review": "SKIP",
  "implementation": "PASS",
  "branch": "ai/example",
  "commit": "",
  "worktreeState": "PRESERVED (uncommitted files; review and commit them first)",
  "durationMs": 5000,
  "processCalls": 2,
  "costUsd": null,
  "costStatus": "unavailable"
}
```

Additional fields record source HEAD, classification, selected models, worktree/log paths, timestamps, failed stage and error. Commit contains a full SHA or the empty string, never a human-readable reason. `review: SKIP` is normal for solo Codex/Cursor. Local completion with `tests: SKIP` is allowed for projects without a detected test runner; it is not verified test success.

The JavaScript `runTask(argv, options)` interface still returns a numeric exit code. Consumers can provide `options.onResult(result)` to receive schema v1. GitHub no longer manufactures PASS from exit code 0. Its production adapter requires a structured successful result, the authorized AI branch and a matching full SHA. Required tests and review each require explicit PASS.

`events.jsonl` appends run-result, stage-start/finish and process-start/finish events. `stages.json` is checkpointed after completed stages. Snapshots use a temporary file and rename. These records aid diagnosis after a process crash; they are not a transaction across Git, files and GitHub, and they do not resume an interrupted model conversation. Abrupt power loss can leave a truncated last JSONL line; preserve the file and ignore only that incomplete final line when inspecting it.

Logs from older releases without `result.json` remain on disk but are not automatically imported into the new history or routing statistics.

## Work preservation

Automatic successful-worktree cleanup uses `git worktree remove` **without force**. Dirty worktrees, including new files, are retained. Git can also refuse removal for ignored files. `diff.patch` is supplemental; untracked file contents live in the retained worktree, not necessarily in that patch.

The generic cleanup command keeps all worktree directories, active runs and run folders paired with retained worktrees. It never recursively deletes a worktree. After inspecting and committing a worktree, an experienced user can remove the clean worktree with Git. Do not add `--force` to bypass unresolved files. Old inactive run logs can be removed with `cleanup --apply`; this also removes their history/routing evidence.

CI fixes can reattach an existing AI branch only through the trusted adapter's expected-SHA context. The SHA must match; an attached worktree must match the managed path and original run metadata and be clean. Arbitrary CLI `--branch` reuse remains refused. Human edits on that branch require inspection before automation continues.

## Budgets and subprocess output

| Control | Default | What it bounds |
| --- | --- | --- |
| `--max-seconds` | 3600 | Worker/test execution window, including retry attempts |
| `--max-processes` | 20 | Total worker/test process launches by the orchestrator |
| `--max-fix-rounds` | 2, capped at 5 | Local TEAM correction rounds |
| Worker timeout config | Existing settings | Each worker; additionally clamped to remaining run budget |
| Captured subprocess output | 4 MiB per process | Combined stdout/stderr; process stopped at limit |

The run clock begins before task preparation, but only worker/test launches are interrupted by this budget. Git operations, model discovery and filesystem work have separate behavior/timeouts and can add elapsed time. A worker may perform many tool calls internally during one process launch. This is not an internal-token or internal-tool-call quota. Currency and token budgets are not advertised: aggregate CLI billing is not reliable, so `costUsd` remains null.

Retries share the same launch and time budgets. A stopped/failed run preserves its worktree. Output is buffered until process completion and redacted as a complete text stream, including known secret environment values, before being printed or returned. UTF-8 decoding preserves characters split between chunks. Patterns cannot identify every possible secret in arbitrary source code; task text and logs are private local artifacts.

Worker/test environments use an allowlist of OS paths, locale, proxy/certificate settings, provider authentication and worker configuration. GitHub tokens and arbitrary inherited application secrets are excluded. Projects needing custom environment variables should configure their test environment explicitly; secrets must not be committed in fixtures. Worktrees and environment filtering are **not OS isolation**: programs can still access resources permitted to the Windows user, including credential stores and provider configuration. Use a dedicated runner for automation; container/VM sandbox integration remains future work.

## Independent tests

The existing detector supports npm `scripts.test`, Laravel Artisan, Flutter/Dart, Cargo, Go, .NET and pytest layouts. The orchestrator invokes the selected test process itself. No supported runner produces SKIP with a reason. Do not interpret an agent saying “tests passed” as a test result.

For a Node project, define a real `scripts.test` in its package.json, for example `"test": "node --test"`, and make sure its test files exist. Install required target dependencies as part of the target's setup; an isolated worktree does not inherit an untracked `node_modules` folder. Native project tests can execute arbitrary project code; only run trusted projects on your workstation.

## Memory

Notes are stored in `memory/<sha256-of-canonical-repository-path>/<uuid>.json`. Windows paths are normalized without case distinctions. Different clones intentionally have separate memories. Notes are user-authored, bounded to 16000 UTF-8 bytes and expire for retrieval after 90 days by default. `--days` overrides expiry. Expiration does not delete the file; `memory remove` does.

`run --memory` retrieves up to five notes by Unicode word overlap and includes at most approximately 12000 characters of note context. This is local lexical search, not embeddings or an external service. Current task/repository rules take precedence. Without that flag no memory is inserted. Model replies, Issue bodies and CI logs are never automatically promoted to trusted memory.

## Queue

Job states: PENDING → RUNNING → COMPLETED or FAILED; PENDING can become CANCELLED, and an interrupted RUNNING job can be explicitly marked INTERRUPTED. Adding a job copies its task input into a durable record. There is no background daemon or scheduled execution. `queue run --limit N` holds an exclusive worker lock and runs up to N pending jobs sequentially, default 1, maximum 100.

Jobs are independent: each run begins from the target's current checked-out commit. They do not automatically merge earlier outputs. Flags saved in the job are preserved; user config and environment resolve at execution time. A numeric zero without a structured successful result is recorded as FAILED, not COMPLETED.

## Crash recovery

File locks use atomic exclusive creation. They contain PID, ownership token and creation time. Release checks the token. **Age alone never invalidates a lock** because a live AI run can legitimately be long. Normal completion releases locks; a killed process can leave a lock and RUNNING snapshot.

1. Read the lock path from the error and inspect its JSON. Confirm the owning process has stopped, on the same host. If unsure, stop here; removing an active lock permits duplicate execution.
2. Inspect `runs/<id>/result.json`, `events.jsonl`, stage files and the worktree. Never reset or delete the worktree as a recovery shortcut.
3. Only after verifying the owner is stopped, remove the **specific lock file** shown in the error. In PowerShell use `Remove-Item -LiteralPath "EXACT_LOCK_FILE_PATH"`; do not recursively delete the runtime directory. A PID can be reused, so inspect the process identity as well as its number.
4. For queue jobs, `queue recover JOB_ID` marks the stopped RUNNING job INTERRUPTED without replaying it. Review and integrate/discard changes yourself before adding a new job.
5. For GitHub, `github resume` reconciles a pending push against its stored branch/SHA and observes CI using the same required-test/review gates. A changed SHA, dirty retained worktree or ambiguous push requires human inspection.

Local interrupted runs are not silently retried. There is no automatic power-loss rollback or exactly-once transaction across remote services.

## Measured routing

History is scoped to the canonical target path and matching heuristic task class/risk. Only terminal runs with actual test PASS/FAIL/TIMEOUT and recorded model metadata enter the statistics. Candidates are grouped by route and model. The initial policy needs five samples and 80% success, ranks success before mean duration, and uses the existing heuristic when evidence is insufficient.

`routing recommend` is read-only. `run --routing learned --mode auto` opts into choosing between CURSOR and CODEX from these statistics. It does not change the model-selection policy or override an explicit mode/model flag. GEMINI analysis and TEAM classifications are not downgraded. This is an initial evidence-based policy, not proof one model is universally better; tasks, model versions and local test quality can bias the sample.

## GitHub changes

Issue locks are acquired before state inspection and any writes, including blocked/conflict states. The production CLI checks that `origin` matches the requested slug. New Issue work must start from current remote default-branch HEAD; the CLI fetches and compares, but does not reset your checkout. Required local tests/review cannot be bypassed on resume. CI reads combine Check Runs and commit statuses and propagate API errors instead of treating them as absent checks. Check, status, branch, Issue-event and open-PR lists paginate. CI wait start time survives resume.

Existing PR discovery requires an open AI branch with the exact Issue number and a closing reference. Pushes are restricted to the stored branch and expected SHA; no force push. A resumed failed CI observation enters the same bounded fix loop when automation is enabled. Disabled automation can synchronize prior CI but cannot start a new fix worker. The final gate is always human merge.

This implements controlled adapter outputs and credential filtering, not the complete isolated privileged-executor architecture of gh-aw. Test mocks exercise the state machine and HTTP response handling; release validation still needs real installed worker/runner testing.

## Design choices and next extensions

The comparison informed these small independent components:

| Reference | Idea used here | Deliberately deferred |
| --- | --- | --- |
| [github/gh-aw](https://github.com/github/gh-aw) | Validate outputs before GitHub effects; preserve evidence and explicit gates | Workflow compiler, Linux sandbox/firewall and a separate privilege domain |
| [SWE-agent/mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) | Small execution contract, step history, bounded execution | Assuming every CLI exposes reliable token/cost accounting |
| [ruvnet/ruflo](https://github.com/ruvnet/ruflo) | Optional memory/queue and measured routing concepts | Distributed swarm, vector/RAG stack, automatic learning claims |

These modules are original implementations using Node built-ins; no reference project is installed as a dependency. Next extensions should be driven by real run data: provider-specific usage adapters, a dedicated execution sandbox, stronger CI-required-context policies, and a user interface for reviewing retained output.
