# GitHub automation

**Optional:** local `run`, Cursor commands, history, memory, queue and measured routing work without this module. New users can start with [START-HERE.md](START-HERE.md) or [START-HERE-FA.md](START-HERE-FA.md).

Development-branch changes: required tests/review accept only PASS, including on resume; SKIP and UNKNOWN do not pass required gates. Choose TEAM if independent AI review is required. A solo coding run has review SKIP. When `review.required: true`, Issue automation rejects AUTO and solo routes (`ai-codex`, `ai-cursor`, `ai-gemini`, model labels) **before** workers run; use `ai-auto` **and** `ai-team`. When `review.required: false`, `ai-auto` alone may smart-route to a solo worker. Gate failures are diagnosed separately (implementation failed / local tests failed / required AI review did not pass); a PASS local-test result is never recorded as “local tests failed”. CI Check Runs and commit statuses are combined, and reads paginate. A failed resumed CI observation enters the bounded fix loop when automation is enabled. Run live commands from the matching target checkout; new Issue runs require its HEAD to match the fetched remote default branch. [Details and crash recovery](LOCAL-MODULES.md).

Install the reviewed orchestrator revision on the runner before testing; the workflow invokes its installed global CLI. Upgrading the repository checkout alone does not upgrade that installation. Native worktrees and filtered subprocess environments are not a container sandbox.

Optional v1.1 engine: **GitHub Issue → AI implementation → PR → CI → fix loop → ready for human merge**.

Default mode is **manual**. Nothing Issue-related runs until you enable a repository config **and** a trusted actor adds `ai-auto`.

## Modes

| Mode | v1.1 behavior |
| --- | --- |
| `manual` | Existing `/ai` commands only. No Issue automation. |
| `assisted` | Label-triggered implementation, tests, PR, CI watch, bounded fixes. Stops at ready for human merge. **No auto-merge. No auto-publish.** |
| `autonomous` | Recognized in config so later releases can add merge/deploy policy. **v1.1 still disables merge and publish.** Treat it like assisted for those policies. |

## Trigger

1. Issue created → idle.
2. Trusted OWNER / MEMBER / COLLABORATOR (or `allowed_actors`) adds `ai-auto`.
3. Automation may start.
4. Removing `ai-auto` prevents **new** runs where practical.
5. `ai-stop` cancels after the current safe boundary (no new worker, no extra fix push).

## Review policy vs routing

| Config | Labels | Behavior |
| --- | --- | --- |
| `review.required: false` | `ai-auto` only | Smart routing may choose CODEX/CURSOR/etc. Solo runs set `review: SKIP` and may still proceed to PR + CI. |
| `review.required: true` | `ai-auto` + `ai-team` | TEAM runs and can produce an independent AI review. |
| `review.required: true` | `ai-auto` alone, or solo/model labels (`ai-codex`, `ai-codex-sol`, `ai-cursor`, `ai-gemini`, …) | **Policy conflict before workers.** No implementation spend. Human review label / CONFLICT. Explicit manual routes are not silently overridden. |

The first live smoke test uses `review.required: false` so `ai-auto`-only smart routing can complete. Optionally add a second smoke Issue with `review.required: true` and labels `ai-auto` + `ai-team` to exercise required review.

## Attempt limits

GitHub automation uses a top-level `max_fix_attempts` (default **5**, maximum 5).

This is separate from the local TEAM/worker fix rounds inside `runTask`.

After 5 failing GitHub CI observations the engine stops and requests human review. There is no attempt 6.

## PR and CI

Assisted mode pushes **only** the `ai/issue-...` branch (never `main`, never force-push) and opens one PR. Local tests are not GitHub CI. Checks are classified `PENDING`, `PASS`, `FAIL`, or `TIMEOUT`. Logs are fetched when the API allows and redacted before storage.

## State machine

Canonical allowed transitions live in `src/github-state.mjs` (`ALLOWED_TRANSITIONS`). Illegal moves are rejected.

| From | To | Trigger |
| --- | --- | --- |
| IDLE | STARTED / WORKING | Trusted `ai-auto` start |
| IDLE | WAITING_FOR_CI | Existing PR found at start; skip implementation |
| IDLE | BLOCKED | Untrusted trigger actor |
| IDLE | CONFLICT | Contradictory route/model labels |
| STARTED | WORKING / IMPLEMENTING / LOCAL_TESTS / WAITING_FOR_CI | Implementation begins, or skip-ahead when work already exists |
| STARTED | FAILED / CANCELLED / BLOCKED | Local tests FAIL, `ai-stop`, or untrusted |
| LOCAL_TESTS | WAITING_FOR_CI | Branch on remote + PR opened or reused |
| LOCAL_TESTS | FAILED / HUMAN_REVIEW_REQUIRED / CANCELLED | Tests FAIL, unreconciled push crash, or `ai-stop` |
| WAITING_FOR_CI | READY_FOR_HUMAN_MERGE | GitHub CI PASS |
| WAITING_FOR_CI | FIXING | CI FAIL/TIMEOUT and attempts remain |
| WAITING_FOR_CI | HUMAN_REVIEW_REQUIRED | Attempt limit, or CI PASS but required review/tests did not |
| WAITING_FOR_CI | FAILED | Resume CI sync sees FAIL (no extra fix start) |
| READY_FOR_HUMAN_MERGE | DONE | Human merged / closed (never auto-merge) |
| READY_FOR_HUMAN_MERGE | HUMAN_REVIEW_REQUIRED | CI PASS but required local tests or review did not |
| HUMAN_REVIEW_REQUIRED | WAITING_FOR_CI / LOCAL_TESTS | Crash-recovery reconcile only (`unsafePushPending`) |
| FAILED | _(none)_ | Terminal |
| BLOCKED | _(none)_ | Terminal |
| DONE | _(none)_ | Terminal |

Impossible (rejected): `FAILED` / `BLOCKED` / `DONE` → any other stage; `READY_FOR_HUMAN_MERGE` → `STARTED` / `IMPLEMENTING` / `WAITING_FOR_CI`; `HUMAN_REVIEW_REQUIRED` → `IMPLEMENTING`; `IMPLEMENTING` → `STARTED` (resume must not rewind).

Terminal (no auto-advance): `FAILED`, `BLOCKED`, `DONE`, `CANCELLED`, `CONFLICT`.  
Human-gated: `READY_FOR_HUMAN_MERGE`, `HUMAN_REVIEW_REQUIRED`.

```text
ai-auto
  → ai-working
  → ai-needs-test
  → (CI fail) ai-test-failed → ai-fixing → ai-needs-test
  → (success) ai-ready-to-merge
  → (limit / conflict / stop) ai-human-review
  → (closed) ai-done
```

Contradictory status labels are removed when a new status is applied.

## Human stop and review

- `ai-stop` → `CANCELLED` / `ai-human-review`
- Untrusted `ai-auto` → `AUTOMATION BLOCKED` / untrusted trigger actor
- Max attempts or unrecoverable CI → `HUMAN REVIEW REQUIRED`
- Crash during push → do not blindly push again; resume requires a clear state or human confirmation

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Started: trusted ai-auto
  Idle --> WaitingCI: existing PR
  Idle --> Blocked: untrusted ai-auto
  Started --> LocalTests: implementation PASS
  Started --> Failed: local tests FAIL
  LocalTests --> WaitingCI: push + PR
  WaitingCI --> Ready: GitHub CI PASS
  WaitingCI --> Failed: resume CI FAIL
  WaitingCI --> Fixing: CI FAIL and attempts < 5
  Fixing --> WaitingCI: fix pushed
  WaitingCI --> HumanReview: 5th CI FAIL or TIMEOUT at limit
  Ready --> Done: human merge
  Ready --> HumanReview: required local/review missing
  HumanReview --> WaitingCI: crash reconcile
  Failed --> [*]
  Blocked --> [*]
  Done --> [*]
```

State files live under `%LOCALAPPDATA%\MultiModelAIOrchestrator\github-automation\` (no credentials).

Offline lifecycle (no GitHub network): `ai-orchestrator github simulate --fixture tests/fixtures/github-simulate/<scenario>.json` drives the real state machine with an in-memory GitHub/git/CI client. v1.1 still stops at ready-for-human-merge.

## First live test

Use a **private** repo (`ai-orchestrator-e2e-test`) and the template in `examples/github-e2e-test/`. Full Windows steps: [GITHUB-LIVE-TEST.md](GITHUB-LIVE-TEST.md).

Workflow security: hosted `authorize` job (collaborator permission) **then** self-hosted AI job. `GITHUB_TOKEN` only.

## Quick start

1. Install `ai-orchestrator` (`.\install.ps1`).
2. Register a Windows self-hosted runner on the **private** test repo; add label `ai-orchestrator`.
3. `.\scripts\verify-ai-runner.ps1`
4. Copy example config/workflows from `examples/github-e2e-test`.
5. `ai-orchestrator github labels setup --repo OWNER/ai-orchestrator-e2e-test`
6. Create Issue without `ai-auto`.
7. Maintainer adds `ai-auto` only (example config has `review.required: false` for this smart-routing smoke).
8. Watch branch/PR/CI.
9. Merge manually after READY.
