# Remove only this project's global CLI link and owned Cursor skills.
# Does not uninstall Cursor, Codex, Antigravity, Node, or Git.
# Does not delete user project repositories.
# Does not delete config/runtime data unless -PurgeData is passed.

[CmdletBinding()]
param(
  [switch]$PurgeData
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $PSVersionTable -or -not $PSVersionTable.PSVersion) {
  Write-Error 'This uninstaller must run in Windows PowerShell or PowerShell 7.'
  exit 1
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$CliJs = Join-Path $Root 'bin\ai-orchestrator.mjs'

function Test-CommandName([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

Write-Host 'Multi-Model AI Orchestrator uninstaller'
Write-Host 'This will remove only:'
Write-Host '  - global ai-orchestrator npm link'
Write-Host '  - project-owned /ai and /ai-team Cursor skills'
Write-Host ''

Write-Host 'Uninstalling owned Cursor skills...'
if (Test-Path -LiteralPath $CliJs) {
  & node -- $CliJs uninstall-skills
} elseif (Test-CommandName 'ai-orchestrator') {
  ai-orchestrator uninstall-skills
} else {
  Write-Host 'CLI not found; skipping skill uninstall via CLI.'
}

Write-Host ''
Write-Host 'Unlinking global ai-orchestrator...'
if (Test-CommandName 'npm') {
  Push-Location -LiteralPath $Root
  try {
    npm unlink -g multi-model-ai-orchestrator
  } finally {
    Pop-Location
  }
} else {
  Write-Host 'npm not found; skip npm unlink.'
}

$ConfigDir = Join-Path $env:APPDATA 'MultiModelAIOrchestrator'
$RuntimeDir = Join-Path $env:LOCALAPPDATA 'MultiModelAIOrchestrator'

if ($PurgeData) {
  foreach ($Dir in @($ConfigDir, $RuntimeDir)) {
    $leaf = Split-Path -Leaf $Dir
    if ($leaf -ne 'MultiModelAIOrchestrator') {
      Write-Host "Refusing to purge unexpected directory: $Dir"
      continue
    }
    if (Test-Path -LiteralPath $Dir) {
      Write-Host "Purging $Dir"
      Remove-Item -LiteralPath $Dir -Recurse -Force
    }
  }
} else {
  Write-Host ''
  Write-Host 'Config and runtime data were kept:'
  if (Test-Path -LiteralPath $ConfigDir) { Write-Host "  Config : $ConfigDir" } else { Write-Host "  Config : (none) $ConfigDir" }
  if (Test-Path -LiteralPath $RuntimeDir) { Write-Host "  Runtime: $RuntimeDir" } else { Write-Host "  Runtime: (none) $RuntimeDir" }
  Write-Host 'To delete those folders as well, re-run: .\uninstall.ps1 -PurgeData'
}

Write-Host ''
Write-Host 'Uninstall complete. Third-party tools (Cursor, Codex, Antigravity, Node, Git) were not removed.'
exit 0
