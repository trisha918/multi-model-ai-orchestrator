# Troubleshooting

For retained worktrees, interrupted local queue jobs, locks, missing result records, SKIP test outcomes and unknown billing, see [local module troubleshooting and crash recovery](LOCAL-MODULES.md#crash-recovery). Locks are not automatically stolen after a fixed age. Inspect and stop their owner before removing an exact lock file; never delete the whole runtime directory as a shortcut.

## Runner offline

`ai-issue.yml` AI job uses `runs-on: [self-hosted, Windows, ai-orchestrator]`. If no runner with those labels is idle, the job queues. Register a runner on a Windows machine that already has the AI CLIs. Do not silently install a runner with leaked tokens.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-ai-runner.ps1
ai-orchestrator github doctor --repo OWNER/ai-orchestrator-e2e-test
```

If doctor reports no online `ai-orchestrator` runner:

```text
LIVE TEST BLOCKED:
Self-hosted runner registration required.
```

That is a setup blocker, not an orchestrator unit-test failure. Follow [GITHUB-LIVE-TEST.md](GITHUB-LIVE-TEST.md). Do not add `ai-auto` yet.

## `ai-auto` does nothing

- Config missing, invalid, `enabled: false`, or `mode: manual`
- Label was not applied by a trusted actor
- Workflow `if:` did not match (wrong label name)
- Runner offline
- Duplicate run already `READY_FOR_HUMAN_MERGE` or locked

```powershell
ai-orchestrator github issue inspect --repo owner/name --issue N
ai-orchestrator github status --repo owner/name --issue N
```

## GitHub auth failure

Install `gh` and run `gh auth login`, or set `GITHUB_TOKEN` on the runner. Doctor should say GitHub CLI/API OK without printing secrets.

## Issue not authorized

`AUTOMATION BLOCKED` / `untrusted trigger actor`. Have an OWNER/MEMBER/COLLABORATOR apply `ai-auto`, or add the maintainer to `allowed_actors`.

## Dirty repo

Local `ai-orchestrator run` refuses dirty sources. Commit or stash. Isolation will not discard user files.

## CI stuck / PENDING

GitHub checks never started, or required workflows ignore `ai/*` branches. Inspect the PR Checks tab. Automation classifies empty checks as PENDING; timeout becomes TIMEOUT.

## CI logs unavailable

Actions log download often needs extra permissions or is a zip. The client records `unavailable` and still passes the check summary into the fix prompt.

## Model unavailable

Manual labels (`ai-codex-sol`, …) never fall back. Use AUTO labels or install/discover the model (`ai-orchestrator models refresh`).

## Max attempts / human-review

Five GitHub CI failures stop the loop. Read the HUMAN REVIEW REQUIRED comment. Resume only after a human decision (`github resume` when state is safe).

## Branch or PR already exists

The engine reuses recorded state and existing PRs instead of opening duplicates. If a stray `ai/issue-N-*` branch exists without state, choose a new suffix or inspect state under `%LOCALAPPDATA%\MultiModelAIOrchestrator\github-automation\`.

## Duplicate automation run

GitHub Actions `concurrency` is keyed by repository + issue number. A local `.lock` file also blocks a second worker. Retries should resume rather than fork a second PR.

## Self-hosted runner problems

PATH missing `ai-orchestrator`; Cursor Agent/Codex/agy logged out; runner running as a different Windows user than the authenticated CLIs; disk full under LocalAppData worktrees.

## DEP0190 / cmd spawning

The orchestrator must spawn with argument arrays, not `shell: true`. If a CLI wrapper interpolates `--task`, re-run `.\install.ps1` so the PowerShell shim uses `@args`.
