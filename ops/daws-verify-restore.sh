#!/usr/bin/env bash
#
# Restore a DAWS backup into a throwaway database and directory, and check it.
#
# A backup nobody has restored is a hope. This is the drill, written down so it
# can be run on a schedule rather than on the morning somebody needs it - and
# it never touches the live database or the live files: it makes its own and
# removes them at the end.
#
#   ./daws-verify-restore.sh /backup/2026-09-08T020000Z
#
# It answers three questions, in this order, and stops at the first no.

set -euo pipefail

# Defined first: url_with_db below calls fail() while the script is still
# setting up, which is before these used to be declared.
log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

BACKUP="${1:?usage: daws-verify-restore.sh <backup directory>}"
: "${DATABASE_URL:?DATABASE_URL is required (for the server to restore into)}"

# Swap the database name in a libpq URI, keeping the user, password, host,
# port and any options exactly as given.
#
# This script asked for DATABASE_URL and then never used it: createdb,
# pg_restore and psql do not read that variable, so every one of them fell
# back to whatever a bare `psql` would do - a local socket, as whatever user
# the timer runs as. Set up exactly as DEPLOY.md describes, with DATABASE_URL
# in /etc/daws/backup.env, the weekly drill died on its first connection:
#
#   createdb: error: connection to server on socket
#   "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory
#
# Worse than failing, it could succeed against a DIFFERENT server than the
# backup came from and report that the backup restores. Passing the URI to
# each tool keeps credential handling inside libpq, where it belongs.
url_with_db() {
  local url="$1" name="$2" head="$1" query=""
  case "${url}" in
    *"?"*) head="${url%%\?*}"; query="?${url#*\?}" ;;
  esac
  case "${head}" in
    */*/*/*) : ;;
    *) fail "DATABASE_URL has no database name in it: ${head}" ;;
  esac
  printf %s%s%s "${head%/*}/" "${name}" "${query}"
}

WORK="$(mktemp -d)"
DB="daws_verify_$(date -u +%s)"
TARGET_URL="$(url_with_db "${DATABASE_URL}" "${DB}")"

cleanup() {
  rm -rf "${WORK}"
  # Dropped through the same server it was created on, not through
  # whatever a bare dropdb would reach.
  psql --dbname="${DATABASE_URL}" --quiet \
    --command "DROP DATABASE IF EXISTS \"${DB}\"" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ------------------------------------------------- 0. is the backup complete?
# SHA256SUMS is written last by daws-backup.sh, so its absence means the backup
# was interrupted. Restoring one of those is how an outage becomes two.
[ -f "${BACKUP}/SHA256SUMS" ] || fail "no SHA256SUMS - that backup did not finish"

log "checking the backup against its own digests"
( cd "${BACKUP}" && sha256sum --check --quiet SHA256SUMS ) \
  || fail "a file in the backup does not match its digest"

# ------------------------------------------------------- 1. does it restore?
log "restoring into ${DB}"
psql --dbname="${DATABASE_URL}" --quiet --command "CREATE DATABASE \"${DB}\"" \
  || fail "could not create the throwaway database on that server"
pg_restore --dbname="${TARGET_URL}" --no-owner "${BACKUP}/database.dump" \
  || fail "pg_restore refused the dump"

log "extracting the files"
tar --extract --gzip --file="${BACKUP}/storage.tgz" --directory="${WORK}" \
  || fail "the storage archive could not be read"

# --------------------------------------------- 2. is the audit trail intact?
# The chain is checked here rather than through the API, because this script
# must work with nothing running. Contiguous positions and a tip that matches
# the witness is what the API's own verification concludes from.
log "checking the audit trail"
gaps="$(psql --dbname="${TARGET_URL}" --tuples-only --no-align --command "
  SELECT count(*) FROM (
    SELECT seq, lag(seq) OVER (ORDER BY seq) AS previous
    FROM audit_logs WHERE seq IS NOT NULL
  ) walk WHERE previous IS NOT NULL AND seq <> previous + 1;")"

[ "${gaps}" = "0" ] || fail "the audit trail has ${gaps} gap(s) - records are missing"

cut_short="$(psql --dbname="${TARGET_URL}" --tuples-only --no-align --command "
  SELECT count(*) FROM ledger_checkpoints c
  WHERE NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.seq = c.seq);")"

[ "${cut_short}" = "0" ] || fail "${cut_short} witnessed record(s) are gone - the trail was cut short"

# ------------------------------------- 3. are the files the files it expects?
# Every artefact whose digest was recorded, checked against the bytes restored.
# This is the one that catches a database and a storage directory taken from
# different moments, which is the failure this whole pair of scripts is about.
log "checking the files against their recorded digests"
missing=0
mismatched=0
checked=0

while IFS='|' read -r path digest; do
  [ -n "${path}" ] || continue
  file="${WORK}/$(basename "${STORAGE_DIR:-storage}")/documents/${path}"

  if [ ! -f "${file}" ]; then
    missing=$((missing + 1))
    continue
  fi

  actual="$(sha256sum "${file}" | cut -d' ' -f1)"
  [ "${actual}" = "${digest}" ] || mismatched=$((mismatched + 1))
  checked=$((checked + 1))
done < <(psql --dbname="${TARGET_URL}" --tuples-only --no-align --field-separator='|' --command "
  SELECT storage_path, storage_checksum FROM document_versions
  WHERE storage_checksum IS NOT NULL;")

[ "${missing}" = "0" ] || fail "${missing} file(s) referenced by the database are not in the backup"
[ "${mismatched}" = "0" ] || fail "${mismatched} file(s) do not match the digest recorded when they were signed"

log "verified: ${checked} file(s), audit trail contiguous and complete"
printf '\nOK — this backup restores.\n'
