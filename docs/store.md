# Durable application state

The API uses `PrismaStore` and Postgres by default. Set `DATABASE_URL` through the deployment environment. API startup runs `prisma migrate deploy`, loads committed flows, clips and call snapshots, restores each active call's immutable published graph, reconciles clip files, and then opens the HTTP listener. An unavailable database or failed migration prevents startup. Use one API process for this deployment; the synchronized cache and trunk ceiling belong to that process.

`Store` reads return independent copies. Mutations update the process cache and queue ordered database writes. Call state and new events commit in one transaction; publishing commits the current flow and its immutable `FlowVersion` together. Every HTTP mutation must await `store.flush()` before returning success. The orchestrator must await it before originating or issuing playback/media side effects. After any database write failure, the store refuses further mutations and flushes until the API restarts and reloads committed state. Shutdown must flush before closing the store. Database recovery does not silently replay an originate.

`GET /api/flows/:id/versions/:version` returns the exact published graph referenced by a call's `flowId` and `flowVersion`. Published graphs have an additional database trigger rejecting updates and deletes. Deleting a flow removes it from current editing while retaining versions and call history. A clip referenced by any published graph can only be archived; its recording remains available for historical references. User credentials and hashed cookie sessions use the same Postgres database.

At boot, referenced clip, preview and canonical telephony files remain in place. A record pointing to missing media is archived. Files without a record move into `storage/clips/orphaned/` with unique names, preserving their bytes for recovery; they are never automatically deleted. Restore the database and the complete clip directory together. Review a quarantined file before deleting it or linking it to a repaired record.

For disposable local simulation only, use `MKTR_STORE=memory npm run dev`. This explicit mode logs that records reset after restart and refuses to start in production or with the live telephony adapter. Tests construct `InMemoryStore` directly or set the same explicit simulator option.

Database checks:

```bash
npm run db:generate
npm run test:db
npm run test:db:local
```

`test:db` creates an isolated Compose Postgres 16 service with a generated password and random localhost port, applies migrations, runs the behavioral suite, and removes only its own test project. To use an existing disposable server, supply `DATABASE_TEST_URL`; the database name must be `mktr_test` or `mktr_test_*`. `test:db:local` uses already-installed `initdb`, `pg_ctl` and client tools to create and stop a temporary local cluster, then runs the same `test:db` suite. Neither command connects to the telephony trunk.

The suite verifies authenticated API process restart, session persistence, exact published graphs, active-call reconstruction against a fake adapter, file quarantine, soft deletion and an injected database failure that must roll back the call/event transaction. The Compose route still requires Docker; local PostgreSQL verification does not establish that a Docker image runs correctly.
