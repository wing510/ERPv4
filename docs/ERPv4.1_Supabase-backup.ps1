#Requires -Version 5.1
<#
  ERP v4.1 Supabase backup (pg_dump) — daily job script
  First time: run ERPv4.1_Supabase-backup-setup.ps1 or D:\ERP\安裝備份.bat
#>
param(
  [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$msg) {
  Write-Host "[ERP-Backup] $msg" -ForegroundColor Cyan
}

$scriptDir = $PSScriptRoot
if (-not $ConfigPath) {
  $ConfigPath = Join-Path $scriptDir "ERPv4.1_Supabase-backup.config.ps1"
}
if (-not (Test-Path $ConfigPath)) {
  throw "Config not found: $ConfigPath (run ERPv4.1_Supabase-backup-setup.ps1 or 安裝備份.bat first)"
}

. $ConfigPath
$c = $BackupConfig
if (-not $c) {
  throw 'Config file must define $BackupConfig hashtable'
}

$hostName = [string]$c.DbHost
$port = 5432
if ($c.DbPort) { $port = [int]$c.DbPort }
$db = "postgres"
if ($c.DbName) { $db = [string]$c.DbName }
$user = "postgres"
if ($c.DbUser) { $user = [string]$c.DbUser }
$pass = [string]$c.DbPassword
$outDir = [string]$c.OutDir
$keepDays = 0
if ($null -ne $c.KeepDays) { $keepDays = [int]$c.KeepDays }

if (-not $hostName -or -not $pass -or -not $outDir) {
  throw "DbHost, DbPassword and OutDir are required"
}

function Find-PgDumpPath {
  param([string]$Preferred = "")
  if ($Preferred -and (Test-Path -LiteralPath $Preferred)) { return $Preferred }
  foreach ($p in @(
    "D:\pgsql\17\bin\pg_dump.exe",
    "D:\pgsql\16\bin\pg_dump.exe",
    "C:\pgsql\17\bin\pg_dump.exe",
    "C:\pgsql\16\bin\pg_dump.exe"
  )) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  $pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
  if ($pgDump -and (Test-Path -LiteralPath $pgDump.Source)) { return $pgDump.Source }
  return ""
}

$pgDumpExe = Find-PgDumpPath -Preferred ([string]$c.PgDumpPath).Trim()
if (-not $pgDumpExe) {
  throw "pg_dump not found. Install to D:\pgsql\17\ or set PgDumpPath in config."
}

New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$outFile = Join-Path $outDir ("erp_supabase_" + $stamp + ".dump")

Write-Step ("Dump to " + $outFile)

$env:PGPASSWORD = $pass
try {
  & $pgDumpExe -h $hostName -p $port -U $user -d $db -Fc -f $outFile
  if ($LASTEXITCODE -ne 0) {
    throw "pg_dump failed (exit $LASTEXITCODE)"
  }
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $outFile)) {
  throw "Backup file was not created"
}

$sizeBytes = (Get-Item -LiteralPath $outFile).Length
if ($sizeBytes -lt 1024) {
  Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
  throw "Backup file too small ($sizeBytes bytes). Check DbHost, DbPassword and network."
}

$sizeMb = [math]::Round($sizeBytes / 1MB, 2)
Write-Step ("OK, size MB: " + $sizeMb)

if ($keepDays -gt 0) {
  $cutoff = (Get-Date).AddDays(-$keepDays)
  Get-ChildItem -Path $outDir -Filter "erp_supabase_*.dump" -File | Where-Object {
    $_.LastWriteTime -lt $cutoff
  } | ForEach-Object {
    Write-Step ("Remove old: " + $_.Name)
    Remove-Item -LiteralPath $_.FullName -Force
  }
} else {
  Write-Step "KeepDays=0, skip auto-delete"
}

Write-Step "Done"
