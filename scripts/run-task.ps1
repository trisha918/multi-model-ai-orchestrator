param(
  [Parameter(Mandatory=$true)][string]$Task,
  [ValidateSet('auto','cursor','codex','gemini','agy','team')][string]$Mode = 'auto',
  [string]$Repo = '',
  [string]$CursorModel = 'auto',
  [switch]$CommitOnPass
)

$ErrorActionPreference = 'Stop'

# Detect the opened project (current working directory), never default to the orchestrator install path.
if ([string]::IsNullOrWhiteSpace($Repo)) {
  $Repo = (& git rev-parse --show-toplevel 2>$null)
  if ($Repo) { $Repo = $Repo.Trim() }
  if ([string]::IsNullOrWhiteSpace($Repo)) {
    throw 'Current folder is not inside a Git repository. Open the project repo in Cursor and retry.'
  }
}

$Inbox = Join-Path $env:TEMP 'MultiModelAIOrchestrator\task-inbox'
New-Item -ItemType Directory -Path $Inbox -Force | Out-Null
$TaskFile = Join-Path $Inbox ('task-' + [guid]::NewGuid().ToString('n') + '.txt')
$Utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($TaskFile, $Task, $Utf8)

$runArgs = @('run', '--repo', $Repo, '--mode', $Mode, '--cursor-model', $CursorModel, '--task-file', $TaskFile)
if ($CommitOnPass) { $runArgs += '--commit-on-pass' }

try {
  if (Get-Command ai-orchestrator -ErrorAction SilentlyContinue) {
    & ai-orchestrator @runArgs
    exit $LASTEXITCODE
  }

  $OrchestratorRoot = Split-Path -Parent $PSScriptRoot
  $Cli = Join-Path $OrchestratorRoot 'bin\ai-orchestrator.mjs'
  $nodeArgs = @($Cli) + $runArgs
  & node -- @nodeArgs
  exit $LASTEXITCODE
} finally {
  if (Test-Path -LiteralPath $TaskFile) {
    Remove-Item -LiteralPath $TaskFile -Force -ErrorAction SilentlyContinue
  }
}
