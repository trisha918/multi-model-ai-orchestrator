# Inspect-only check that this Windows machine can host GitHub AI automation.
# Does not install tools, does not log in, does not register a runner, does not print tokens.

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

function Test-CommandName([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Quiet([string]$File, [string[]]$ArgumentList) {
  try {
    $out = & $File @ArgumentList 2>&1 | Out-String
    return @{
      ok = ($LASTEXITCODE -eq 0)
      text = [string]$out
    }
  } catch {
    return @{ ok = $false; text = [string]$_.Exception.Message }
  }
}

function Resolve-NpmGlobalCmd([string]$Name) {
  $cmd = Join-Path $env:APPDATA "npm\$Name.cmd"
  if (Test-Path -LiteralPath $cmd) { return $cmd }
  return ''
}

function Resolve-Tool([string]$Name) {
  if (Test-CommandName $Name) { return $Name }
  $npmCmd = Resolve-NpmGlobalCmd $Name
  if ($npmCmd) { return $npmCmd }
  return ''
}

function Get-CursorAgentCmd {
  $root = Join-Path $env:LOCALAPPDATA 'cursor-agent'
  $direct = @(
    (Join-Path $root 'agent.cmd'),
    (Join-Path $root 'cursor-agent.cmd')
  )
  foreach ($p in $direct) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  $versions = Join-Path $root 'versions'
  if (Test-Path -LiteralPath $versions) {
    $dirs = Get-ChildItem -LiteralPath $versions -Directory | Sort-Object Name -Descending
    foreach ($d in $dirs) {
      $cmd = Join-Path $d.FullName 'cursor-agent.cmd'
      if (Test-Path -LiteralPath $cmd) { return $cmd }
    }
  }
  return ''
}

$fail = $false
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('AI RUNNER READINESS')
$lines.Add('')

# Git
if (Test-CommandName 'git') {
  $g = Invoke-Quiet 'git' @('--version')
  $lines.Add('Git             OK')
} else {
  $lines.Add('Git             MISSING')
  $fail = $true
}

# Node
if (Test-CommandName 'node') {
  $nv = (& node -v).Trim()
  $lines.Add("Node            OK $nv")
} else {
  $lines.Add('Node            MISSING')
  $fail = $true
}

# npm
if (Test-CommandName 'npm') {
  $lines.Add("npm             OK $((& npm -v).Trim())")
} else {
  $lines.Add('npm             MISSING')
  $fail = $true
}

# Orchestrator
$orch = Resolve-Tool 'ai-orchestrator'
$orchVer = ''
if ($orch) {
  $v = Invoke-Quiet $orch @('version')
  $orchVer = ($v.text -split "`r?`n" | Select-Object -First 1).Trim()
  if ($v.ok -and $orchVer) {
    $lines.Add("Orchestrator    OK $orchVer")
  } else {
    $lines.Add('Orchestrator    ERR (ai-orchestrator found but version failed)')
    $fail = $true
  }
} else {
  $lines.Add('Orchestrator    MISSING (run .\\install.ps1 in the clone, then open a new terminal)')
  $fail = $true
}

# Cursor
$agent = Get-CursorAgentCmd
if ($agent) {
  $st = Invoke-Quiet $agent @('status')
  $blob = $st.text
  if ($blob -match 'logged in') {
    $lines.Add('Cursor Agent    OK AUTHENTICATED')
  } else {
    $lines.Add('Cursor Agent    ACTION REQUIRED (run the resolved agent.cmd login)')
    $fail = $true
  }
} else {
  $lines.Add('Cursor Agent    MISSING')
  $fail = $true
}

# Codex
$codex = Resolve-Tool 'codex'
if ($codex) {
  $st = Invoke-Quiet $codex @('login','status')
  if ($st.text -match 'logged in') {
    $lines.Add('Codex           OK AUTHENTICATED')
  } else {
    $lines.Add('Codex           ACTION REQUIRED (run: codex login)')
    $fail = $true
  }
} else {
  $lines.Add('Codex           MISSING')
  $fail = $true
}

# Antigravity / Gemini
$agy = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
if (Test-Path -LiteralPath $agy) {
  $st = Invoke-Quiet $agy @('models')
  if ($st.ok -and ($st.text -match 'gemini|claude|gpt|model')) {
    $lines.Add('Gemini          OK AUTHENTICATED')
  } else {
    $lines.Add('Gemini          ACTION REQUIRED (sign in to Antigravity, then agy models)')
    $fail = $true
  }
} elseif (Test-CommandName 'agy') {
  $st = Invoke-Quiet 'agy' @('models')
  if ($st.ok) {
    $lines.Add('Gemini          OK AUTHENTICATED')
  } else {
    $lines.Add('Gemini          ACTION REQUIRED')
    $fail = $true
  }
} else {
  $lines.Add('Gemini          MISSING')
  $fail = $true
}

$lines.Add('')
$runnerHint = 'MANUAL CHECK REQUIRED'
$svc = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'actions.runner.*' }
if ($svc) {
  $names = ($svc | ForEach-Object { $_.Name + ' (' + $_.Status + ')' }) -join ', '
  $runnerHint = "Windows service detected: $names (confirm GitHub labels include ai-orchestrator)"
} elseif (Test-Path -LiteralPath (Join-Path $env:USERPROFILE 'actions-runner')) {
  $runnerHint = 'Folder %USERPROFILE%\actions-runner exists (confirm it is online and labeled ai-orchestrator)'
}
$lines.Add('GitHub Runner:')
$lines.Add($runnerHint)
$lines.Add('')

if ($orch) {
  $lines.Add('--- ai-orchestrator version ---')
  $lines.Add(((Invoke-Quiet $orch @('version')).text).Trim())
  $lines.Add('')
  $lines.Add('--- ai-orchestrator models ---')
  $modelText = (Invoke-Quiet $orch @('models')).text
  if ($modelText.Length -gt 4000) {
    $lines.Add($modelText.Substring(0, 4000))
    $lines.Add('... (truncated)')
  } else {
    $lines.Add($modelText.Trim())
  }
  $lines.Add('')
}

$lines.Add('READY FOR GITHUB AI AUTOMATION:')
if ($fail) { $lines.Add('NO') } else { $lines.Add('YES') }
$lines.Add('')
$lines.Add('This script does not register a runner and does not modify authentication.')

Write-Host ($lines -join [Environment]::NewLine)
if ($fail) { exit 1 }
exit 0
