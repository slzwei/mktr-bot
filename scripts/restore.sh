#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# != 1 ]]; then
  echo 'Usage: MKTR_RESTORE_DATABASE_URL=... MKTR_RESTORE_CLIP_DIR=... scripts/restore.sh BACKUP_DIRECTORY' >&2
  exit 2
fi
: "${MKTR_RESTORE_DATABASE_URL:?Set the explicit empty target database connection}"
: "${MKTR_RESTORE_CLIP_DIR:?Set the explicit empty target clip directory}"
mktr_restore_source=$(cd "$1" && pwd)
if [[ ! -d "$MKTR_RESTORE_CLIP_DIR" ]]; then
  echo 'Create the empty target clip directory first.' >&2
  exit 2
fi
shopt -s nullglob dotglob
mktr_restore_entries=("$MKTR_RESTORE_CLIP_DIR"/*)
if (( ${#mktr_restore_entries[@]} != 0 )); then
  echo 'Restore refuses a nonempty clip directory.' >&2
  exit 2
fi
mktr_restore_tables=$(psql --dbname="$MKTR_RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')")
if [[ "$mktr_restore_tables" != 0 ]]; then
  echo 'Restore refuses a nonempty database. Restore into a new database and switch only after verification.' >&2
  exit 2
fi
(
  cd "$mktr_restore_source"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c SHA256SUMS
  else
    shasum -a 256 -c SHA256SUMS
  fi
)
# Reject absolute or parent-traversal entries before extracting an archive.
while IFS= read -r mktr_restore_entry; do
  case "$mktr_restore_entry" in
    /*|..|../*|*/../*|*/..) echo 'Unsafe clip archive path.' >&2; exit 2 ;;
  esac
done < <(tar -tzf "$mktr_restore_source/clips.tar.gz")
pg_restore --exit-on-error --no-owner --no-acl --dbname="$MKTR_RESTORE_DATABASE_URL" "$mktr_restore_source/database.dump"
tar -xzf "$mktr_restore_source/clips.tar.gz" -C "$MKTR_RESTORE_CLIP_DIR"
printf '%s\n' 'Restore complete. Verify row counts and media checksums before changing the application connection or volume.'
