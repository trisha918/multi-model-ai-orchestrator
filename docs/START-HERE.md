# Start here

[راهنمای کامل فارسی](START-HERE-FA.md) · [Technical reference](LOCAL-MODULES.md)

The orchestrator runs your installed AI coding tools, independently runs project tests, and keeps a record of the outcome. You can use it entirely through local commands. GitHub Issue automation is an optional module.

These additions are on `codex/reliable-local-and-optional-automation`, based on the v1.1 feature branch. Until merged, cloning `main` does not install these additions. Windows is the validated host.

## Choose your path

| What you want | Command | GitHub automation required? |
| --- | --- | --- |
| Give one instruction yourself | `ai-orchestrator run` | No |
| Give instructions in Cursor chat | `/ai-codex`, `/ai-cursor`, `/ai-team` | No |
| See previous results | `ai-orchestrator runs` | No |
| Save project notes | `ai-orchestrator memory` | No |
| Store tasks and run them later yourself | `ai-orchestrator queue` | No |
| Compare measured routing outcomes | `ai-orchestrator routing` | No |
| Work from Issues and create PRs | `ai-orchestrator github` | Yes |

Start with one installed worker and an explicit mode. TEAM needs Cursor Agent, Codex and Antigravity.

## Install

1. Install [Git for Windows](https://git-scm.com/install/windows) and a supported [Node.js LTS for Windows](https://nodejs.org/en/download). This package requires Node 20 or newer. npm comes with Node.
2. Open a new PowerShell window. Check `git --version`, `node --version`, and `npm.cmd --version`. Each should print a version.
3. Install and sign in to the worker you want. For [Codex CLI](https://learn.chatgpt.com/docs/codex/cli), choose the Windows installation tab, then run `codex` and sign in. For [Cursor CLI](https://prod.cursor.com/help/integrations/cli), follow the Windows PowerShell instructions and run `agent auth`. Verify with `codex --version` or `agent --version`.
4. Gemini mode in this project uses the `agy` Antigravity adapter. This repository does not ship an `agy` installer. Having a Gemini desktop application is not sufficient. Verify `agy models` before using GEMINI or TEAM; otherwise use Codex or Cursor mode first.

Copy these commands into PowerShell one line at a time:

```powershell
git clone --branch codex/reliable-local-and-optional-automation https://github.com/trisha918/multi-model-ai-orchestrator.git
cd multi-model-ai-orchestrator
.\install.ps1
```

If PowerShell blocks that script, run `powershell -ExecutionPolicy Bypass -File .\install.ps1`. The installer links the global command and installs the project-owned Cursor skills. It can add npm's global bin directory to your **user** PATH. It does not install Git, Node, or AI workers. Reopen PowerShell and Cursor afterward.

```powershell
ai-orchestrator version
ai-orchestrator doctor
ai-orchestrator models refresh
```

Doctor can report workers you have not installed. Choose an explicit installed worker for your run. Unconfigured GitHub is not a requirement for local work. Model refresh queries installed CLIs; it does not launch a coding task.

## Prepare your target project

The orchestrator installation folder and your target project are different folders. Open your target project's terminal:

```powershell
cd "C:\Projects\MyApp"
git status
```

Replace the example path with your own. The target needs a valid Git commit. Commit or stash your existing changes before using isolated mode. Nothing is silently discarded.

For a genuinely new project, first create a suitable `.gitignore`, excluding secrets such as `.env` and dependency directories. Then run `git init`, `git add .`, review `git diff --cached --stat`, and create `git commit -m "Initial project"`. If Git requests identity, set your own `git config user.name "Your Name"` and `git config user.email "you@example.com"` in that repository.

## Run one task yourself

```powershell
ai-orchestrator run --mode codex --task "Fix the login validation bug and add a regression test"
```

From another directory, include the target path:

```powershell
ai-orchestrator run --repo "C:\Projects\MyApp" --mode cursor --task "Fix the login form spacing"
```

The default creates a **worktree**: a separate working folder connected to the same Git repository. Your original working folder is not automatically updated. Read the worktree path and branch name printed at the end.

| Mode/flag | Meaning |
| --- | --- |
| `--mode codex` / `cursor` | Use that worker |
| `--mode gemini` | Antigravity analysis with a read-only contract |
| `--mode team` | Cursor plan → Codex implementation → independent tests → Gemini review → bounded fixes |
| `--mode auto` | Use task classification; may select a worker you have not installed |
| `--model auto` | Automatic model selection; explicitly overrides older model defaults |
| `--commit-on-pass` | Make a local commit after successful completion; does not push |
| `--in-place` | Work directly in the original folder; avoid for your first run |

For multiline instructions, save a UTF-8 text file **outside** the target repository:

```powershell
ai-orchestrator run --repo "C:\Projects\MyApp" --mode codex --task-file "C:\Tasks\task.txt"
```

Scripts may use `--task-stdin` with a UTF-8 producer. Choose exactly one task input source. Putting an untracked task file inside the target would make the target dirty and block isolation.

## Use existing Cursor commands

Open the target project in Cursor. In Agent chat, send one request at a time:

```text
/ai-codex Fix login validation and add tests
/ai-cursor Fix the form layout
/ai-team Refactor authentication with tests and review
/ai-models
```

If skills are missing, run `ai-orchestrator install-skills` and reload Cursor. Existing commands remain supported. Use the terminal `run` command for explicit budget and memory flags.

## Read and preserve results

```powershell
ai-orchestrator runs list
ai-orchestrator runs show RUN_ID
ai-orchestrator runs events RUN_ID
```

Replace `RUN_ID` with the identifier from the listing. `result.json` is a structured outcome; `events.jsonl` records events one per line. `PASS` means verified success for that check, `FAIL` means failure, `SKIP` means it did not run, and `UNKNOWN` means evidence is missing. A local task without configured tests can complete with `tests: SKIP`. Required GitHub test/review gates accept only `PASS`.

Changed worktrees are preserved when changes have not been committed. Open the reported `worktree` directory, run `git status` and `git diff`, and inspect new files as well: Git diff alone omits untracked contents. Add the intended files and commit them after review. You can then review and integrate that branch into your main development branch using your usual Git workflow.

## Set a budget

```powershell
ai-orchestrator run --mode codex --max-seconds 900 --max-processes 4 --task "Fix this small bug"
```

This caps worker/test execution at 15 minutes and four process launches, including retry attempts. Preparation and Git operations have their own timeouts and can add elapsed time. Commands executed internally by a model are not individual counted launches. Defaults: 3600 seconds and 20 launches. TEAM's `--max-fix-rounds` is a separate inner-loop limit, default 2.

These are **not currency limits**. CLI billing is often unavailable; `costUsd: null` means unknown, not free. Use provider account controls for financial limits.

## Optional memory

From your target project:

```powershell
ai-orchestrator memory add --text "Use npm test for login tests" --days 90
ai-orchestrator memory list
ai-orchestrator memory search --text "login tests"
ai-orchestrator run --mode codex --memory --task "Improve login tests"
ai-orchestrator memory remove NOTE_ID
```

Notes are scoped to this repository path. They are sent to a worker only when `--memory` is present, using bounded lexical retrieval. Default retrieval expiry is 90 days; expired files remain until explicitly removed. Model output does not automatically become memory.

## Optional local queue

```powershell
ai-orchestrator queue add --mode codex --task "Add validation tests"
ai-orchestrator queue list
ai-orchestrator queue run --limit 1
ai-orchestrator queue cancel JOB_ID
```

Adding a job is inert. Running a queue processes a bounded batch sequentially in the foreground. Keep that terminal open. Task-file contents are copied at enqueue time; user defaults are resolved when the job runs. Each job creates an independent worktree: output from one job is not automatically integrated into the next. For dependent tasks, integrate the reviewed previous result first.

Interrupted jobs are not replayed automatically. Inspect their output before creating a replacement. `queue recover JOB_ID` marks an interrupted RUNNING job as INTERRUPTED after the worker has stopped and its lock has been handled. See [crash recovery](LOCAL-MODULES.md#crash-recovery).

## Optional measured routing

```powershell
ai-orchestrator routing stats
ai-orchestrator routing recommend --text "Fix validation bug"
ai-orchestrator run --mode auto --routing learned --task "Fix validation bug"
```

This compares measured history; it is not neural training. A candidate needs at least five test-verified outcomes in the same repository and task class, and at least 80% success. Explicit worker/model selections win. Read-only analysis and high-risk TEAM classifications keep their route. Insufficient data uses the existing heuristic.

## Optional GitHub automation

Leave `.github/ai-orchestrator.yml` with `automation.enabled: false` and `automation.mode: manual` if you only want local commands. That YAML mode controls Issue automation; the `run --mode` flag selects a worker.

To enable Issue → implementation → PR → CI, follow [automation setup](AUTOMATION.md) and the [first live test guide](GITHUB-LIVE-TEST.md). Use an authenticated GitHub account, a dedicated Windows runner, target-repository configuration and workflows. From the **matching repository checkout**:

```powershell
ai-orchestrator github doctor --repo OWNER/REPO
ai-orchestrator github issue inspect --repo OWNER/REPO --issue 42
ai-orchestrator github issue run --repo OWNER/REPO --issue 42 --dry-run
```

`OWNER/REPO` is a GitHub slug, not a filesystem path. A trusted actor must apply `ai-auto`. Removing `--dry-run` starts real work and can push a branch and create a PR. Required AI review needs TEAM; a solo Codex run does not produce a Gemini review. The final gate is `READY_FOR_HUMAN_MERGE`. Merge and publication remain manual.

## Common problems

| Symptom | Next step |
| --- | --- |
| Command not found | Reopen PowerShell and rerun the installer |
| Dirty source repository | Inspect `git status`; preserve your changes with your normal Git workflow |
| Model unavailable | `models refresh`, then choose an available model or explicit `--model auto` |
| `tests: SKIP` | Configure an actual project test command; see the technical reference |
| Origin mismatch | Run GitHub commands from the target repository checkout |
| Lock held | Another worker is active or a prior worker crashed; do not remove a live lock |
| Budget exhausted | Inspect retained work before choosing a budget for another run |

Runtime records live under `%LOCALAPPDATA%\MultiModelAIOrchestrator`; settings live under `%APPDATA%\MultiModelAIOrchestrator`. Logs contain task text and model output and can include private project data. Keep runtime folders out of Git. More detail: [troubleshooting](TROUBLESHOOTING.md), [configuration](CONFIGURATION.md), [local module contracts](LOCAL-MODULES.md).
