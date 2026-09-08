Write-Host "node:" (node -v)
Write-Host "npm :" (npm -v)
Write-Host "git :" (git --version)
Write-Host "codex:" (codex --version)
$agy = Join-Path $env:LOCALAPPDATA "agy\bin\agy.exe"
if (Test-Path $agy) { Write-Host "agy :" (& $agy --version) } else { Write-Host "agy : not found" }
