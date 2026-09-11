# First live GitHub Issue automation test (Windows)

This is the setup guide for the **first real** end-to-end test of Multi-Model AI Orchestrator v1.1 GitHub automation.

Use a **new private** repository named `ai-orchestrator-e2e-test`.

Do **not** use the public product repository `trisha918/multi-model-ai-orchestrator` for this first test.

Do **not** merge, tag, or publish v1.1 until this test is reviewed.

The orchestrator **will not register** a GitHub Actions runner. You do that in the GitHub UI.

## Who does what

### A. You (GitHub UI)

1. Create the private repo `ai-orchestrator-e2e-test`.
2. Push the files from `examples/github-e2e-test/`.
3. Register a **self-hosted Windows** runner **only on that private repo**.
4. Add the custom runner label `ai-orchestrator`.
5. Create the first Issue **without** `ai-auto`.
6. As OWNER/MEMBER/COLLABORATOR, add `ai-auto` when you are ready.
7. After `ai-ready-to-merge`, merge the PR yourself (or leave it open). The orchestrator must not merge.

### B. You (Windows runner machine)

1. Install Git, Node 20+, Cursor Agent, Codex, Antigravity; authenticate those CLIs.
2. Install `ai-orchestrator` (`.\install.ps1` in the orchestrator clone).
3. Run `.\scripts\verify-ai-runner.ps1` (inspect only).
4. Download and configure the GitHub Actions runner from the **private repo** Settings → Actions → Runners.
5. Keep the runner process running while you test.

### C. The orchestrator (automatic, after trusted `ai-auto`)

1. Confirms authorization again.
2. Converts the Issue to a task (body is requirements, not policy).
3. Uses smart routing when only `ai-auto` is present.
4. Implements in an isolated worktree.
5. Runs local `npm test`.
6. Pushes `ai/issue-<n>-...` (never `main`, never force-push).
7. Opens a PR (`Closes #<n>`).
8. Watches GitHub CI on that PR.
9. May fix up to 5 CI failures.
10. Stops at **READY FOR HUMAN MERGE**. No merge, no publish.

## Security: runner attachment

Attach the first AI runner **only** to the private test repository (or a trusted org/repo group that you control).

Do not attach it to arbitrary public repositories. Do not add this runner to a generic `pull_request` / `pull_request_target` workflow that checks out fork HEAD.

Labels the workflow requires:

```text
[self-hosted, Windows, ai-orchestrator]
```

### Add the custom `ai-orchestrator` label

1. GitHub → private repo → **Settings** → **Actions** → **Runners**.
2. New self-hosted runner (Windows). Follow GitHub’s download/config commands **on the runner PC**. Do not paste the registration token into git.
3. During `config.cmd`, when asked for labels, include:
   - `self-hosted` (usually added automatically)
   - `Windows` (usually added automatically)
   - **`ai-orchestrator`** (you type this)
4. After it is online, open the runner → **Labels** and confirm `ai-orchestrator` is present. You can add it later from that screen if you skipped it during config.
5. Start the runner (`run.cmd`). Leave it running.

GitHub-hosted `ci.yml` in the example uses `windows-latest` and **must not** use the AI runner.

## Token strategy

The AI workflow passes only:

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

That is the workflow token. A personal PAT is not required for the first test.

Least privilege on the automate job:

- `contents: write`
- `issues: write`
- `pull-requests: write`
- `actions: read`

The token is never printed.

A hosted **authorize** job runs first on `ubuntu-latest`. Untrusted `ai-auto` comments **AUTOMATION BLOCKED** and **does not start** the self-hosted AI runner.

## Copy the example project

On Windows, from the orchestrator clone:

```powershell
cd "F:\path\to\ai-orchestrator-mvp-v6"
Get-ChildItem .\examples\github-e2e-test
```

Create an empty **private** GitHub repo `ai-orchestrator-e2e-test`, then:

```powershell
cd $env:TEMP
git clone https://github.com/YOUR_LOGIN/ai-orchestrator-e2e-test.git
cd ai-orchestrator-e2e-test
Copy-Item -Recurse -Force "F:\path\to\ai-orchestrator-mvp-v6\examples\github-e2e-test\*" .
git add .
git commit -m "Initial e2e calculator for AI Issue test"
git push origin HEAD
```

Confirm locally:

```powershell
npm test
```

Expected: both `add` and `subtract` tests PASS.

## Verify the Windows AI machine

```powershell
cd "F:\path\to\ai-orchestrator-mvp-v6"
powershell -ExecutionPolicy Bypass -File .\scripts\verify-ai-runner.ps1
```

Expected concept:

```text
AI RUNNER READINESS
Git             OK
Node            OK
Orchestrator    OK v1.1.0
Cursor Agent    OK AUTHENTICATED
Codex           OK AUTHENTICATED
Gemini          OK AUTHENTICATED
GitHub Runner:
MANUAL CHECK REQUIRED / detected if possible
READY FOR GITHUB AI AUTOMATION:
YES
```

If `NO`, fix tools/auth. This script never registers a runner.

## GitHub CLI / doctor

Install [GitHub CLI](https://cli.github.com/) on a machine you use for setup (the runner can rely on `GITHUB_TOKEN` from Actions).

```powershell
gh auth login
ai-orchestrator github doctor
ai-orchestrator github doctor --repo YOUR_LOGIN/ai-orchestrator-e2e-test
```

Doctor must not print token values. With `--repo` it probes repository access, inferred issue/PR write, and whether a runner labeled `ai-orchestrator` is **online**.

If the runner is not online:

```text
LIVE TEST BLOCKED:
Self-hosted runner registration required.
```

Stop. Do not add `ai-auto` yet.

## Label setup

After `gh` or a token can reach the private repo:

```powershell
ai-orchestrator github labels setup --repo YOUR_LOGIN/ai-orchestrator-e2e-test --dry-run
ai-orchestrator github labels setup --repo YOUR_LOGIN/ai-orchestrator-e2e-test
```

Required names include: `ai-auto`, `ai-working`, `ai-needs-test`, `ai-test-failed`, `ai-fixing`, `ai-ready-to-merge`, `ai-human-review`, `ai-done`, `ai-failed`, `ai-stop`, plus route/model labels (`ai-codex-sol`, …).

## Test 1 — normal Issue does nothing

Create an Issue. **Do not** add `ai-auto`.

Title:

```text
Add multiply operation and tests
```

Body:

```text
Add an exported multiply(a, b) function to calculator.js.

Requirements:
- Preserve add() and subtract().
- Add tests for multiply().
- Do not change the existing public behavior.
- npm test must pass.

Acceptance criteria:
- multiply(3, 4) returns 12
- multiply(-2, 4) returns -8
- existing tests remain passing
```

Expected: no AI branch, no PR, no self-hosted AI job.

Record the Issue number. This proves a normal Issue does not start automation.

## Test 2 — trusted `ai-auto` (smart routing)

The example `.github/ai-orchestrator.yml` sets **`review.required: false`** so this first smoke can validate smart routing with `ai-auto` alone. Solo workers (CODEX/CURSOR/…) return `review: SKIP` and still proceed to PR + CI.

If you set `review.required: true`, do **not** use `ai-auto` alone: automation fails closed before workers and requires `ai-auto` + `ai-team`. See [AUTOMATION.md](AUTOMATION.md) (Review policy vs routing).

As a maintainer, add **only** `ai-auto` (no `ai-codex` / model labels).

Expected:

1. Hosted authorize job: trusted.
2. Self-hosted job starts.
3. Comment: AI Automation — Started (AUTO worker, AUTO model).
4. Branch `ai/issue-<n>-add-multiply-operation-and-tests` (slug may vary).
5. Local tests PASS (`review` may be SKIP on a solo route).
6. PR opened, GitHub `ci.yml` runs on the PR (hosted Windows).
7. Label `ai-ready-to-merge`.
8. PR remains **OPEN**. Not merged.

Record: workflow run id, issue number, route, models, branch, PR number.

### Optional — required-review TEAM smoke

Copy or edit config with `review.required: true`, then open a separate Issue and apply **`ai-auto` and `ai-team`**. Solo/AUTO-only labels must conflict before workers. Expected: TEAM implementation, independent review PASS, then PR + CI as usual.

```powershell
ai-orchestrator github status --repo YOUR_LOGIN/ai-orchestrator-e2e-test --issue N
```

## Test 3 — manual model label (optional second Issue)

Title: add `divide(a, b)` with tests; reject division by zero.

Labels after review: `ai-auto` **and** `ai-codex-sol`.

Expected route **CODEX**, model the resolved Sol id, no silent fallback, no auto-merge.

## Real CI fail → fix

Prefer a reversible test-only failure in this private repo. Do not sabotage production product logic.

If forcing a remote CI failure is impractical: keep the deterministic 3-attempt fixture in the orchestrator test suite, still run live Issue→PR→CI PASS, and report that a live CI-fix cycle was not forced.

Do **not** burn five live AI/CI rounds. The 5-fail → HUMAN_REVIEW path is proven by `npm test`.

## Quick start (checklist)

1. Install `ai-orchestrator` (`.\install.ps1`) — global command `ai-orchestrator`.
2. Register a Windows self-hosted runner **on the private test repo only**; label `ai-orchestrator`.
3. `.\scripts\verify-ai-runner.ps1`
4. Copy `examples/github-e2e-test` (includes assisted `.github/ai-orchestrator.yml`).
5. `ai-orchestrator github labels setup --repo OWNER/ai-orchestrator-e2e-test`
6. Create the multiply Issue **without** `ai-auto`.
7. Maintainer adds `ai-auto`.
8. Watch branch / PR / Checks.
9. Merge manually only after `ai-ready-to-merge`.

## Observability

State (no credentials) is under:

`%LOCALAPPDATA%\MultiModelAIOrchestrator\github-automation\<owner>\<repo>\issue-<n>.json`

Fields include issue, branch, PR, attempts, route, models, CI status, last error, timestamps.

GitHub comments are milestone updates (started, CI failed, fix pushed, ready, blocked), not per-log-line spam.
