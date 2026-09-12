# Private live-test project

Copy this folder into a **new private** GitHub repository named `ai-orchestrator-e2e-test`.

Do not use the public Multi-Model AI Orchestrator product repository for the first live Issue automation test.

## What this is

A tiny CommonJS calculator (`add`, `subtract`) whose `npm test` already passes. The first live Issue should add `multiply` without breaking these functions.

## Setup

Follow [docs/GITHUB-LIVE-TEST.md](../../docs/GITHUB-LIVE-TEST.md).

GitHub Actions:

- `ci.yml` runs on GitHub-hosted `windows-latest` for pull requests and pushes (ordinary tests).
- `ai-issue.yml` starts AI work only after a hosted authorization job, then only on `[self-hosted, Windows, ai-orchestrator]`.
