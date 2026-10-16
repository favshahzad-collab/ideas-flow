<#
.SYNOPSIS
  Back up Ideas Flow on a Windows server: the database and the stored files,
  together, then a copy somewhere off this machine.

.DESCRIPTION
  The Windows counterpart of ops/daws-backup.sh, for the layout where
  PostgreSQL runs in Docker Desktop and pg_dump is not installed on the host.

  In the order DEPLOY.md requires - database first, files second - so a
  document created in between is a file nothing references (harmless) rather
  than a row pointing at a file the backup does not have.

  Each run makes one folder named by the UTC time:
    database.dump   pg_dump custom format, checked readable before it is kept
    storage.zip     the STORAGE_DIR folder: every PDF, signature and attachment
    SHA256SUMS.txt  a digest of both, checked again after the off-site copy

  Then copies that folder to -OffsiteDir (a network share, a USB or second
  disk, or a OneDrive/SharePoint-synced folder) and checks the copy matches.
  Old backups are removed from both places after -KeepDays.

  Touches nothing live: pg_dump reads, and the files are only read.

.EXAMPLE
  .\daws-backup.ps1 -StorageDir "C:\New folder\DAWS-main (1)\daws-sod\backend\storage" `
                    -BackupDir "D:\DAWS\backups" -OffsiteDir "\\fileserver\backups\daws"
#>
param(
  [Parameter(Mandatory = $true)] [string] $StorageDir,
  [string] $BackupDir = "D:\DAWS\backups",
  [string] $OffsiteDir = "",
  [int] $KeepDays = 14,
  [int] $OffsiteKeepDays = 60,
  [string] $Container = "daws-postgres",
  [string] $Database = "daws"
)

$ErrorActionPreference = "Stop"
$stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHHmmssZ")
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$log = Join-Path $BackupDir "backup.log"

function Say([string] $message) {
  $line = "{0}  {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $message
  Write-Output $line
  Add-Content -Path $log -Value $line
}

function Run-Docker([string[]] $arguments) {
  & docker @arguments
  if ($LASTEXITCODE -ne 0) { throw "docker $($arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

$target = Join-Path $BackupDir $stamp
try {
  if (-not (Test-Path -LiteralPath $StorageDir)) { throw "STORAGE_DIR not found: $StorageDir" }
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Say "backup $stamp starting"

  # 1. The database, dumped inside the container and copied out. Binary
  #    output never goes through a PowerShell pipe, which would corrupt it.
  $inside = "/tmp/daws-backup-$stamp.dump"
  Run-Docker @("exec", $Container, "sh", "-c", "pg_dump -U `"`$POSTGRES_USER`" --format=custom --no-owner --file=$inside $Database")
  # Readable before it is kept: pg_restore lists its contents or fails.
  Run-Docker @("exec", $Container, "sh", "-c", "pg_restore --list $inside > /dev/null")
  Run-Docker @("cp", "${Container}:$inside", (Join-Path $target "database.dump"))
  Run-Docker @("exec", $Container, "rm", "-f", $inside)
  Say "database dumped and checked readable"

  # 2. Then the files.
  Compress-Archive -Path (Join-Path $StorageDir "*") -DestinationPath (Join-Path $target "storage.zip") -CompressionLevel Optimal
  Say "stored files archived"

  # 3. Digests, so the copy off this machine can be proven identical.
  $sums = Get-ChildItem -LiteralPath $target -File | Where-Object Name -ne "SHA256SUMS.txt" | ForEach-Object {
    "{0}  {1}" -f (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLower(), $_.Name
  }
  Set-Content -LiteralPath (Join-Path $target "SHA256SUMS.txt") -Value $sums
  Say ("database {0:N0} KB, files {1:N0} KB" -f ((Get-Item (Join-Path $target "database.dump")).Length / 1KB), ((Get-Item (Join-Path $target "storage.zip")).Length / 1KB))

  # 4. Off this machine, and checked.
  if ($OffsiteDir) {
    New-Item -ItemType Directory -Force -Path $OffsiteDir | Out-Null
    $copy = Join-Path $OffsiteDir $stamp
    Copy-Item -LiteralPath $target -Destination $copy -Recurse -Force
    foreach ($line in $sums) {
      $expected, $name = $line -split "  ", 2
      $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $copy $name)).Hash.ToLower()
      if ($actual -ne $expected) { throw "off-site copy of $name does not match ($actual vs $expected)" }
    }
    Say "copied off-site to $copy and checked"

    Get-ChildItem -LiteralPath $OffsiteDir -Directory |
      Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}T\d{6}Z$' -and $_.LastWriteTime -lt (Get-Date).AddDays(-$OffsiteKeepDays) } |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force; Say "removed old off-site backup $($_.Name)" }
  } else {
    Say "WARNING: no -OffsiteDir given; this backup exists only on this machine"
  }

  # 5. Rotate local copies. Only folders this script made are ever removed.
  Get-ChildItem -LiteralPath $BackupDir -Directory |
    Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}T\d{6}Z$' -and $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force; Say "removed old backup $($_.Name)" }

  Say "backup $stamp finished"
  exit 0
}
catch {
  Say "BACKUP FAILED: $($_.Exception.Message)"
  # A half-made backup is worse than none: it looks like one. Removed, so
  # the newest folder is always a whole backup.
  if ((Test-Path -LiteralPath $target) -and -not (Test-Path -LiteralPath (Join-Path $target "SHA256SUMS.txt"))) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
  exit 1
}
