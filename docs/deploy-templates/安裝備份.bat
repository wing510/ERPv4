@echo off
chcp 65001 >nul
echo.
echo  ERP v4.1 Supabase backup — one-click setup
echo  Right-click this file -^> Run as administrator
echo.
cd /d "%~dp0"
if not exist "docs\ERPv4.1_Supabase-backup-setup.ps1" (
  echo ERROR: docs\ERPv4.1_Supabase-backup-setup.ps1 not found.
  echo Unzip deploy pack to D:\ERP\ first.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0docs\ERPv4.1_Supabase-backup-setup.ps1"
if errorlevel 1 (
  echo.
  echo Setup failed.
  pause
  exit /b 1
)
echo.
pause
