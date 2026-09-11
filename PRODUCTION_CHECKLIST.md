# MKTR Voice Control production checklist

This file is the contract for taking the repo from simulator to production on the Singtel CPaaS SIP trunk.
Item IDs are stable. The human tracker board uses the same IDs.

Rules for updating this file:

- `Status` is one of `todo`, `doing`, `blocked`, `done`.
- Set `Status: done` only when the "Done when" text holds and the "Verify" step passed in this environment.
- `Evidence` names the commit, test name, or command output that proves it. Keep it to one line.
- `Blocked` items must say exactly what is missing (credential, network, image, decision) so the operator can unblock them.
- Update the item in the same commit as the code that completes it.

Tier order is the priority order. Tier A gates the first live call. Tier B gates running it as a service. Tier C gates real campaigns.

## Tier A. Before the first live call

### A1. Media worker with streaming speech-to-text
Status: done
Evidence: `npm run test:media` passes 3 loopback audio/fake-STT/provider-wire tests; HTTP receipt test rejects stale windows and accepts retries with one classification and one provider hangup; `npm test` 29/29 and build pass. Verified against fake ESL and fake STT. Docker-dependent service/healthcheck Verify blocked: Docker not installed on host; implementation and all available checks complete under the task's Docker exception.
Why: In FreeSWITCH mode nothing ever calls the answered or transcript webhooks, so a live call parks forever.
Done when: A separate `media-worker` process receives callee audio from FreeSWITCH (mod_audio_stream or mod_audio_fork over WebSocket, 8 kHz mono linear16), streams it to a speech-to-text provider behind a `SpeechToText` interface, detects end of utterance (provider endpointing or 750 ms of silence), and POSTs `/api/calls/:id/transcript` with the bearer token. Listen windows open only while the orchestrator is in `listening`. The provider is selected by env and one real provider is implemented. The worker has its own Dockerfile and compose service.
Verify: `npm run test:media` runs the worker against a fake WebSocket audio source and a stubbed provider and asserts one transcript POST per utterance. `docker compose config` shows the worker service with a healthcheck.

### A2. Persistent ESL event client
Status: done
Evidence: `npm test` passes 13 tests, including persistent ESL authentication, fragmented byte-counted event bodies, -ERR replies, reconnect/resubscribe, background originate failure, remote hangup slot release, PLAYBACK_STOP progression, exactly one provider hangup on completion, and no-route/failed-hangup behavior. `npm run build` and `npm run test:e2e` (10/10) pass. Verified against fake ESL; real trunk verification remains operator-only.
Why: The adapter opens a socket per command and never listens for events. Originate failures, answers, hang-ups, and playback completion are all invisible, and a hung-up call keeps its trunk slot forever.
Done when: One persistent, auto-reconnecting ESL connection subscribes to `BACKGROUND_JOB`, `CHANNEL_ANSWER`, `CHANNEL_HANGUP_COMPLETE`, and `PLAYBACK_STOP`, matched by `origination_uuid`. The originate job result moves the session to `dialing`, `ringing`, or `failed` with the hangup cause. `CHANNEL_ANSWER` triggers the orchestrator's answered path so the webhook is optional. `CHANNEL_HANGUP_COMPLETE` ends the session and frees the slot. Clip playback advances on `PLAYBACK_STOP`, not on a timer; the timer path remains only for the simulator. Reaching an end node, a flow failure, or a "no route" error hangs up the channel with `uuid_kill`; today only the operator's stop button does, so a completed live call stays parked and billing.
Verify: `npm test` includes a fake ESL server covering the auth handshake, event frames with `Content-Length` bodies, `-ERR` replies, and reconnect after socket close. A test emits `CHANNEL_HANGUP_COMPLETE` for an active call and asserts `activeCallCount()` drops by one. A test runs a flow to its end node with a fake adapter and asserts exactly one hangup command.

### A3. Timeouts and loop caps
Status: done
Evidence: `npm test` 34/34 passes including the six-second default listen deadline, silence fallback, repeated-listen retry cap, uncapped-loop publish rejection, unanswered/answered deadlines and fake-ESL originate variables; build passes. Docker-dependent compose inspection blocked: Docker not installed on host. Verified against fake ESL and fake STT; provider timers still require the operator runbook check.
Why: A silent callee leaves the call in `listening` forever, the retry node has no counter, and nothing caps call length.
Done when: Listen nodes have a configurable no-speech timeout (default 6 s) that routes to the fallback edge. Every originate sets `originate_timeout` (default 30 s) and `execute_on_answer=sched_hangup +MKTR_MAX_CALL_SECONDS` (default 180). Retry nodes carry `maxAttempts` (default 1) enforced by the orchestrator. Flow validation rejects a graph where a retry can re-enter a listen node without a counter.
Verify: Unit tests for each timeout and cap, plus a `validateFlow` test for an uncapped retry loop.

### A4. FreeSWITCH configuration that registers with Singtel
Status: blocked
Evidence: Implementation complete: `npm run render:freeswitch -- --dry-run`, `npm run test:freeswitch` (4/4), `npm run build`, and `npm test` (8/8) pass; tests parse the TLS overlay, secret escaping/permissions, CA/identity installation and identical UDP 10000–10199 mappings. Source-build revisions verified through upstream GitHub. Docker-dependent config/build Verify blocked: Docker not installed on host. Real REGED/TLS Verify blocked pending Shawn's Singtel-whitelisted Linux host, SIP credentials, supplied CA, matching gateway TLS certificate/private key and private fs_cli diagnostics; `docs/freeswitch-deployment.md` records inputs and checks. No live registration or call attempted.
Why: TLS is off on the default external profile, the CA file name is wrong for FreeSWITCH, the RTP range is mismatched three ways, and a bridge-network container advertises its private IP.
Done when: The repo ships a complete `telephony/freeswitch/conf` overlay mounted into the container: `vars.xml` with `external_ssl_enable=true`; the external profile with `tls`, `tls-only`, `tls-sip-port 5061`, `tls-verify-policy`, and `tls-cert-dir=/etc/freeswitch/tls` where the Singtel CA is installed as `cafile.pem`; `switch.conf.xml` with `rtp-start-port=10000` and `rtp-end-port=30000` or a documented narrower slice exposed identically in compose; `ext-sip-ip` and `ext-rtp-ip` taken from `MKTR_GATEWAY_PUBLIC_IP`, or `network_mode: host` for the FreeSWITCH service; gateway `singtel` using PCMA, `rtp-secure-media`, and RFC2833. The image tag is verified pullable or replaced with a documented build. `npm run render:freeswitch` renders the gateway XML from env without committing secrets.
Verify: `docker compose --profile live config` validates. On a host with credentials, `fs_cli -x "sofia status gateway singtel"` shows `REGED` and `sofia status profile external` shows TLS on 5061 (operator step, recorded in the runbook).

### A5. ESL lockdown
Status: done
Evidence: Implementation complete: startup-rendered event_socket password, private-interface bind, deny-by-default ACL for API/worker /32s, and no 8021 publication are in place; `FreeSWITCH startup rejects default, short and framed ESL passwords through the pure config guard` and rendered XML/ACL tests pass (`npm run test:freeswitch` 6/6, `npm test` 10/10, build passes). The task's Docker exception permits implementation completion; only Docker-dependent Verify remains blocked: Docker not installed on host; Shawn must install Docker/Compose and run `docker compose --profile live config` to verify the resolved publication list. No real ESL socket was opened.
Why: FreeSWITCH still uses the default `ClueCon` password and compose publishes port 8021 to the host. Anyone who reaches it can originate calls on the trunk.
Done when: `event_socket.conf.xml` in the overlay takes its password from `MKTR_FREESWITCH_ESL_PASSWORD` at start, `listen-ip` is the container network interface only, `apply-inbound-acl` restricts access to the api and media-worker services, and the `8021` port mapping is removed from compose. The api refuses to start in freeswitch mode if the password is `ClueCon` or shorter than 16 characters.
Verify: `docker compose --profile live config` shows no published 8021 port. A config test asserts the weak-password guard.

### A6. Graceful shutdown and orphan reconciliation
Status: done
Evidence: `SIGTERM drains two active fake channels with exactly two uuid_kill commands and exits before grace expires` passes in ~0.17 s; boot orphan identity filtering and disconnect/reconnect reconciliation tests pass; `npm test` 37/37 and build pass. Direct Node CMD and 20 s grace are configured. Docker-dependent stop timing Verify blocked: Docker not installed on host; no real call/channel was used.
Why: An API restart mid-call leaves a parked billable channel on the Singtel trunk with nothing to hang it up.
Done when: A SIGTERM and SIGINT handler stops accepting requests, hangs up every active `providerCallId`, closes SSE streams, and exits within the compose `stop_grace_period`. On boot in freeswitch mode the api runs `show channels` and kills any channel with `origination_caller_id_name=MKTR` that the store does not know. The Dockerfile runs node directly or via tini, not `npm run start`.
Verify: A test sends SIGTERM with two active fake calls and asserts two `uuid_kill` commands. `docker stop` completes without the 10 s kill.

### A7. Authentication, HTTPS, and API hardening
Status: done
Evidence: 2026-09-11: `npm run build`, 13 unit tests including the supertest auth/CORS/session/role/rate-limit/error suite, and all 11 Chromium tests including `operator signs in with the environment-seeded administrator` pass; `server/auth.ts`, `server/app.ts` and `Caddyfile` implement the controls. Docker-dependent compose inspection is blocked: Docker not installed on host; TLS issuance on the operator host remains a runbook check.
Why: Every control-plane route is open and CORS allows any origin. In live mode anyone reaching the port can dial from MKTR caller IDs.
Done when: Operators sign in with email and password (argon2id) seeded from env. Sessions are httpOnly secure cookies. Call start, publish, upload, and flow writes require an authenticated operator, and changing telephony mode requires the `admin` role. CORS is restricted to `MKTR_WEB_ORIGIN`. Security headers are set. `POST /api/calls` is rate limited. `trust proxy` is set. Compose adds a Caddy service terminating TLS for the UI and API. The webhook token comparison is timing-safe. The error handler logs internals and returns generic messages for 500s.
Verify: A supertest suite asserts unauthenticated `POST /api/calls` returns 401 and a wrong-origin preflight is rejected. The Playwright login flow passes.


### A8. First-live-call runbook
Status: blocked
Evidence: Runbook and operator helpers implemented; `npm run verify:runbook` passes syntax-only checks for all 14 Bash blocks/6 inline references, 12 dummy XML renders, 10 fake-Docker private fs_cli command fixtures, namespace fallback/originate rejection and first-call config fixtures. Missing: Shawn's dated review and designation of the single approved E.164 destination. Docker-dependent functional verification separately blocked: Docker not installed on host. No real registration, provider connection or call was attempted; operator checks are explicit in `docs/runbook-first-live-call.md`.
Why: The first real call is the riskiest step and is done by the operator, not the agent.
Done when: `docs/runbook-first-live-call.md` lists the prerequisites (A1 to A7 done, Singtel whitelist confirmed for the gateway public IP), the single approved test destination, caller ID `+6562773211`, the rule that `+6562773210` is never used, `MKTR_MAX_CONCURRENT_CALLS=1` and a 60 s max call for the test, how to watch `fs_cli` and api logs, the abort command, and rollback to simulator mode.
Verify: Every command in the runbook has been run in dry form (no credentials) by the agent. The operator has reviewed it.

## Tier B. Before running it as a service

### B1. Durable store on Postgres
Status: done
Evidence: `npm run test:db:local` invokes the real PrismaStore suite against disposable PostgreSQL 17: 5/5 pass, including authenticated API restart/session/flow/clip persistence, exact version graphs, transactional write failure and orphan sweep. Orchestrator awaits durability before provider effects/SSE; the delayed-disk concurrency test proves five reservations and zero premature originates. Build and 11 Chromium tests pass. Default `npm run test:db` Compose Verify blocked: Docker not installed on host; the same suite passes using installed native Postgres under the task's Docker exception.
Why: The store is in memory. Prisma is not installed, no migrations exist, and `DATABASE_URL` is injected but never read. A restart loses every flow, clip record, and call.
Done when: `@prisma/client` and migrations exist for the schema plus a `FlowVersion` table holding each published graph immutably and `User` and `Session` tables for A7. A `Store` interface has `InMemoryStore` for tests and `PrismaStore` for runtime. The api runs `prisma migrate deploy` on start. Clip records and files stay consistent with an orphan sweep on boot. Active-call snapshots rebuild from the database after restart.
Verify: `npm run test:db` runs the `PrismaStore` suite against the compose Postgres. A flow edited before an api restart is still there after it. `GET /api/flows/:id/versions/:v` returns the exact graph a call ran.

### B2. Logging, metrics, and health
Status: done
Evidence: Simulator `curl /api/health` returns 200 with gateway/esl n/a; fake-ESL NOREG yields503, REGED/coalesced/bounded probes and public metric/error-correlation tests pass; orchestrator publishes call/outcome and accepted-STT metrics after persistence. Build,44 unit tests and11 Chromium tests pass. Compose healthcheck Verify blocked: Docker not installed on host.
Why: One console line on boot, the error handler logs nothing, and health only reflects config presence.
Done when: pino structured logs carry a request id and call id. The error handler logs at error level with the stack. `GET /api/health` reports ESL connectivity and Singtel gateway `REGED` state in freeswitch mode and returns 503 when unregistered. `GET /metrics` exposes active calls, calls by outcome, classifier latency, and STT latency. Compose has a healthcheck for the api. A short alerting doc covers "gateway unregistered" and "call failure rate".
Verify: `curl /api/health` in simulator returns 200 with `gateway: "n/a"`. A health test with a fake ESL returning `NOREG` returns 503.

### B3. Classifier hardening
Status: done
Evidence: `npm run test:classifier` passes 6/6: all 89 distinct fixtures match (including both amended negation cases), the actual SDK against a hanging fake HTTP provider returns rules in approximately 1.51 s with one request and a timeout counter, and cancellation-ignoring/invalid/error providers fall back once; classifier latency and configured model propagation are verified. Build and full unit suite pass. `server/classifier.ts` uses the env-backed 1500 ms default AbortSignal deadline and zero retries; `docs/classifier.md` records behavior. No external OpenAI request or live-mode check was made.
Why: The OpenAI call has no timeout, so a slow API leaves the callee in silence. The rules are English-only and order-sensitive.
Done when: The OpenAI classify call uses `AbortSignal.timeout(MKTR_CLASSIFIER_TIMEOUT_MS)` (default 1500) with rules fallback and a fallback counter in metrics. Rules cover Singapore English ("can", "can lah", "ok can", "later", "no need", "don't want", "not free", "busy now") with negation handled before the positive match, so "don't call me back" and "no, call me later" are `not_interested` and `callback` respectively. A fixture file of at least 60 transcripts with expected intents drives a unit test, including the audit's misclassified cases. The model id comes from env.
Verify: The classifier fixture test passes at 100 percent on rules. A timeout test with a hanging fake provider returns the rules result within 2 s.

### B4. Validation and media pipeline
Status: done
Evidence: 2026-09-11: build/unit suites, all 14 Chromium tests and the native PostgreSQL suite pass; `44.1 kHz stereo MP3 upload keeps its preview and produces probed 8 kHz mono 16-bit WAV` verifies canonical codec/rate/channels/duration plus byte-identical original preview and replacement of a supplied 123-second hint. HTTP tests prove malformed flow/text-WAV rejection, multer 400/413, immutable-version archival after flow deletion, unreferenced-file deletion and interrupted-upload quarantine.
Why: Flow save stores the raw body, clip duration is client-supplied, and MP3 may not play in FreeSWITCH.
Done when: zod schemas validate `FlowDefinition` on PUT. Upload checks magic bytes, probes duration server-side, and transcodes every upload to 8 kHz mono 16-bit WAV for FreeSWITCH while keeping the original for preview. `DELETE /api/clips/:id` archives a clip referenced by a published version and deletes otherwise. `DELETE /api/flows/:id` exists. multer errors map to 400 or 413.
Verify: An e2e test uploads a 44.1 kHz stereo MP3 and asserts the FreeSWITCH file is 8 kHz mono WAV with duration within 1 s of the probe. Text bytes named `.wav` are rejected with 400. A supplied duration that disagrees with the probe is replaced by the probed value. A malformed flow PUT returns 400.


### B5. SSE robustness
Status: done
Evidence: 2026-09-11 `npm run test:e2e:restart` passes: a real simulator API process is killed and restarted against disposable native PostgreSQL 17; its authenticated console refetches/reconnects with bootstrap polling blocked, and two browser contexts both show one active call then zero. The same test observes the real 15-second comment heartbeat and event ID; `server/sse.test.ts` verifies current-snapshot reconnect and subscription cleanup. Caddy has immediate event flushing and no-buffer headers; Vite forwards abrupt upstream disconnects. `npm run build`, `npm test` (35/35), and isolated `npm run test:e2e` (11/11) pass. No real call or live gateway check was run.
Why: No heartbeat, no reconnect, and the capacity meter reflects only this browser's calls.
Done when: The server sends a comment ping every 15 s and an `id:` per event. The client resyncs with `Last-Event-ID` or refetches the call on reconnect. Trunk capacity stays accurate across operators through a bootstrap refresh or a shared stream. The Caddy config disables buffering for `/api/calls/*/events`.
Verify: An e2e test restarts the api mid-call and confirms the console recovers. Two browser contexts show the same active count.

### B6. Delivery hygiene
Status: blocked
Evidence: 2026-09-11 implementation complete: `npm run build`, 20 behavioural unit tests via `npm run test:coverage` (84.95% lines on this worktree), and `npm run test:backup` pass with real PostgreSQL 17.10 row/clip restoration plus nonempty-target/checksum rejection; `.github/workflows/ci.yml`, non-root direct-Node Dockerfile and `docs/backups.md` exist. Verification blockers: no GitHub remote/default-branch CI run is configured; Docker-dependent container UID/build/compose verification is blocked: Docker not installed on host. Main A2 supplies fake ESL/parser coverage.
Why: No git repo, no CI, a root container with npm as PID 1, a default Postgres password, no backups, and thin unit coverage.
Done when: The folder is a git repo with CI running typecheck, unit, e2e on Chromium, and `docker build`. `engines.node` is pinned. The Dockerfile uses a non-root user, a `HEALTHCHECK`, `CMD ["node", ...]`, and excludes test files. The Postgres password comes from env. `scripts/backup.sh` backs up the database and clip volume with a documented restore. Unit tests cover flow validation, route selection, uploads, the ESL frame parser, and auth middleware.
Verify: CI is green on the default branch. `docker run --rm <image> id -u` is not 0. The restore drill is documented and has been run once.


## Tier C. Before real campaigns

### C1. Contacts, campaigns, and dialer
Status: done
Evidence: Merged build, 72 unit tests, 16 Chromium tests and 6 native PostgreSQL assertions pass; campaign tests prove pacing/shared capacity, Singapore hours, bounded busy/no-answer retry, pause/stop and three simulated contacts completing. The HTTP/fake-ESL test also deletes the current flow after republishing and verifies the dial still uses its pinned v3, with durable campaign/contact IDs and rejection of mismatched metadata. Verified against fake ESL and simulator only. Docker-dependent DB Verify remains blocked: Docker not installed on host.
Why: The only way to place a call is typing one number into a test console.
Done when: `Contact`, `Campaign`, and `CampaignContact` models exist. CSV import normalises to E.164. A dialer service paces against `MKTR_MAX_CONCURRENT_CALLS`, respects per-campaign calling hours (default Monday to Saturday 09:00 to 20:00 Singapore time), applies a retry policy for no-answer and busy, and caps attempts per contact. The UI can start, pause, and stop a campaign and shows live progress.
Verify: Dialer unit tests cover pacing and hours. An e2e campaign of three simulated contacts completes with outcomes recorded.

### C2. PDPA Do Not Call check and consent record
Status: done
Evidence: Build, 79 unit tests, 7 native PostgreSQL assertions, 18 Chromium tests and the real simulator API restart test pass. Consent tests prove zero originates for absent/expired/negative/future evidence, voice withdrawal overrides clearance, old evidence cannot erase refusals, and withdrawal/shutdown while ESL is busy cancels queued originates at the socket. Browser tests show the no-consent skip and explicit consent/opt-out entry; append-only records survive restart. DNC clearance expires after 21 days per current PDPC rules; real evidence/account actions remain operator-only.
Why: Marketing voice calls to Singapore numbers need a Do Not Call Registry check unless there is clear consent per number.
Done when: Every dial is gated by a consent-or-DNC check: a stored consent record with source and timestamp, or a DNC Registry result cached for at most 30 days. Numbers that fail are skipped and logged. The UI shows why a contact was skipped. A compliance note states the legal basis relied on.
Verify: A unit test proves a contact without consent and without fresh DNC clearance cannot be dialled. The simulator shows the skip reason.

### C3. Outcomes, recording, and export
Status: done
Evidence: Build, 92 unit tests, 19 Chromium tests and 8 native PostgreSQL assertions pass. Fake-ESL tests verify answer-time AMD/recording, voicemail and hangup-cause outcomes, delayed/unconfirmed hangups and no-speech race protection; temporary-file purge removes expired/orphan audio and keeps active audio. CSV browser download contains exactly one row per call; signed outbox retries preserve ID/body and persist attempts across restart with an eight-attempt cap. Docker-dependent volume/build/config Verify blocked: Docker not installed on host. Verified against fake ESL and fake STT; real AMD/recording/provider quality remains in the runbook.
Why: No answering-machine detection, no busy or no-answer outcomes, no recording, and no export.
Done when: Answering-machine detection on answer produces a `voicemail` outcome. Hangup causes map to `busy`, `no_answer`, or `failed`. Optional session recording has a retention period and a purge job. A signed outcome webhook and a CSV export exist per campaign. Outcomes appear in call history.
Verify: Unit tests cover cause mapping. An e2e export produces one CSV row per call.

### C4. Editor completeness
Status: todo
Evidence: 2026-09-11 browser probes: clicking Event logs, Settings, or Help leaves the flow editor visible; retry inspector offers only Name, Audio clip, and Note. New-flow HTTP response contains 12 cloned demo nodes and delete endpoints return 404. `src/App.tsx:156,169,170` has no navigation handlers and `server/store.ts:209` clones the demo; the required deletion/counter/navigation e2e tests are absent from the passing 10-test browser suite.
Why: Clips and flows cannot be deleted, the retry node has no counter, and three navigation buttons do nothing.
Done when: The UI can delete or archive clips and flows. The retry node exposes `maxAttempts`. The Event logs view shows recent log lines for a call. Settings shows telephony and classifier config read-only. Help links to the runbook. New flows start from a minimal start-to-end template rather than a clone of the demo flow.
Verify: e2e tests cover delete flow, the retry counter in the inspector, and the three navigation views rendering.

### C5. Inbound callbacks to the caller-ID pool
Status: todo
Evidence: 2026-09-11 filesystem/source audit: `telephony/freeswitch/` has only two templates and the cert placeholder, with no inbound dialplan, callback clip/recording flow, or inbound_callback logging; no Singtel ticket/confirmation is recorded. Loopback verification is not verifiable here because Docker/fs_cli and an isolated FreeSWITCH test setup are absent. After implementation, the operator must run the isolated fs_cli loopback check and obtain/link Singtel inbound-routing confirmation or a support ticket; no real call or Singtel contact was made.
Why: Callees who ring back a caller-ID number reach nothing, and Singtel CPaaS inbound routing is unresolved.
Done when: A FreeSWITCH dialplan answers inbound INVITEs for `+6562773211` to `+6562773219`, plays a configurable clip, optionally records a message, and logs an `inbound_callback` call. Singtel CPaaS inbound routing to the gateway is confirmed, or documented as blocked with the support ticket reference.
Verify: A `fs_cli` loopback originate exercises the inbound dialplan. The Singtel ticket or confirmation is linked in Evidence.
