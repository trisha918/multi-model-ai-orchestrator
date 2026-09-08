$ErrorActionPreference = 'Stop'
$OrchestratorRoot = Split-Path -Parent $PSScriptRoot
$SkillRoot = Join-Path $env:USERPROFILE '.cursor\skills'

function Install-Skill([string]$Name, [string]$Mode, [string]$Description) {
  $Dir = Join-Path $SkillRoot $Name
  New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  $Runner = Join-Path $OrchestratorRoot 'scripts\run-task.ps1'
  $Content = @"
---
name: $Name
description: $Description
disable-model-invocation: true
---
# $Name

Use this skill only when the user explicitly invokes /$Name.

## Procedure
1. Treat the text in the same user message after /$Name as the task. If there is no task text, ask for it.
2. Do not implement the task yourself. Delegate it to the local multi-model orchestrator.
3. Run the following PowerShell script from the current project workspace, passing the user's task verbatim as `-Task`:

`& '$Runner' -Mode '$Mode' -CommitOnPass -Task '<USER TASK>'`

4. The runner auto-detects the current Git repository. Do not add `--in-place` and do not bypass Git isolation.
5. Wait for the process to finish. Then report the Route banner (CURSOR, CODEX, GEMINI, or TEAM), each stage result, branch/worktree, commit hash if any, and run-log path.
6. If the orchestrator refuses because the source repo is dirty, tell the user to commit or stash their current changes; do not clean or discard files automatically.
7. The source repo is the Git root of the currently opened Cursor workspace. Do not switch the task onto the orchestrator install path unless that is the opened workspace.
8. Pass the user's task text verbatim to -Task. Do not rewrite, summarize, or interpolate it into a shell command string.
"@
  $SkillPath = Join-Path $Dir 'SKILL.md'
  $Utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($SkillPath, $Content.Trim() + "`n", $Utf8)
  Write-Host "Installed /$Name -> $Dir"
}

Install-Skill 'ai' 'auto' 'Run the local multi-model AI orchestrator. It automatically routes work among Cursor Agent models, Codex, and Gemini/Antigravity.'
Install-Skill 'ai-team' 'team' 'Run the multi-agent team workflow: Cursor Agent plans, Codex implements, and Gemini/Antigravity reviews with an auto-fix loop.'

Write-Host ''
Write-Host 'Restart Cursor (or reload the window), then type /ai or /ai-team in Agent chat.'
