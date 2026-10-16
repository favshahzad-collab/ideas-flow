<#
.SYNOPSIS
  Register the two Windows scheduled tasks Ideas Flow needs on its server:
  start the application after the server restarts, and back it up nightly.

.DESCRIPTION
  Run once, in PowerShell opened as Administrator, signed in as the account
  that runs pm2 and Docker Desktop.

  "DAWS - start application": at sign-in of this account, waits for Docker
  Desktop to bring the database back, then `pm2 resurrect` restarts the API
  and the web app exactly as `pm2 save` last recorded them.

  "DAWS - nightly backup": every night at -BackupTime, runs daws-backup.ps1.

  Both run with highest privileges, because the pm2 daemon on this server
  runs as Administrator. Both run in this account's session: Docker Desktop
  only runs while the account is signed in, so a server that restarts must
  sign this account back in (see DEPLOY.md, "On a Windows server").

  Safe to run again: each task is replaced, not duplicated.

.EXAMPLE
  .\daws-register-tasks.ps1 -StorageDir "C:\New folder\DAWS-main (1)\daws-sod\backend\storage" `
                            -OffsiteDir "\\fileserver\backups\daws"
#>
param(
  [Parameter(Mandatory = $true)] [string] $StorageDir,
  [string] $BackupDir = "D:\DAWS\backups",
  [string] $OffsiteDir = "",
  [string] $BackupTime = "02:15"
)

$ErrorActionPreference = "Stop"

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Open PowerShell with 'Run as administrator' and run this again." }

$pm2 = (Get-Command pm2.cmd -ErrorAction SilentlyContinue).Source
if (-not $pm2) { throw "pm2 was not found on PATH for this account." }

$user = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)

# Start: give Docker Desktop two minutes to start the database first.
$startTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$startTrigger.Delay = "PT2M"
$startAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"`"$pm2`" resurrect`""
Register-ScheduledTask -TaskName "DAWS - start application" -Trigger $startTrigger -Action $startAction `
  -Principal $principal -Settings $settings -Force `
  -Description "Restarts the Ideas Flow API and web app with pm2 after this account signs in." | Out-Null
Write-Output "Registered: DAWS - start application (at sign-in of $user, after 2 minutes)"

# Nightly backup.
$script = Join-Path $PSScriptRoot "daws-backup.ps1"
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -StorageDir `"$StorageDir`" -BackupDir `"$BackupDir`""
if ($OffsiteDir) { $arguments += " -OffsiteDir `"$OffsiteDir`"" }
$backupTrigger = New-ScheduledTaskTrigger -Daily -At $BackupTime
$backupAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
Register-ScheduledTask -TaskName "DAWS - nightly backup" -Trigger $backupTrigger -Action $backupAction `
  -Principal $principal -Settings $settings -Force `
  -Description "Backs up the Ideas Flow database and files, then copies them off this machine." | Out-Null
Write-Output "Registered: DAWS - nightly backup (daily at $BackupTime)"
if (-not $OffsiteDir) { Write-Output "WARNING: no -OffsiteDir given; backups will stay on this machine only." }
