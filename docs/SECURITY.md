# Security

Development-branch changes and boundaries are documented in [LOCAL-MODULES.md](LOCAL-MODULES.md). Worker/test environments exclude GitHub tokens and arbitrary inherited secrets; known secret values and token patterns are redacted from buffered process output. This does not isolate the Windows account, local credential stores, shared files or project test code. Runtime task/output/history/memory files may contain private project data. Do not publish them without review.

GitHub Issue automation is **optional** and dangerous if misconfigured on a public repository.

## Self-hosted runners

A self-hosted runner is a machine you control, with your Git credentials and **already-authenticated** Cursor, Codex, and Gemini CLIs. Anyone who can execute a workflow on that runner can spend those subscriptions and change files the runner can reach.

**Do not expose a self-hosted AI runner to arbitrary public pull_request execution.** Do not add this runner to a generic `on: pull_request` workflow that checks out fork HEAD and runs `npm test` / `npm install` from untrusted code.

The v1.1 `ai-issue.yml` workflow:

- listens to `issues: labeled` and `workflow_dispatch` only (**not** `pull_request` or `pull_request_target`)
- continues only when the label is `ai-auto`
- runs a **GitHub-hosted** `authorize` job that checks collaborator permission of the label actor **before** any self-hosted AI job
- untrusted actors get `AUTOMATION BLOCKED`; the AI runner is not started
- the AI job runs only on `[self-hosted, Windows, ai-orchestrator]` after `allowed=true`
- checks out the repository **default branch**, not untrusted PR / fork code
- uses `GITHUB_TOKEN` from the workflow only (not printed)
- calls `ai-orchestrator github authorize` then `github issue run` as defense in depth

Attach the first AI runner only to a **private test repository**. Do not attach it broadly to public repos.

## Public repositories

Random users can open Issues and, on many repos, apply some labels. **Never** treat Issue creation as authorization.

Before workers run, v1.1 requires that `ai-auto` was applied by a GitHub actor who is:

- repository OWNER, MEMBER, or COLLABORATOR (permission admin/maintain/write), or
- listed in `automation.allowed_actors`

Authorization uses GitHub metadata/API (label events, collaborator permission). It does **not** trust:

- Issue title
- Issue body
- comments
- PR content
- “ignore previous instructions” text

Failure comment: `AUTOMATION BLOCKED` / `untrusted trigger actor`. No AI workers.

## Prompt injection

Issue text is copied into the task as **requirements** under an explicit policy banner. Orchestration policy, merge rules, and isolation flags must not be taken from that text. Still review AI output: models can be misled.

## Tokens

- Do not store GitHub tokens in source or `ai-orchestrator.yml`.
- Prefer GitHub CLI (`gh auth login`) or Actions `GITHUB_TOKEN` / `GH_TOKEN`.
- Logs redact `ghp_`, `github_pat_`, `Bearer`, and `GITHUB_TOKEN=` style assignments.
- Least privilege for the workflow: `contents: write`, `issues: write`, `pull-requests: write`, `checks: read`, `statuses: read`, `actions: read`. No repo admin. CI aggregation reads both Check Runs and commit statuses.

## Isolation and merge

Implementation still uses isolated worktrees. The product never force-pushes and never pushes `main`. v1.1 does not auto-merge, deploy, or publish even if local tests, GitHub CI, and AI review all pass.

AI-generated code must be reviewed by a human before merge.
