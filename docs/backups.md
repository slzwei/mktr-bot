# Database and clip backups

Back up Postgres and the complete clip volume together. Uploaded originals and normalized WAVs are both required. Keep backups outside the production host in operator-managed encrypted storage; the archives contain personal data and session/password hashes. The scripts use restrictive permissions and checksums, and never print database URLs or passwords.

Use PostgreSQL client tools matching the server's major version (Compose uses Postgres 16). A native PostgreSQL connection can use `.pgpass` or a libpq service file to avoid putting passwords in command arguments. Supply the connection through the named environment variables below; do not commit credential files.

On the operator host, pause campaigns, wait for every call to finish, and stop the API before the backup. The default backup script refuses a running API, so no database/clip writes can cross the two snapshots. Keep Postgres running. From the repository:

```bash
docker compose stop api
scripts/backup.sh "backups/$(date -u +%Y%m%dT%H%M%SZ)"
docker compose start api
```

The script reads the database through its running Postgres container and starts only a `tar` helper from the API image to read the clip volume. The helper has no application entrypoint. It creates `database.dump`, `clips.tar.gz`, `SHA256SUMS` and a timestamped manifest, renaming the directory from `.incomplete` only after every operation succeeds. If a backup fails, retain the incomplete directory for diagnosis and choose a new target for the retry. Resume campaigns only after health/readiness checks pass.

For a native-client backup of a stopped application, set `MKTR_BACKUP_DATABASE_URL` and `MKTR_BACKUP_CLIP_DIR` to the database connection and clip-volume directory and run the same script. This is also the test path used without Docker. Do not run native backup concurrently with application writes.

Restore into a newly created empty database and an empty clip directory. Do not overwrite a running service or restore directly into its existing data. After setting `MKTR_RESTORE_DATABASE_URL` and `MKTR_RESTORE_CLIP_DIR` to those explicit targets:

```bash
scripts/restore.sh backups/SELECTED_BACKUP
```

The restore checks the archive checksums, rejects unsafe archive paths and refuses nonempty targets. Verify migration history, flow/call/contact counts, a sampled clip's bytes and playback, and admin sign-in on an isolated simulator deployment. Then the operator can stop the production API, update its database connection and clip mount to the restored targets, and start it again. Keep the previous database/volume for rollback until that verification passes. A restoration does not authorize live calls.

Run the repeatable drill with local `initdb`, `pg_ctl`, `psql`, `pg_dump`, and `pg_restore` installed:

```bash
npm run test:backup
```

On 11 September 2026 this drill passed on PostgreSQL 17.10 on this host: a disposable localhost cluster backed up and restored relational `Flow`/`Call` rows and clip bytes, checked the restored join result and byte equality, and rejected nonempty database/directory targets and a checksum mismatch. The temporary cluster was stopped and deleted. This verifies the real dump/restore toolchain and archive checks; the operator must still perform the deployment's Postgres 16/container-volume drill after installing Docker.
