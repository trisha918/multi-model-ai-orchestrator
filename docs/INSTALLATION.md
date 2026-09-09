# Installation

First-time Windows setup for Multi-Model AI Orchestrator **v1.1.0**.

## 1. Clone and install

```powershell
git clone https://github.com/trisha918/multi-model-ai-orchestrator.git
cd multi-model-ai-orchestrator
.\install.ps1
```

If execution policy blocks the script:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer does not install Node, Git, Cursor Agent, Codex, or Antigravity. It links the global `ai-orchestrator` CLI and may add `%APPDATA%\npm` to the **user** PATH.

## 2. Doctor

```powershell
ai-orchestrator doctor
```

Expect checks for Node 20+, npm, Git, Cursor Agent, Codex, Antigravity, authentication, skills, and model discovery.

GitHub automation is **optional**. Doctor reports GitHub CLI/API as OK or ACTION REQUIRED and must not fail solely because GitHub is unconfigured.

## 3. Models

```powershell
ai-orchestrator models
ai-orchestrator models refresh
```

See [MODELS.md](MODELS.md).

## 4. GitHub authentication (optional)

Preferred:

```powershell
gh auth login
gh auth status
```

Alternatively set `GITHUB_TOKEN` or `GH_TOKEN` in the environment of the runner or shell. Do not put tokens in `.github/ai-orchestrator.yml`, `config.json`, or git.

Doctor prints that a token is present without showing the value.

## 5. Self-hosted Windows runner (optional, Issue-triggered AI)

Recommended architecture:

```text
GitHub → GitHub Actions → self-hosted Windows runner → ai-orchestrator → Cursor / Codex / Gemini
```

The runner machine must already have:

- Git
- Node.js 20+
- `ai-orchestrator` on PATH
- Cursor Agent CLI (authenticated)
- Codex CLI (authenticated)
- Antigravity / `agy` (authenticated)
- GitHub CLI or `GITHUB_TOKEN` from Actions

Cursor IDE does not need to be open.

Register a runner **yourself** in the GitHub UI of a **private** test repository. Label it `self-hosted`, `Windows`, and `ai-orchestrator`. Do not paste registration tokens into this repository.

Then inspect the machine (no registration, no login changes):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-ai-runner.ps1
```

```powershell
ai-orchestrator github doctor
ai-orchestrator github doctor --repo OWNER/ai-orchestrator-e2e-test
```

First live Issue test: [GITHUB-LIVE-TEST.md](GITHUB-LIVE-TEST.md).

**Do not** attach this runner to a generic `pull_request` workflow that checks out untrusted fork code.

## 6. Repository config

Copy and edit `.github/ai-orchestrator.yml`. Default in this product repo is **disabled / manual**. Issue automation requires `automation.enabled: true` and `mode: assisted` (or `autonomous`, which still will not merge in v1.1).

Invalid YAML fails closed and does not enable automation.

## 7. Labels

```powershell
ai-orchestrator github labels setup --repo owner/name
ai-orchestrator github labels setup --repo owner/name --dry-run
```

## 8. Test Issue

1. Open an Issue with [.github/ISSUE_TEMPLATE/ai-task.yml](../.github/ISSUE_TEMPLATE/ai-task.yml).
2. Confirm nothing runs.
3. As OWNER/MEMBER/COLLABORATOR, add `ai-auto`.
4. Confirm `ai-orchestrator github status --repo owner/name --issue N`.

Use `--dry-run` before the first live `github issue run`.
