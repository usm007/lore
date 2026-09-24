#Requires -Version 5.1
<#
.SYNOPSIS
  Project-knowledge staleness report (PS 5.1-compatible, read-only, language-agnostic).
.DESCRIPTION
  Reports knowledge-base age, tracked-vs-actual drift (without rewriting the
  manifest), git working-tree changes, and low-confidence areas from knowledge.json.
  Customize the attention section per repo. Run: powershell -File .project/status.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $PSScriptRoot 'state'
$manifestPath = Join-Path $stateDir 'manifest.json'

Write-Output '=== project-knowledge status ==='
$docs = Get-ChildItem -Path $PSScriptRoot -Filter '*.md' -ErrorAction SilentlyContinue | Sort-Object Name
if ($docs.Count -eq 0) { Write-Output 'MISSING: no .project/*.md docs found.' }
else {
  $newest = ($docs | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
  $oldest = ($docs | Sort-Object LastWriteTime | Select-Object -First 1).LastWriteTime
  Write-Output ("knowledge docs: {0} files, oldest={1}, newest={2}" -f $docs.Count, $oldest, $newest)
  try {
    $kj = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'knowledge.json') -Raw | ConvertFrom-Json
    Write-Output ("knowledge.json: valid JSON, version={0}" -f $kj.version)
    $low = @()
    foreach ($prop in $kj.modules.PSObject.Properties) {
      if ($prop.Value.confidence -and $prop.Value.confidence -ne 'high') {
        $low += "$($prop.Name) ($($prop.Value.confidence))"
      }
    }
    if ($low.Count -gt 0) { Write-Output ("low-confidence modules: {0}" -f ($low -join ', ')) }
  } catch { Write-Output 'knowledge.json: INVALID or unreadable!' }
}

if (Test-Path -LiteralPath $manifestPath) {
  $age = (Get-Date) - (Get-Item -LiteralPath $manifestPath).LastWriteTime
  Write-Output ("manifest: age={0:N1}h ({1})" -f $age.TotalHours, (Get-Item -LiteralPath $manifestPath).LastWriteTime)
  Write-Output '--- drift since manifest (read-only) ---'
  & (Join-Path $PSScriptRoot 'refresh.ps1')
} else {
  Write-Output 'manifest: MISSING — run powershell -File .project/refresh.ps1 -Update'
}

$stalePath = Join-Path $stateDir 'stale.json'
if (Test-Path -LiteralPath $stalePath) {
  try {
    $stale = Get-Content -LiteralPath $stalePath -Raw | ConvertFrom-Json
    if ($stale.affected -and $stale.affected.Count -gt 0) {
      Write-Output ("marked stale (auto-detected): {0}" -f ($stale.affected -join '; '))
    }
  } catch { Write-Output 'stale.json unreadable.' }
}

Write-Output '--- git working tree ---'
try {
  $git = & git -C $root status --short --branch 2>&1
  Write-Output ($git -join "`n")
} catch { Write-Output 'git unavailable.' }
