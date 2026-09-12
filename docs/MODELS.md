# Models and routing

v1.0/v1.1 share one routing system. Cursor skills, CLI flags, and GitHub labels all map onto it.

## Cursor skills

| Command | Worker | Model |
| --- | --- | --- |
| `/ai` | AUTO worker | AUTO model |
| `/ai-team` | TEAM | AUTO per-stage models |
| `/ai-cursor` | CURSOR | smart Cursor model |
| `/ai-codex` | CODEX | smart Codex model |
| `/ai-codex-sol` | CODEX | manual Sol |
| `/ai-gemini` | GEMINI | smart Gemini model |
| `/ai-gemini-pro-high` | GEMINI | manual Pro High |
| `/ai-models` | (none) | Show detected models |

Also installed when the registry can resolve them: `/ai-codex-luna`, `/ai-codex-terra`, Codex/Gemini profile skills, and Gemini flash/pro aliases.

## CLI

```powershell
ai-orchestrator run --mode auto --task-file $taskFile
ai-orchestrator run --mode team --commit-on-pass --task-file $taskFile
ai-orchestrator run --mode cursor --task-file $taskFile
ai-orchestrator run --mode codex --model auto --task-file $taskFile
ai-orchestrator run --mode codex --model sol --task-file $taskFile
ai-orchestrator run --mode gemini --model pro-high --task-file $taskFile
```

Manual `--model` / `--model-id` never silently falls back. Automatic selection may fall back across capability tiers and logs Preferred / Resolved / Reason.

## GitHub labels

`ai-auto` alone → worker AUTO + model AUTO.

| Extra label | Worker | Model |
| --- | --- | --- |
| `ai-team` | TEAM | AUTO |
| `ai-cursor` | CURSOR | smart |
| `ai-codex` | CODEX | smart |
| `ai-gemini` | GEMINI | smart |
| `ai-codex-sol` | CODEX | manual Sol |
| `ai-codex-terra` | CODEX | manual Terra |
| `ai-codex-luna` | CODEX | manual Luna |
| `ai-gemini-flash-high` | GEMINI | manual Flash High |
| `ai-gemini-flash-medium` | GEMINI | manual Flash Medium |
| `ai-gemini-flash-low` | GEMINI | manual Flash Low |
| `ai-gemini-pro-high` | GEMINI | manual Pro High |
| `ai-gemini-pro-low` | GEMINI | manual Pro Low |

Conflicting route or model labels stop automation and set `ai-human-review`.

Issue title/body cannot override worker/model policy. Only labels plus orchestrator config do.
