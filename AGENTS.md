# AI Orchestrator development rules

This repository is the Multi-Model AI Orchestrator. Keep Windows native support first-class.

- Never require `agent.exe`. Prefer `%LOCALAPPDATA%\cursor-agent\agent.cmd` or the latest `cursor-agent.cmd` under `versions\`. Prefer launching Cursor via `node.exe` + `index.js` so task text is not passed through cmd delayed expansion.
- Prefer Git worktree isolation. Store worktrees and run logs inside this orchestrator project (`worktrees/`, `runs/`).
- Team mode: Cursor plans, Codex implements, independent tests run, Gemini reviews, Codex fixes within a bounded loop.
- Do not push, merge, or deploy automatically.
- User task text must not be interpolated into shell command strings. Spawn with argument arrays; wrap Windows `.cmd` via `cmd.exe /d /s /c` with escaped arguments, never `shell: true`.
- Independent project tests are executed by the orchestrator; do not treat agent claims as verification.
- Do not auto-trust arbitrary directories; `--trust` is only for verified orchestrator worktrees.
- Do not commit `runs/`, `worktrees/`, `.env`, credentials, tokens, or local CLI session files.
- Do not hard-code a developer's personal machine paths into source or documentation intended for other users.
