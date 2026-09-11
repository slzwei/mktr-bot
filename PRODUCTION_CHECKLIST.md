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
Status: todo
Evidence: 2026-09-11 audit of `5569e38`: `npm run test:media` exits 1 with `Missing script: "test:media"`; `media-worker/`, the SpeechToText interface/provider, audio WebSocket handling, and worker compose service/healthcheck are absent. `docker compose config --quiet` cannot run: `env: docker: No such file or directory`. No fake-STT verification exists.
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
Status: todo
Evidence: 2026-09-11 public-interface probes: a silent second listen remains `listening` with one active call after 6.3 s; `validateFlow` accepts start -> listen -> retry -> listen without a counter (`valid: true`). `server/telephony.ts:50` lacks originate/answer hangup deadlines, and `src/lib/domain.ts:30` lacks timeout/maxAttempts fields. Required timeout/cap unit tests are absent from the passing 4-test suite.
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
Status: todo
Evidence: 2026-09-11 audit: `docker-compose.yml:67` still publishes `8021:8021/tcp`; no event_socket/ACL overlay or password rendering exists, and `server/config.ts:45` checks password presence rather than rejecting weak values. The weak-password config test is absent. Live-profile config inspection is unavailable because Docker is missing; install Docker/Compose and implement the overlay/guard/test before rerunning this credential-free verification. The image's actual runtime password was not verified.
Why: FreeSWITCH still uses the default `ClueCon` password and compose publishes port 8021 to the host. Anyone who reaches it can originate calls on the trunk.
Done when: `event_socket.conf.xml` in the overlay takes its password from `MKTR_FREESWITCH_ESL_PASSWORD` at start, `listen-ip` is the container network interface only, `apply-inbound-acl` restricts access to the api and media-worker services, and the `8021` port mapping is removed from compose. The api refuses to start in freeswitch mode if the password is `ClueCon` or shorter than 16 characters.
Verify: `docker compose --profile live config` shows no published 8021 port. A config test asserts the weak-password guard.

### A6. Graceful shutdown and orphan reconciliation
Status: todo
Evidence: 2026-09-11 audit: `server/index.ts:188` starts without SIGTERM/SIGINT shutdown or boot channel reconciliation, compose has no stop_grace_period, and `Dockerfile:24` runs npm. A public orchestrator probe with a fake simulated adapter completed a flow with `status: ended`, active count 0, and zero provider hangups (`server/orchestrator.ts:437`). The two-call SIGTERM/uuid_kill test is absent; docker stop timing is not verifiable without Docker and a built isolated test container.
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
Status: todo
Evidence: 2026-09-11 filesystem audit: `docs/runbook-first-live-call.md` is absent; README live steps do not provide the A1-A7 gate, approved destination, one-call/60-second test limits, monitoring, abort, or rollback procedure. Dry-command verification cannot run against a missing runbook, and operator review is not recorded. After the runbook and prerequisites exist, Shawn must designate the sole approved test destination and review it; test fixture numbers are not that approval.
Why: The first real call is the riskiest step and is done by the operator, not the agent.
Done when: `docs/runbook-first-live-call.md` lists the prerequisites (A1 to A7 done, Singtel whitelist confirmed for the gateway public IP), the single approved test destination, caller ID `+6562773211`, the rule that `+6562773210` is never used, `MKTR_MAX_CONCURRENT_CALLS=1` and a 60 s max call for the test, how to watch `fs_cli` and api logs, the abort command, and rollback to simulator mode.
Verify: Every command in the runbook has been run in dry form (no credentials) by the agent. The operator has reviewed it.

## Tier B. Before running it as a service

### B1. Durable store on Postgres
Status: todo
Evidence: 2026-09-11 disposable simulator restart probe: an edited flow and call both return 404 after restart; the clip record disappears while its orphan file still serves 200; the version-graph endpoint returns 404. Runtime constructs `InMemoryStore` (`server/index.ts:14`); Prisma client/migrations, FlowVersion/User/Session, runtime Store abstraction, and boot recovery are absent. `npm run test:db` exits 1 with Missing script. Full database verification additionally needs Docker/Compose with the test Postgres after implementation.
Why: The store is in memory. Prisma is not installed, no migrations exist, and `DATABASE_URL` is injected but never read. A restart loses every flow, clip record, and call.
Done when: `@prisma/client` and migrations exist for the schema plus a `FlowVersion` table holding each published graph immutably and `User` and `Session` tables for A7. A `Store` interface has `InMemoryStore` for tests and `PrismaStore` for runtime. The api runs `prisma migrate deploy` on start. Clip records and files stay consistent with an orphan sweep on boot. Active-call snapshots rebuild from the database after restart.
Verify: `npm run test:db` runs the `PrismaStore` suite against the compose Postgres. A flow edited before an api restart is still there after it. `GET /api/flows/:id/versions/:v` returns the exact graph a call ran.

### B2. Logging, metrics, and health
Status: todo
Evidence: 2026-09-11 `curl` against the disposable simulator returns HTTP 200 and `{"ok":true,"mode":"simulated","configured":true}`, omitting required `gateway: "n/a"` (`server/index.ts:25`). No ESL registration probe, fake-NOREG/503 test, pino request/call logs, Prometheus metrics, API compose healthcheck, or alerting doc exists; the required health verification therefore does not pass.
Why: One console line on boot, the error handler logs nothing, and health only reflects config presence.
Done when: pino structured logs carry a request id and call id. The error handler logs at error level with the stack. `GET /api/health` reports ESL connectivity and Singtel gateway `REGED` state in freeswitch mode and returns 503 when unregistered. `GET /metrics` exposes active calls, calls by outcome, classifier latency, and STT latency. Compose has a healthcheck for the api. A short alerting doc covers "gateway unregistered" and "call failure rate".
Verify: `curl /api/health` in simulator returns 200 with `gateway: "n/a"`. A health test with a fake ESL returning `NOREG` returns 503.

### B3. Classifier hardening
Status: todo
Evidence: 2026-09-11 RuleClassifier probes return `unknown` for "can", "can lah", "ok can", "later", and "not free", and incorrectly return `callback` for "don't call me back". `server/classifier.ts:41` has no configured abort deadline and fallback has no metric; model selection already comes from env. The 60-transcript fixture and hanging-provider timeout tests are absent, so neither required verification passes.
Why: The OpenAI call has no timeout, so a slow API leaves the callee in silence. The rules are English-only and order-sensitive.
Done when: The OpenAI classify call uses `AbortSignal.timeout(MKTR_CLASSIFIER_TIMEOUT_MS)` (default 1500) with rules fallback and a fallback counter in metrics. Rules cover Singapore English ("can", "can lah", "ok can", "later", "no need", "don't want", "not free", "busy now") with negation handled before the positive match, so "don't call me back" and "no, call me later" are `not_interested` and `callback` respectively. A fixture file of at least 60 transcripts with expected intents drives a unit test, including the audit's misclassified cases. The model id comes from env.
Verify: The classifier fixture test passes at 100 percent on rules. A timeout test with a hanging fake provider returns the rules result within 2 s.

### B4. Validation and media pipeline
Status: todo
Evidence: 2026-09-11 HTTP/media probes: a flow containing an unsupported node type, numeric node ID, and null position returns 200; text bytes labelled WAV upload with 201. A generated 3 s, 44.1 kHz stereo MP3 remains byte-identical MP3 at 44100 Hz/2 channels by ffprobe, while the API accepts a supplied duration of 123 s. DELETE flow/clip returns 404; no published-version archive logic exists and multer errors lack 400/413 mapping (`server/index.ts:173`). Both required validation/transcoding expectations fail.
Why: Flow save stores the raw body, clip duration is client-supplied, and MP3 may not play in FreeSWITCH.
Done when: zod schemas validate `FlowDefinition` on PUT. Upload checks magic bytes, probes duration server-side, and transcodes every upload to 8 kHz mono 16-bit WAV for FreeSWITCH while keeping the original for preview. `DELETE /api/clips/:id` archives a clip referenced by a published version and deletes otherwise. `DELETE /api/flows/:id` exists. multer errors map to 400 or 413.
Verify: An e2e test uploads a 44.1 kHz stereo MP3 and asserts the FreeSWITCH file is 8 kHz mono WAV with duration within 1 s of the probe. Text bytes named `.wav` are rejected with 400. A supplied duration that disagrees with the probe is replaced by the probed value. A malformed flow PUT returns 400.

### B5. SSE robustness
Status: todo
Evidence: 2026-09-11 browser probes: two contexts show `1 of 5` versus `0 of 5` active calls; after restarting the disposable API mid-call, the console remains Queued with no API requests for 7 s and capacity 1 while the server reports 0. A 16.2 s SSE observation has no id or comment ping. `src/components/CallConsole.tsx:59` closes EventSource on error; no Caddy configuration exists. The required reconnect/shared-capacity behavior fails, and no corresponding committed e2e tests exist.
Why: No heartbeat, no reconnect, and the capacity meter reflects only this browser's calls.
Done when: The server sends a comment ping every 15 s and an `id:` per event. The client resyncs with `Last-Event-ID` or refetches the call on reconnect. Trunk capacity stays accurate across operators through a bootstrap refresh or a shared stream. The Caddy config disables buffering for `/api/calls/*/events`.
Verify: An e2e test restarts the api mid-call and confirms the console recovers. Two browser contexts show the same active count.

### B6. Delivery hygiene
Status: todo
Evidence: 2026-09-11 baseline initialized on main as `5569e38`; `npm run build`, `npm test` (4/4), and `npm run test:e2e` (10/10 Chromium) pass. CI/remote, Node engine pin, backups/restore drill, and required auth/ESL/upload/validation unit coverage are absent; Dockerfile has no USER/HEALTHCHECK, runs npm (line 24), and includes compiled tests; compose hard-codes the database password (line 40). CI, container UID, and restore verification cannot pass without implementation, a CI remote/default-branch run, and Docker/Compose, which is absent here.
Why: No git repo, no CI, a root container with npm as PID 1, a default Postgres password, no backups, and thin unit coverage.
Done when: The folder is a git repo with CI running typecheck, unit, e2e on Chromium, and `docker build`. `engines.node` is pinned. The Dockerfile uses a non-root user, a `HEALTHCHECK`, `CMD ["node", ...]`, and excludes test files. The Postgres password comes from env. `scripts/backup.sh` backs up the database and clip volume with a documented restore. Unit tests cover flow validation, route selection, uploads, the ESL frame parser, and auth middleware.
Verify: CI is green on the default branch. `docker run --rm <image> id -u` is not 0. The restore drill is documented and has been run once.

## Tier C. Before real campaigns

### C1. Contacts, campaigns, and dialer
Status: todo
Evidence: 2026-09-11 schema/source audit: `prisma/schema.prisma:33` onward defines only Flow, Clip, Call, and CallEvent; there are no Contact/Campaign/CampaignContact models, CSV importer, paced dialer, calling-hours/retry policy, or campaign controls. The 4 unit and 10 browser tests contain neither dialer/hours cases nor a three-contact campaign e2e; required verification is unavailable until implemented.
Why: The only way to place a call is typing one number into a test console.
Done when: `Contact`, `Campaign`, and `CampaignContact` models exist. CSV import normalises to E.164. A dialer service paces against `MKTR_MAX_CONCURRENT_CALLS`, respects per-campaign calling hours (default Monday to Saturday 09:00 to 20:00 Singapore time), applies a retry policy for no-answer and busy, and caps attempts per contact. The UI can start, pause, and stop a campaign and shows live progress.
Verify: Dialer unit tests cover pacing and hours. An e2e campaign of three simulated contacts completes with outcomes recorded.

### C2. PDPA Do Not Call check and consent record
Status: todo
Evidence: 2026-09-11 simulator HTTP probe starts a call with 201 despite no consent record or fresh DNC clearance; `server/orchestrator.ts:79` originates after caller-ID/format/capacity/published-flow checks only. Consent/DNC storage, expiry/gating, skip reasons/logging, compliance note, and the rejection unit test are absent. The simulator cannot demonstrate the required skip; implementing fake-clearance verification does not require the operator to register a DNC account first.
Why: Marketing voice calls to Singapore numbers need a Do Not Call Registry check unless there is clear consent per number.
Done when: Every dial is gated by a consent-or-DNC check: a stored consent record with source and timestamp, or a DNC Registry result cached for at most 30 days. Numbers that fail are skipped and logged. The UI shows why a contact was skipped. A compliance note states the legal basis relied on.
Verify: A unit test proves a contact without consent and without fresh DNC clearance cannot be dialled. The simulator shows the skip reason.

### C3. Outcomes, recording, and export
Status: todo
Evidence: 2026-09-11 source audit: `server/orchestrator.ts:130` advances directly on answer, and lines 437/447 store generic ended/failed reasons without AMD or hangup-cause mapping. Recording/retention/purge, signed outcome delivery, and campaign CSV export are absent; history only shows generic status/reason. No cause-mapping unit test or one-row-per-call export e2e exists in the passing suites.
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
