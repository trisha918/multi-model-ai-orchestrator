# Configuration

For beginner examples and independent local modules, see [START-HERE.md](START-HERE.md) / [راهنمای فارسی](START-HERE-FA.md).

Local run controls are CLI flags: `--max-seconds 3600`, `--max-processes 20`, `--memory` (off by default), and `--routing heuristic|learned` (heuristic by default). These flags do not enable GitHub automation and are not user-config keys. Unknown flags and invalid numeric budgets fail before worker launch. Explicit `--model auto` takes precedence over a configured manual model. Stale model catalogs are refreshed rather than silently treated as current availability.

## Precedence

Highest first:

1. CLI argument
2. Environment variable
3. User config (`%APPDATA%\MultiModelAIOrchestrator\config.json`)
4. Smart auto selection
5. Built-in default

Repository `.github/ai-orchestrator.yml` is **not** a substitute for worker model defaults. It only controls optional GitHub Issue automation. Invalid repo YAML fails closed (automation stays off).

## Global / user config

See the README. Keys include `defaultMode`, `cursorModel`, `codexModel`, `geminiModel`, team models, worktree keep flags, `workerMaxRetries`.

Timeouts: `AI_CURSOR_TIMEOUT_MS`, `AI_CODEX_TIMEOUT_MS`, `AI_GEMINI_TIMEOUT_MS`, `AI_TEST_TIMEOUT_MS`.

## GitHub YAML

```yaml
automation:
  enabled: true
  mode: assisted
  trigger_label: ai-auto
  max_fix_attempts: 5
  allowed_actors:
    - optional-extra-user

pull_request:
  create: true
  auto_merge: false

tests:
  required: true

review:
  required: true

publish:
  enabled: false
```

- `enabled: false` or `mode: manual` → no Issue automation.
- `max_fix_attempts` is 1–5 (default 5).
- `auto_merge: true` and `publish.enabled: true` are **errors** in v1.1.
- `allowed_actors` is extra GitHub logins that may apply `ai-auto` even if association metadata is incomplete. Prefer OWNER/MEMBER/COLLABORATOR.

## Routing labels

Documented in [MODELS.md](MODELS.md). GitHub labels override worker/model the same way skills do; they never override the security gate.

## Environment for GitHub

| Variable | Purpose |
| --- | --- |
| `GITHUB_TOKEN` / `GH_TOKEN` | API auth when `gh` is not used |
| `AI_ORCHESTRATOR_RUNTIME_ROOT` | Where automation state is stored |

Do not log these values.
