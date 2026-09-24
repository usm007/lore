#Requires -Version 5.1
<#
.SYNOPSIS
  Incremental project-knowledge refresh (PS 5.1-compatible, language-agnostic template).
.DESCRIPTION
  Stage 1-2 of the pipeline: snapshot repo structure + detect changes vs.
  .project/state/manifest.json, map them to affected knowledge areas, and report
  which knowledge files need targeted re-analysis. Never rewrites knowledge docs.
  Customize Get-AffectedModules for this repo's subsystems (see .project/modules.md).
  Run: powershell -File .project/refresh.ps1 [-Update]
#>
[CmdletBinding()]
param([switch]$Update)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $PSScriptRoot 'state'
$manifestPath = Join-Path $stateDir 'manifest.json'

# Language-agnostic source/config tracking. Trim per repo if noisy.
$includeExt = @(
  '.py', '.pyi', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue',
  '.cs', '.fs', '.vb', '.xaml', '.java', '.kt', '.kts', '.go', '.rs',
  '.php', '.rb', '.c', '.h', '.hpp', '.cpp', '.cc', '.swift', '.dart',
  '.csproj', '.fsproj', '.sln', '.props', '.targets', '.json', '.yaml', '.yml',
  '.toml', '.ini', '.gradle', '.xml', '.html', '.css', '.scss', '.sql',
  '.ps1', '.sh', '.bat', '.cmd', '.iss', '.manifest', '.dockerfile', 'Dockerfile'
)
$excludeRe = '(^|\\)(bin|obj|out|build|dist|target|publish|releases|staging|output|__pycache__|\.venv|venv|\.tox|\.git|\.hg|\.svn|\.vs|\.idea|\.vscode|node_modules|\.next|\.nuxt|coverage|\.coverage|\.project)\\|^docs\\'
# NOTE: extensionless Dockerfiles/Makefiles are tracked by name below.

$allFiles = Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue |
  Sort-Object FullName

$files = foreach ($f in $allFiles) {
  $rel = $f.FullName.Substring($root.Length + 1)
  $byExt = $includeExt -contains $f.Extension
  $byName = @('Dockerfile', 'Makefile', 'Gemfile', 'Rakefile') -contains $f.Name
  if (($byExt -or $byName) -and ($rel -notmatch $excludeRe)) { $f }
}

$entries = foreach ($f in $files) {
  $rel = $f.FullName.Substring($root.Length + 1)
  $h = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
  [pscustomobject]@{ path = $rel; sha256 = $h; bytes = $f.Length }
}

$old = @{}
if (Test-Path -LiteralPath $manifestPath) {
  $m = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  foreach ($e in $m.files) { $old[$e.path] = $e.sha256 }
}

$new = @{}
foreach ($e in $entries) { $new[$e.path] = $e.sha256 }

$added = @($entries | Where-Object { -not $old.ContainsKey($_.path) } | ForEach-Object { $_.path })
$deleted = @($old.Keys | Where-Object { -not $new.ContainsKey($_) } | Sort-Object)
$changed = @($entries | Where-Object { $old.ContainsKey($_.path) -and $old[$_.path] -ne $_.sha256 } | ForEach-Object { $_.path })

function Get-AffectedModules($paths) {
  # GENERIC mapping — replace with this repo's subsystem map (.project/modules.md).
  $mods = New-Object System.Collections.Generic.HashSet[string]
  foreach ($p in $paths) {
    if ($p -match '(?i)(^|/|\\)(test|tests|spec|__tests__|e2e)(/|\\|$)') { [void]$mods.Add('tests -> .project/test-map.md') }
    elseif ($p -match '(?i)(package\.json|requirements.*|pyproject\.toml|go\.mod|Cargo\.toml|composer\.json|pom\.xml|build\.gradle.*|\.csproj|Gemfile)$') { [void]$mods.Add('dependencies -> .project/dependencies.md, overview.md, knowledge.json') }
    elseif ($p -match '(?i)(Dockerfile|docker-compose.*|\.github/|azure-pipelines.*|Jenkinsfile)$') { [void]$mods.Add('ci-config -> .project/test-map.md, overview.md') }
    elseif ($p -match '(?i)(^|/|\\)(src|lib|pkg|app|cmd|internal)/') { [void]$mods.Add('source-tree -> .project/modules.md, data-flow.md') }
    else { [void]$mods.Add('other -> verify scope manually') }
  }
  return @($mods | Sort-Object)
}

$affected = Get-AffectedModules($added + $changed + $deleted)

Write-Output "project-knowledge refresh: $($entries.Count) tracked files"
Write-Output "added=$($added.Count) changed=$($changed.Count) deleted=$($deleted.Count)"
if ($added.Count -gt 0) { Write-Output '--- added ---'; $added | ForEach-Object { Write-Output "  + $_" } }
if ($changed.Count -gt 0) { Write-Output '--- changed ---'; $changed | ForEach-Object { Write-Output "  ~ $_" } }
if ($deleted.Count -gt 0) { Write-Output '--- deleted ---'; $deleted | ForEach-Object { Write-Output "  - $_" } }
if ($affected.Count -gt 0 -and ($added.Count + $changed.Count + $deleted.Count) -gt 0) {
  Write-Output '--- affected modules (targeted re-analysis) ---'
  $affected | ForEach-Object { Write-Output "  * $_" }
} else {
  Write-Output 'no drift: knowledge base is current.'
}

if ($Update -or -not (Test-Path -LiteralPath $manifestPath)) {
  if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir | Out-Null }
  $manifest = [pscustomobject]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    root = $root
    files = $entries
  }
  $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  Write-Output "manifest written: .project/state/manifest.json ($($entries.Count) files)"
}
