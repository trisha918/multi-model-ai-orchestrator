#!/usr/bin/env pwsh
# Splatted Windows shim. npm's default *.ps1 passes $args without @ and
# collapses `ai-orchestrator run --repo ...` into a single argument.
$basedir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$mjs = Join-Path $basedir 'node_modules\multi-model-ai-orchestrator\bin\ai-orchestrator.mjs'
$node = Join-Path $basedir 'node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = 'node' }
& $node $mjs @args
exit $LASTEXITCODE
