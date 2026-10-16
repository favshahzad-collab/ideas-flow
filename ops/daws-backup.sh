#!/usr/bin/env bash
#
# One backup of DAWS: the database, then the files, then the ledger tip.
#
# All three, and in that order. The database holds the approvals and, for
# every artefact, the SHA-256 of the bytes that were signed; STORAGE_DIR holds
# the bytes. Restore them from different moments and the API refuses to serve
# the affected memos rather than serving the wrong ones - which is the right
# behaviour and still an outage.
#
# Database first, files second, because a memo submitted between the two is
# then a file nothing references, which is harmless. The other way round it is
# a row pointing at a file that is not in the backup: a memo nobody can open.
#
# Run it from cron, a systemd timer or Task Scheduler - see DEPLOY.md. It is
# deliberately a script rather than a service: an operator has to be able to
# read what their backup does, and run it by hand the day they need to.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${STORAGE_DIR:?STORAGE_DIR is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"

# How many days of backups to keep. Old ones are removed at the end, and only
# after a new one has been written - never before.
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

# Optional. When set, the ledger tip is recorded beside the backup, which is
# the one part of this that survives somebody with write access to the
# database: a chain rebuilt from scratch is consistent with itself, and a
# digest written down last month is what makes that visible.
APP_URL="${APP_URL:-}"
ADMIN_TOKEN="${BACKUP_ADMIN_TOKEN:-}"

stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
target="${BACKUP_DIR}/${stamp}"
mkdir -p "${target}"

log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# ---------------------------------------------------------------- 1. database
log "dumping the database"
pg_dump --format=custom --no-owner --file="${target}/database.dump" "${DATABASE_URL}"

# ------------------------------------------------------------------- 2. files
log "copying ${STORAGE_DIR}"
tar --create --gzip \
    --file="${target}/storage.tgz" \
    --directory="$(dirname "${STORAGE_DIR}")" \
    "$(basename "${STORAGE_DIR}")"

# ------------------------------------------------------------- 3. the witness
if [ -z "${APP_URL}" ] || [ -z "${ADMIN_TOKEN}" ]; then
  log "APP_URL or BACKUP_ADMIN_TOKEN unset; skipping the ledger tip"
elif ! command -v curl >/dev/null 2>&1; then
  # Said separately, because the old message blamed the operator's
  # configuration for a missing tool: somebody who HAD set both variables
  # was told they had not, and went looking for a typo while the one part
  # of this backup that survives an attacker with database write access
  # quietly never got written. Minimal server images ship without curl.
  log "curl is not installed; the ledger tip cannot be recorded"
else
  log "recording the ledger tip"
  # Best effort. A backup must not fail because the API was restarting.
  curl --silent --show-error --max-time 30 \
       --header "authorization: Bearer ${ADMIN_TOKEN}" \
       "${APP_URL}/api/audit/ledger" \
    > "${target}/ledger-tip.json" || log "could not reach the API; tip not recorded"
fi

# ------------------------------------------------------------------ integrity
# Written last, so its presence is what says the backup finished. A directory
# without it is a backup that was interrupted, and restoring one of those is
# how an outage becomes two.
( cd "${target}" && sha256sum ./* > SHA256SUMS )

log "backup complete: ${target}"

# ------------------------------------------------------------------- rotation
# Only now, and only whole directories this script made.
find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d \
     -name '20*Z' -mtime "+${KEEP_DAYS}" \
     -exec rm -rf {} + 2>/dev/null || true

log "kept the last ${KEEP_DAYS} days"
