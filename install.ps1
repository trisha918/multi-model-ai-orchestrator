# Multi-Model AI Orchestrator installer (Windows PowerShell).
# Idempotent. Does not install Cursor, Codex, Antigravity, Git, or Node.

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $PSVersionTable -or -not $PSVersionTable.PSVersion) {
  Write-Error 'This installer must run in Windows PowerShell or PowerShell 7.'
  exit 1
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$CliJs = Join-Path $Root 'bin\ai-orchestrator.mjs'
$PackageJson = Join-Path $Root 'package.json'

function Test-CommandName([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Logged([string]$File, [string[]]$ArgumentList, [string]$MissingHint) {
  if (-not (Test-Path -LiteralPath $File) -and -not (Test-CommandName $File)) {
    Write-Host $MissingHint
    return $false
  }
  & $File @ArgumentList
  return ($LASTEXITCODE -eq 0)
}

Write-Host 'Multi-Model AI Orchestrator installer'
Write-Host "Repository: $Root"
Write-Host ''

if (-not (Test-CommandName 'git')) {
  Write-Host 'MISSING Git'
  Write-Host 'Required. Install Git for Windows and reopen the terminal. The installer will not install Git for you.'
  exit 1
}
Write-Host 'Git: OK'

if (-not (Test-CommandName 'node')) {
  Write-Host 'MISSING Node.js'
  Write-Host 'Required. Install Node.js 20+ from https://nodejs.org and reopen the terminal. The installer will not install Node for you.'
  exit 1
}

$NodeVersion = (& node -v).Trim()
$Pkg = Get-Content -LiteralPath $PackageJson -Raw | ConvertFrom-Json
$EngineSpec = [string]$Pkg.engines.node
if (-not $EngineSpec) { $EngineSpec = '>=20' }
$EngineMin = 20
if ($EngineSpec -match '(\d+)') { $EngineMin = [int]$Matches[1] }
$NodeMajor = [int]($NodeVersion.TrimStart('v').Split('.')[0])
if ($NodeMajor -lt [int]$EngineMin) {
  Write-Host "MISSING compatible Node.js (found $NodeVersion, package.json engines.node requires >=$EngineMin)"
  Write-Host 'The installer will not upgrade Node for you.'
  exit 1
}
Write-Host "Node: OK $NodeVersion (engines >=$EngineMin)"

if (-not (Test-CommandName 'npm')) {
  Write-Host 'MISSING npm'
  Write-Host 'npm should ship with Node.js. Confirm npm.cmd is on PATH. The installer will not install npm for you.'
  exit 1
}
Write-Host "npm: OK $((& npm -v).Trim())"

Push-Location -LiteralPath $Root
try {
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules')) -or -not (Test-Path -LiteralPath (Join-Path $Root 'package-lock.json'))) {
    Write-Host ''
    Write-Host 'Installing npm dependencies...'
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
  } else {
    Write-Host ''
    Write-Host 'Installing npm dependencies (idempotent)...'
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
  }

  Write-Host ''
  Write-Host 'Linking global command ai-orchestrator (npm link)...'
  npm link
  if ($LASTEXITCODE -ne 0) { throw 'npm link failed' }

  $NpmPrefix = (& npm prefix -g).Trim()
  if ($NpmPrefix) {
    $ShimSrc = Join-Path $Root 'scripts\windows-ai-orchestrator.ps1'
    $ShimDst = Join-Path $NpmPrefix 'ai-orchestrator.ps1'
    Copy-Item -LiteralPath $ShimSrc -Destination $ShimDst -Force
    Write-Host "Installed argument-safe PowerShell shim: $ShimDst"
  }
} finally {
  Pop-Location
}

$NpmPrefix = (& npm prefix -g).Trim()
$pathParts = @($env:Path -split ';' | ForEach-Object { $_.TrimEnd('\') })
$prefixNorm = $NpmPrefix.TrimEnd('\')
$onPath = $false
foreach ($part in $pathParts) {
  if ($part -and ($part -ieq $prefixNorm)) { $onPath = $true; break }
}
if ($NpmPrefix -and -not $onPath) {
  Write-Host ''
  Write-Host "NOTE: npm global prefix is not on PATH in this session:"
  Write-Host "  $NpmPrefix"
  Write-Host 'Adding it for this installer session. If `ai-orchestrator` is not recognized later, add that folder to your user PATH and open a new terminal.'
  $env:Path = "$NpmPrefix;$env:Path"
}

Write-Host ''
Write-Host 'Verifying ai-orchestrator version...'
$VersionOk = $false
if (Test-CommandName 'ai-orchestrator') {
  ai-orchestrator version
  if ($LASTEXITCODE -eq 0) { $VersionOk = $true }
}
if (-not $VersionOk) {
  & node $CliJs version
  if ($LASTEXITCODE -ne 0) { throw 'ai-orchestrator version failed' }
}

Write-Host ''
Write-Host 'Detecting worker CLIs (not auto-installed)...'
function Show-Tool([string]$Label, [string]$Command) {
  if (Test-CommandName $Command) {
    Write-Host "$Label : present on PATH ($Command)"
    return
  }
  Write-Host "$Label : not on PATH (doctor will report the discovered location if any)"
}
Show-Tool 'Cursor Agent' 'agent'
Show-Tool 'Codex' 'codex'
Show-Tool 'Antigravity' 'agy'

Write-Host ''
Write-Host 'Installing global Cursor skills /ai and /ai-team...'
if (Test-CommandName 'ai-orchestrator') {
  ai-orchestrator install-skills
} else {
  & node $CliJs install-skills
}
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Skill installation reported a problem (foreign existing skills are not overwritten).'
}

Write-Host ''
Write-Host 'Running doctor...'
if (Test-CommandName 'ai-orchestrator') {
  ai-orchestrator doctor
} else {
  & node $CliJs doctor
}

Write-Host ''
Write-Host 'Installer finished. Restart Cursor (or reload the window) so /ai and /ai-team pick up skill changes.'
Write-Host 'Authentication is separate: if doctor printed ACTION REQUIRED, use the listed login command. Credentials are never copied.'
exit 0
