# Contributing

This repository is the Multi-Model AI Orchestrator. Windows is the validated platform.

## Workflow

1. Fork and create a branch from `main`.
2. Make focused changes. Do not redesign the orchestrator unless that is the task.
3. Run `npm test` locally. Syntax-check with `node --check` on `src/*.mjs` and `bin/*.mjs`.
4. Open a pull request against `main`. Describe why the change is needed.

CI on GitHub Actions runs the Node test suite on Windows. It does not authenticate to Cursor, Codex, or Antigravity.

## Must preserve

- Windows-safe spawning: argument arrays, `shell: false`, wrap `.cmd` via `cmd.exe /d /s /c`.
- Task transport: Cursor skills pass task text via `--task-file` (UTF-8 without BOM), never `--task` through PowerShell quoting.
- Workspace isolation: isolated worktrees, explicit cwd, no inherited process cwd for workers.
- `--trust` only for verified orchestrator worktrees. Do not add global `--yolo`.
- Manual model selection must never silently fall back.

## Do not commit

- `runs/`, `worktrees/`
- `.env`, `.env.*`, credentials, tokens, session files
- `models-cache.json`, logs, temporary task inbox files
- Personal absolute machine paths in source or docs

## Pull requests

- Keep PRs reviewable.
- Do not push, merge, or deploy from the orchestrator itself.
- Do not move or rewrite release tags.
- The orchestrator must not automatically merge to `main` or push to remotes as part of a user task.
