$ErrorActionPreference = 'Stop'
$OrchestratorRoot = Split-Path -Parent $PSScriptRoot
$Cli = Join-Path $OrchestratorRoot 'bin\ai-orchestrator.mjs'
if (Get-Command ai-orchestrator -ErrorAction SilentlyContinue) {
  & ai-orchestrator install-skills
} else {
  & node -- $Cli install-skills
}
exit $LASTEXITCODE
