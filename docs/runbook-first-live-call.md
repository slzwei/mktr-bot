# First live call — Shawn, MKTR PTE. LTD.

**Not approved for execution yet.** The agent has not placed a call, registered the gateway, or tested real speech. Implementation tests are **verified against fake ESL and fake STT**. The command verifier checks shell syntax and isolated fixtures; it does not establish Docker, TLS, Singtel, or provider functionality.

Record these values in Shawn's private deployment record before proceeding:

- Operator review: **pending Shawn's review**, with date and the deployed Git commit.
- Sole approved destination: **pending Shawn's designation**, recorded once in E.164 form. No fixture number is an approved destination. Use a reachable handset whose recipient has agreed to the test and whose consent is recorded in the application.
- Caller ID: **`+6562773211` only** for this test. The Retell number identified by `RESERVED_CALLER_ID` in `src/lib/domain.ts` is permanently denied and must never be used. `CALLER_IDS` in that file remains the approved pool's source of truth.
- Singtel public-IP whitelist confirmation, account/CA delivery, TLS identity requirements, and support reference: **pending operator confirmation**.
- Flow ID and immutable version: the short, published test flow with uploaded greeting, one listening node, fallback/end routes, and a maximum of one retry.

Shawn owns every host installation, production setup, credential entry, Singtel contact, purchase/account decision, gateway enablement, and real call in this document. The agent may run only the credential-free verifier and simulator/fake-provider tests. Commands below are operator instructions unless expressly described as dry verification.

Before the first dial, record the approved destination's actual voice-marketing consent source and timestamp in Campaigns → Voice call permission, or record an affirmative Singapore No Voice Call Registry result checked within the last 21 days. An imported contact and a test-call designation alone do not satisfy the every-dial consent gate. Confirm the permission check shows allowed, and retain the supporting evidence; see `docs/compliance.md`. No test fixture grants permission to a real recipient.

## 1. Close the prerequisites

A1 through A7 must be complete before dialing, including the runtime checks that need the operator host. Review their `Status` and `Evidence` in `PRODUCTION_CHECKLIST.md`; a passing fake-provider test cannot close a real registration or Docker check. The preparation and registration steps below let Shawn resolve those outstanding infrastructure checks while the API remains in simulator mode. Do not advance to the call while any required check fails.

Shawn provisions the Linux host with a public static IP, installs Docker Engine/Compose and the pinned Node version, and deploys the reviewed commit. Confirm the IP whitelist with Singtel. The account's signaling IP is not the host's public IP. Follow `docs/freeswitch-deployment.md` for the pinned source build, TLS CA/identity files, private addresses, and firewall rules: TLS TCP 5061 and local UDP 10000–10199, with Singtel's documented remote media IPs/ports. ESL 8021 must have no host publication. Public operator access goes through Caddy HTTPS; direct API access remains loopback/private.

Create a protected deployment environment file outside Git, for example `/etc/mktr/voice.env`, readable only by the deployment operator. Populate the names in `.env.example`: admin email/password, database password/URL, Caddy domain, exact HTTPS origin, Singtel values, public IP, certificate paths, a random ESL password, media bearer token, and Deepgram key. Select Deepgram, application locale `en-SG` (mapped to Deepgram `en`), and the desired classifier/model; supply the OpenAI key only if selecting that classifier. Never paste secrets into command arguments or share rendered Compose/XML output.

Initially set `MKTR_TELEPHONY_MODE` to `simulated`. In the protected environment set `MKTR_MAX_CONCURRENT_CALLS` to **1**, `MKTR_MAX_CALL_SECONDS` to **60**, and `MKTR_ORIGINATE_TIMEOUT_SECONDS` to **30**. Keep campaigns paused. Set the nonsecret shell variables `MKTR_DEPLOY_ENV`, `MKTR_FSCLI_PROFILE`, and `MKTR_VOICE_ORIGIN` to the deployment env file, private diagnostic profile, and exact HTTPS origin. Run from the repository root:

```bash
: "${MKTR_DEPLOY_ENV:?Set the absolute protected deployment env-file path}"
: "${MKTR_FSCLI_PROFILE:?Set the absolute private fs_cli profile path}"
: "${MKTR_VOICE_ORIGIN:?Set the deployed HTTPS origin}"
export MKTR_DEPLOY_ENV MKTR_FSCLI_PROFILE MKTR_VOICE_ORIGIN
export COMPOSE_ENV_FILES="$MKTR_DEPLOY_ENV"
docker compose version
docker compose --env-file "$MKTR_DEPLOY_ENV" config --quiet
docker compose --env-file "$MKTR_DEPLOY_ENV" --profile live config --quiet
```

The env-file selection also applies to the backup script's Compose calls through `COMPOSE_ENV_FILES`. Shell variables take precedence over env-file values; remove stale telephony/limit overrides before inspection. [Docker documents this env-file behavior](https://docs.docker.com/compose/how-tos/environment-variables/envvars/).

```bash
npm run verify:runbook
npm run render:freeswitch -- --dry-run
npm run build
npm test
npm run test:media
npm run test:e2e
npm run test:db
```

The last command uses its own disposable Compose Postgres. With already-installed native Postgres tools, `npm run test:db:local` runs the same suite; this alternative does not close the Compose check. Review CI and the container build/restore evidence before deployment.

## 2. Prove the simulator deployment and preserve a backup

Build the application, worker, and pinned gateway image. Build does not start FreeSWITCH. Start only the simulator application dependencies:

```bash
docker compose --env-file "$MKTR_DEPLOY_ENV" build api media-worker freeswitch
docker compose --env-file "$MKTR_DEPLOY_ENV" up --detach postgres redis api media-worker caddy
docker compose --env-file "$MKTR_DEPLOY_ENV" --profile live config --format json | node scripts/check-first-call-config.mjs --simulated
curl --fail --silent --show-error "${MKTR_VOICE_ORIGIN}/api/health"
```

The config inspector must report concurrency 1, duration 60, originate timeout 30, matching simulator modes, healthchecks, and no published ESL. Health must report simulator mode and `gateway: "n/a"`. Confirm the browser's valid HTTPS certificate, seeded admin sign-in, unauthenticated rejection, uploaded audio preview, a short published simulator flow, and the same capacity across operator sessions. Built-in sample previews are not production clips. Preserve the selected flow/version and close the simulated call.

Drain all calls, keep campaigns paused, and choose a new backup directory through `MKTR_RUNBOOK_BACKUP_DIR`. The backup script refuses to snapshot a running API; see `docs/backups.md` for verification and restoration into empty targets.

```bash
: "${MKTR_RUNBOOK_BACKUP_DIR:?Choose a new protected backup directory}"
docker compose --env-file "$MKTR_DEPLOY_ENV" stop --timeout 20 api
scripts/backup.sh "$MKTR_RUNBOOK_BACKUP_DIR"
docker compose --env-file "$MKTR_DEPLOY_ENV" start api
```

## 3. Register and inspect the gateway with the API still simulated

Create `MKTR_FSCLI_PROFILE` privately with a `[default]` profile containing `host = 172.29.80.4`, `port = 8021`, the actual ESL password, and `no-history-file = true`. Use the configured private gateway address if the deployment subnet changed. Restrict the file to its owner. Do not store the password in shell history, a process argument, Git, or this runbook.

`scripts/fs-cli-private.sh` runs the pinned image's `fs_cli` as the invoking operator's numeric UID/GID, mounts that profile read-only, and shares the API container's network namespace. It falls back to the worker namespace if the API is stopped. Both peers already have explicit ESL ACL entries. The wrapper uses `-Q` to disable command history and never starts another FreeSWITCH server. The profile key and flag were checked against the [pinned fs_cli source](https://github.com/signalwire/freeswitch/blob/ef32e205295e29f034f1453ad245ba5efb07b94a/libs/esl/fs_cli.c).

The next command starts the gateway and can register real credentials. **Shawn runs it only after reviewing the host/whitelist/secret prerequisites. The agent never runs it.** Explicitly targeting the profiled service selects it without a blanket live-profile startup.

```bash
docker compose --env-file "$MKTR_DEPLOY_ENV" up --detach --no-deps freeswitch
scripts/fs-cli-private.sh -x "sofia status gateway singtel"
scripts/fs-cli-private.sh -x "sofia status profile external"
scripts/fs-cli-private.sh -x "module_exists mod_audio_stream"
scripts/fs-cli-private.sh -x "show channels as json"
```

Require gateway **REGED**, external **TLS 5061**, the correct advertised public IP, `mod_audio_stream` present, and no leftover MKTR channel. Copy those redacted results into the deployment record and A4 evidence. Resolve a CA, certificate, NAT, module, or registration failure before proceeding; retain TLS verification and the private ESL ACL. Do not test connectivity by originating a call from `fs_cli`.

## 4. Enable the application for one operator call

Only after Shawn records the single destination/review and A1–A7 gates, Shawn manually changes `MKTR_TELEPHONY_MODE` in the protected deployment file to the FreeSWITCH adapter value. Do not change a committed file. Keep limits at 1 and 60, and recreate both API and worker so their modes agree. Confirm Deepgram is configured; real STT connectivity and accent accuracy still need the upcoming operator call.

```bash
docker compose --env-file "$MKTR_DEPLOY_ENV" --profile live config --format json | node scripts/check-first-call-config.mjs --gateway
docker compose --env-file "$MKTR_DEPLOY_ENV" up --detach --no-deps --force-recreate api media-worker
curl --fail --silent --show-error "${MKTR_VOICE_ORIGIN}/api/health"
docker compose --env-file "$MKTR_DEPLOY_ENV" ps
```

Require healthy API/worker, ESL connectivity, gateway REGED, zero active calls, and capacity **0 of 1** in the UI. A failed readiness check is a stop condition. In a second terminal follow API and worker logs. In another keep private `fs_cli` diagnostics ready. Use informational logs; preserve request/call IDs and avoid enabling credential-bearing protocol dumps.

```bash
docker compose --env-file "$MKTR_DEPLOY_ENV" logs --follow --since 5m api media-worker
```

```bash
scripts/fs-cli-private.sh
```

Shawn signs in to the HTTPS UI, selects the approved published flow/version and caller ID `+6562773211`, and enters **only the one destination in the approval record**. Confirm its consent gate, then press the call button once. Copy the application call ID and `providerCallId` from the call response/logs into the deployment record; set `MKTR_TEST_PROVIDER_UUID` to that exact provider UUID for diagnostics and abort. Do not enter a SIP account, phone number, or application call ID in its place.

Listen for the uploaded greeting, answer the prompt once, and confirm answer → clip playback → listening → one final transcript → branch → end. Check that prompt audio is not transcribed as the callee and that the chosen branch/clip matches the answer. Verify PCMA and SRTP on the active provider channel:

```bash
: "${MKTR_TEST_PROVIDER_UUID:?Copy the approved test call provider UUID}"
scripts/fs-cli-private.sh -x "uuid_getvar ${MKTR_TEST_PROVIDER_UUID} read_codec"
scripts/fs-cli-private.sh -x "uuid_getvar ${MKTR_TEST_PROVIDER_UUID} write_codec"
scripts/fs-cli-private.sh -x "uuid_getvar ${MKTR_TEST_PROVIDER_UUID} rtp_secure_media"
scripts/fs-cli-private.sh -x "uuid_getvar ${MKTR_TEST_PROVIDER_UUID} rtp_has_crypto"
```

Require PCMA/G.711 A-law, the mandatory secure-media setting, a nonempty negotiated SRTP cipher from `rtp_has_crypto`, and working audio in both directions. That variable contains the cipher name rather than key material in the [pinned RTP implementation](https://github.com/signalwire/freeswitch/blob/ef32e205295e29f034f1453ad245ba5efb07b94a/src/switch_rtp.c). Record actual results, transcript accuracy, branch latency, and audio quality. The originate timeout is 30 seconds; the answered-call cap is 60 seconds. End sooner once the check is complete. Abort immediately for an unexpected destination/caller ID, unexplained silence, missing transcript, incorrect routing, failed media authentication, or lost call control. Do not wait for the deadline to fix a broken call.

After the flow ends, require UI capacity **0 of 1**, a persisted outcome/history entry, and no remaining provider UUID:

```bash
scripts/fs-cli-private.sh -x "uuid_exists ${MKTR_TEST_PROVIDER_UUID}"
scripts/fs-cli-private.sh -x "show channels as json"
```

`uuid_exists` must return false. Preserve the immutable graph version, outcome and redacted evidence. This single test does not approve campaigns, every caller ID, inbound routing, or raising the limit.

## 5. Abort and roll back

Use **End call** in the UI first. If it fails or a channel remains, Shawn issues the exact provider termination command from the private diagnostic path:

```bash
scripts/fs-cli-private.sh -x "uuid_kill ${MKTR_TEST_PROVIDER_UUID} NORMAL_CLEARING"
scripts/fs-cli-private.sh -x "uuid_exists ${MKTR_TEST_PROVIDER_UUID}"
```

If both allowed diagnostic peers are unavailable, or termination cannot be confirmed, stop the gateway as the emergency measure. This ends every channel on that gateway; the first-call window must contain only this one test and no campaign traffic.

```bash
docker compose --env-file "$MKTR_DEPLOY_ENV" stop --timeout 5 freeswitch
```

For rollback, stop application/worker/gateway, then manually return `MKTR_TELEPHONY_MODE` in the protected env file to `simulated`. Keep data and volumes intact. Do not use `down --volumes`, delete records, or restore over the existing database to change modes.

```bash
docker compose --env-file "$MKTR_DEPLOY_ENV" stop --timeout 20 api media-worker freeswitch
```

After the env-file edit, inspect the simulator settings and recreate only API and worker:

```bash
docker compose --env-file "$MKTR_DEPLOY_ENV" --profile live config --format json | node scripts/check-first-call-config.mjs --simulated
docker compose --env-file "$MKTR_DEPLOY_ENV" up --detach --no-deps --force-recreate api media-worker
curl --fail --silent --show-error "${MKTR_VOICE_ORIGIN}/api/health"
docker compose --env-file "$MKTR_DEPLOY_ENV" ps
```

Confirm simulator mode, `gateway: "n/a"`, zero active calls, gateway stopped, and campaigns paused. Keep the test limits until a later reviewed deployment changes them. Use the documented backup/empty-target restore procedure only for a separate data recovery need.

## Verification record

Run `npm run verify:runbook` after editing this document. It syntax-checks every Bash block without evaluation, executes the gateway renderer with dummy inputs, verifies private diagnostic command construction using a fake Docker executable, and exercises the first-call config inspector with generated fixtures. It does not execute runbook deployment commands, call Singtel, or contact STT/OpenAI.

A8 remains blocked by **Shawn's review and designation of the one approved E.164 destination**. Docker-dependent functional checks remain blocked here by **Docker not installed on host**. Singtel REGED/TLS, actual gateway image execution, real audio/STT, and the operator call are intentionally left to this runbook. Add the operator's dated review and actual results to the checklist before changing the relevant blocked status.
