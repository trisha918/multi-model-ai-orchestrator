param(
  [Parameter(Mandatory=$true)][string]$Task,
  [ValidateSet('auto','cursor','codex','gemini','agy','team')][string]$Mode = 'auto',
  [string]$Repo = '',
  [string]$CursorModel = 'auto',
  [switch]$CommitOnPass
)

$ErrorActionPreference = 'Stop'
$OrchestratorRoot = Split-Path -Parent $PSScriptRoot

# Detect the opened project (current working directory), never default to the orchestrator install path.
if ([string]::IsNullOrWhiteSpace($Repo)) {
  $Repo = (& git rev-parse --show-toplevel 2>$null).Trim()
  if ([string]::IsNullOrWhiteSpace($Repo)) {
    throw 'Current folder is not inside a Git repository. Open the project repo in Cursor and retry.'
  }
}

$argsList = @(
  "$OrchestratorRoot\src\orchestrator.mjs",
  '--repo', $Repo,
  '--mode', $Mode,
  '--cursor-model', $CursorModel,
  '--task', $Task
)
if ($CommitOnPass) { $argsList += '--commit-on-pass' }

& node @argsList
exit $LASTEXITCODE
