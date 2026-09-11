#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# != 1 ]]; then
  echo 'Usage: scripts/backup.sh NEW_BACKUP_DIRECTORY' >&2
  exit 2
fi
mktr_backup_target=$1
mktr_backup_stage="${mktr_backup_target}.incomplete"
if [[ -e "$mktr_backup_target" || -e "$mktr_backup_stage" ]]; then
  echo 'Backup target already exists; choose a new directory.' >&2
  exit 2
fi
mkdir -m 700 -p "$mktr_backup_stage"
if [[ -n "${MKTR_BACKUP_DATABASE_URL:-}" || -n "${MKTR_BACKUP_CLIP_DIR:-}" ]]; then
  : "${MKTR_BACKUP_DATABASE_URL:?Set both MKTR_BACKUP_DATABASE_URL and MKTR_BACKUP_CLIP_DIR for native-client backup}"
  : "${MKTR_BACKUP_CLIP_DIR:?Set both MKTR_BACKUP_DATABASE_URL and MKTR_BACKUP_CLIP_DIR for native-client backup}"
  pg_dump --dbname="$MKTR_BACKUP_DATABASE_URL" --format=custom --no-owner --no-acl > "$mktr_backup_stage/database.dump"
  tar -czf "$mktr_backup_stage/clips.tar.gz" -C "$MKTR_BACKUP_CLIP_DIR" .
else
  # Run from the repository on the operator host; this never selects a live profile.
  if [[ -n "$(docker compose ps -q --status running api)" ]]; then
    echo 'Drain calls and stop the api before backing up, so database rows and clip files cannot change between snapshots.' >&2
    exit 2
  fi
  docker compose exec -T postgres pg_dump -U mktr -d mktr --format=custom --no-owner --no-acl > "$mktr_backup_stage/database.dump"
  docker compose run --rm --no-deps -T --entrypoint tar api -czf - -C /app/storage/clips . > "$mktr_backup_stage/clips.tar.gz"
fi
(
  cd "$mktr_backup_stage"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum database.dump clips.tar.gz > SHA256SUMS
  else
    shasum -a 256 database.dump clips.tar.gz > SHA256SUMS
  fi
  date -u '+created_at=%Y-%m-%dT%H:%M:%SZ' > manifest.txt
  printf '%s\n' 'format=mktr-backup-v1' 'database=postgres-custom' 'clips=tar-gzip' >> manifest.txt
)
mv "$mktr_backup_stage" "$mktr_backup_target"
printf 'Backup complete: %s\n' "$mktr_backup_target"
