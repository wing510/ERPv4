#Requires -Version 5.1
<#
  ERP v4.1 PROD deploy zip packer (Windows)
  Usage: cd D:\Desktop\ERP\docs
         .\ERPv4.1_PROD-pack.ps1
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$OutZip = ""
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$msg) { Write-Host "[ERP] $msg" -ForegroundColor Cyan }

$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$bundleName = "ERP-v4.1-PROD-deploy"
$guidPart = [guid]::NewGuid().ToString("n")
$stagingRoot = Join-Path $env:TEMP ("erp-prod-pack-" + $guidPart)
$bundleDir = Join-Path $stagingRoot $bundleName

if (-not $OutZip) {
  $OutZip = Join-Path $RepoRoot ($bundleName + "_" + $stamp + ".zip")
}

Write-Step ("Repo: " + $RepoRoot)
Write-Step ("Staging: " + $bundleDir)

New-Item -ItemType Directory -Path $bundleDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bundleDir "server") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bundleDir "web") -Force | Out-Null

$serverSrc = Join-Path $RepoRoot "server"
$serverDst = Join-Path $bundleDir "server"
if (-not (Test-Path $serverSrc)) { throw "server folder not found" }

$serverExclude = @("node_modules", ".env", ".env.local", ".env.production")
Get-ChildItem -Path $serverSrc -Force | Where-Object {
  $serverExclude -notcontains $_.Name
} | ForEach-Object {
  Copy-Item -Path $_.FullName -Destination (Join-Path $serverDst $_.Name) -Recurse -Force
}

$webDst = Join-Path $bundleDir "web"
foreach ($item in @("index.html", "js", "modules", "assets")) {
  $src = Join-Path $RepoRoot $item
  if (-not (Test-Path $src)) {
    Write-Host ("[ERP] skip missing: " + $item) -ForegroundColor Yellow
    continue
  }
  Copy-Item -Path $src -Destination (Join-Path $webDst $item) -Recurse -Force
}

$tplDir = Join-Path $PSScriptRoot "deploy-templates"
if (-not (Test-Path $tplDir)) { throw "deploy-templates folder not found" }
Copy-Item -Path (Join-Path $tplDir "*") -Destination $bundleDir -Force

if (Test-Path $OutZip) { Remove-Item $OutZip -Force }
Compress-Archive -Path $bundleDir -DestinationPath $OutZip -CompressionLevel Optimal
Remove-Item $stagingRoot -Recurse -Force

Write-Step ("Done: " + $OutZip)
$sizeMb = [math]::Round((Get-Item $OutZip).Length / 1MB, 2)
Write-Host ("Size MB: " + $sizeMb) -ForegroundColor Green
Write-Step "Install: copy server\.env.example to server\.env, then edit."
