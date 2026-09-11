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
Evidence: `npm run test:media` passes 31 loopback/fake-STT/Deepgram-wire tests, including one receipt per utterance, retries after audio closure, provider lifecycle failures and bounded audio capacity. GitHub CI34569980907 passes the worker image build, resolved Compose healthcheck and actual healthy non-root container startup. Verified against fake ESL and fake STT; real provider/Singtel media remains in the operator runbook.
Why: In FreeSWITCH mode nothing ever calls the answered or transcript webhooks, so a live call parks forever.
Done when: A separate `media-worker` process receives callee audio from FreeSWITCH (mod_audio_stream or mod_audio_fork over WebSocket, 8 kHz mono linear16), streams it to a speech-to-text provider behind a `SpeechToText` interface, detects end of utterance (provider endpointing or 750 ms of silence), and POSTs `/api/calls/:id/transcript` with the bearer token. Listen windows open only while the orchestrator is in `listening`. The provider is selected by env and one real provider is implemented. The worker has its own Dockerfile and compose service.
Verify: `npm run test:media` runs the worker against a fake WebSocket audio source and a stubbed provider and asserts one transcript POST per utterance. `docker compose config` shows the worker service with a healthcheck.

### A2. Persistent ESL event client
Status: done
Evidence: GitHub CI34569980907 passes all 99 unit tests, including persistent ESL auth, fragmented byte-counted frames, -ERR replies, reconnect/resubscribe, originate failure, remote hangup slot release, PLAYBACK_STOP progression and exactly one provider hangup on completion. Build and 24 Chromium tests pass. Verified against fake ESL and fake STT; no real channel was opened.
Why: The adapter opens a socket per command and never listens for events. Originate failures, answers, hang-ups, and playback completion are all invisible, and a hung-up call keeps its trunk slot forever.
Done when: One persistent, auto-reconnecting ESL connection subscribes to `BACKGROUND_JOB`, `CHANNEL_ANSWER`, `CHANNEL_HANGUP_COMPLETE`, and `PLAYBACK_STOP`, matched by `origination_uuid`. The originate job result moves the session to `dialing`, `ringing`, or `failed` with the hangup cause. `CHANNEL_ANSWER` triggers the orchestrator's answered path so the webhook is optional. `CHANNEL_HANGUP_COMPLETE` ends the session and frees the slot. Clip playback advances on `PLAYBACK_STOP`, not on a timer; the timer path remains only for the simulator. Reaching an end node, a flow failure, or a "no route" error hangs up the channel with `uuid_kill`; today only the operator's stop button does, so a completed live call stays parked and billing.
Verify: `npm test` includes a fake ESL server covering the auth handshake, event frames with `Content-Length` bodies, `-ERR` replies, and reconnect after socket close. A test emits `CHANNEL_HANGUP_COMPLETE` for an active call and asserts `activeCallCount()` drops by one. A test runs a flow to its end node with a fake adapter and asserts exactly one hangup command.

### A3. Timeouts and loop caps
Status: done
Evidence: GitHub CI34569980907 passes all 99 unit tests, including the six-second default listen deadline, silence fallback, repeated-listen retry cap, uncapped-loop publish rejection, unanswered/answered deadlines and fake-ESL originate variables; build and both Compose configurations pass. Provider timer behavior is verified against fake ESL and fake STT; real timers remain an operator check.
Why: A silent callee leaves the call in `listening` forever, the retry node has no counter, and nothing caps call length.
Done when: Listen nodes have a configurable no-speech timeout (default 6 s) that routes to the fallback edge. Every originate sets `originate_timeout` (default 30 s) and `execute_on_answer=sched_hangup +MKTR_MAX_CALL_SECONDS` (default 180). Retry nodes carry `maxAttempts` (default 1) enforced by the orchestrator. Flow validation rejects a graph where a retry can re-enter a listen node without a counter.
Verify: Unit tests for each timeout and cap, plus a `validateFlow` test for an uncapped retry loop.

### A4. FreeSWITCH configuration that registers with Singtel
Status: done
Evidence: 11 Sep 2026 on droplet mktr-voice (159.65.14.135, Singtel-whitelisted): `sofia status gateway singtel` shows State REGED and Status UP over TLS to sipsg01.b3networks.com:5061, `openssl s_client` verifies the chain against the supplied Sectigo bundle (return code 0), `sofia status profile external` advertises 159.65.14.135 with TLS bound on 5061, and mod_audio_stream and mod_avmd are loaded. Two template defects surfaced on the real host and are fixed with guards in `server/freeswitch-config.test.ts`: the gateways include must sit on its own line because FreeSWITCH drops the rest of an X-PRE-PROCESS line, and avmd `report_status` must be 1 so `avmd start` replies +OK over ESL. First live outbound call completed end to end at 08:01 UTC. Earlier CI image build: https://github.com/slzwei/mktr-bot/actions/runs/34569980870.
Why: TLS is off on the default external profile, the CA file name is wrong for FreeSWITCH, the RTP range is mismatched three ways, and a bridge-network container advertises its private IP.
Done when: The repo ships a complete `telephony/freeswitch/conf` overlay mounted into the container: `vars.xml` with `external_ssl_enable=true`; the external profile with `tls`, `tls-only`, `tls-sip-port 5061`, `tls-verify-policy`, and `tls-cert-dir=/etc/freeswitch/tls` where the Singtel CA is installed as `cafile.pem`; `switch.conf.xml` with `rtp-start-port=10000` and `rtp-end-port=30000` or a documented narrower slice exposed identically in compose; `ext-sip-ip` and `ext-rtp-ip` taken from `MKTR_GATEWAY_PUBLIC_IP`, or `network_mode: host` for the FreeSWITCH service; gateway `singtel` using PCMA, `rtp-secure-media`, and RFC2833. The image tag is verified pullable or replaced with a documented build. `npm run render:freeswitch` renders the gateway XML from env without committing secrets.
Verify: `docker compose --profile live config` validates. On a host with credentials, `fs_cli -x "sofia status gateway singtel"` shows `REGED` and `sofia status profile external` shows TLS on 5061 (operator step, recorded in the runbook).

### A5. ESL lockdown
Status: done
Evidence: GitHub CI34569980907 validates docker compose --profile live config and test:containers asserts no published 8021 port in its resolved JSON. All 99 unit tests pass, including weak/default/framed ESL password rejection and rendered private-interface /32 ACL rules. Startup-rendered credentials and private ESL access remain enforced; no real ESL socket was opened.
Why: FreeSWITCH still uses the default `ClueCon` password and compose publishes port 8021 to the host. Anyone who reaches it can originate calls on the trunk.
Done when: `event_socket.conf.xml` in the overlay takes its password from `MKTR_FREESWITCH_ESL_PASSWORD` at start, `listen-ip` is the container network interface only, `apply-inbound-acl` restricts access to the api and media-worker services, and the `8021` port mapping is removed from compose. The api refuses to start in freeswitch mode if the password is `ClueCon` or shorter than 16 characters.
Verify: `docker compose --profile live config` shows no published 8021 port. A config test asserts the weak-password guard.

### A6. Graceful shutdown and orphan reconciliation
Status: done
Evidence: GitHub CI34569980907 passes the SIGTERM test with two active fake channels and exactly two uuid_kill commands, boot/reconnect orphan reconciliation, and actual docker stop checks: API exits 0 in 90 ms and media worker exits 0 in 71 ms, before the 10-second kill deadline. Both images run non-root Node as PID 1; Compose grants 20 seconds. No real channel was used.
Why: An API restart mid-call leaves a parked billable channel on the Singtel trunk with nothing to hang it up.
Done when: A SIGTERM and SIGINT handler stops accepting requests, hangs up every active `providerCallId`, closes SSE streams, and exits within the compose `stop_grace_period`. On boot in freeswitch mode the api runs `show channels` and kills any channel with `origination_caller_id_name=MKTR` that the store does not know. The Dockerfile runs node directly or via tini, not `npm run start`.
Verify: A test sends SIGTERM with two active fake calls and asserts two `uuid_kill` commands. `docker stop` completes without the 10 s kill.

### A7. Authentication, HTTPS, and API hardening
Status: done
Evidence: GitHub CI34569980907 passes all 99 unit tests and 24 Chromium tests, including auth/CORS/session/role/rate-limit/errors and seeded-admin browser login. Actual production API container rejects unauthenticated calls with 401, signs in the generated admin with Secure/HttpOnly cookies and serves authenticated bootstrap; both Compose configurations pass. Real Caddy certificate issuance remains an operator-host check.
Why: Every control-plane route is open and CORS allows any origin. In live mode anyone reaching the port can dial from MKTR caller IDs.
Done when: Operators sign in with email and password (argon2id) seeded from env. Sessions are httpOnly secure cookies. Call start, publish, upload, and flow writes require an authenticated operator, and changing telephony mode requires the `admin` role. CORS is restricted to `MKTR_WEB_ORIGIN`. Security headers are set. `POST /api/calls` is rate limited. `trust proxy` is set. Compose adds a Caddy service terminating TLS for the UI and API. The webhook token comparison is timing-safe. The error handler logs internals and returns generic messages for 500s.
Verify: A supertest suite asserts unauthenticated `POST /api/calls` returns 401 and a wrong-origin preflight is rejected. The Playwright login flow passes.


### A8. First-live-call runbook
Status: done
Evidence: Runbook executed by Shawn on 11 Sep 2026 against mktr-voice (see `docs/deployment-mktr-voice.md`): prerequisites closed, `npm run verify:runbook` passed on the host, gateway REGED, mode switched to freeswitch with limits 1 call, 60 s cap, 30 s originate, consent recorded for the single approved destination (Shawn's own mobile), and two live calls (call IDs 4ff551b6 and 37e5c122) ran answer, greeting, transcript ("Yes.", 1.8 s after speech), classified interested at 88 percent, Interested clip, Flow completed, with zero channels left and capacity back to 0 of 1. One media defect surfaced and is fixed with a test in `media-worker/deepgram.test.ts`: Deepgram UtteranceEnd and SpeechStarted carry `channel` as an index array.
Why: The first real call is the riskiest step and is done by the operator, not the agent.
Done when: `docs/runbook-first-live-call.md` lists the prerequisites (A1 to A7 done, Singtel whitelist confirmed for the gateway public IP), the single approved test destination, caller ID `+6562773211`, the rule that `+6562773210` is never used, `MKTR_MAX_CONCURRENT_CALLS=1` and a 60 s max call for the test, how to watch `fs_cli` and api logs, the abort command, and rollback to simulator mode.
Verify: Every command in the runbook has been run in dry form (no credentials) by the agent. The operator has reviewed it.

## Tier B. Before running it as a service

### B1. Durable store on Postgres
Status: done
Evidence: Published implementation eb9a4d3. GitHub CI34569980907 runs npm run test:db against disposable Compose PostgreSQL 16: eight tests pass, including authenticated API restart/session/flow/clip persistence, immutable versions, transactional failure, campaign state, append-only consent and durable webhook attempts. The same Prisma suite passes on native PostgreSQL 17. Migrations also run successfully during actual API container startup; delayed-disk tests prove no provider effects before persistence.
Why: The store is in memory. Prisma is not installed, no migrations exist, and `DATABASE_URL` is injected but never read. A restart loses every flow, clip record, and call.
Done when: `@prisma/client` and migrations exist for the schema plus a `FlowVersion` table holding each published graph immutably and `User` and `Session` tables for A7. A `Store` interface has `InMemoryStore` for tests and `PrismaStore` for runtime. The api runs `prisma migrate deploy` on start. Clip records and files stay consistent with an orphan sweep on boot. Active-call snapshots rebuild from the database after restart.
Verify: `npm run test:db` runs the `PrismaStore` suite against the compose Postgres. A flow edited before an api restart is still there after it. `GET /api/flows/:id/versions/:v` returns the exact graph a call ran.

### B2. Logging, metrics, and health
Status: done
Evidence: GitHub CI34569980907 passes simulator HTTP health with gateway/esl n/a, fake-ESL NOREG yielding 503, bounded/coalesced REGED probes, public metrics and error-correlation tests. Resolved Compose includes API/worker healthchecks, and both built containers become healthy. Pino call/request correlation and persisted outcome/STT metrics are implemented; actual carrier readiness remains unverified.
Why: One console line on boot, the error handler logs nothing, and health only reflects config presence.
Done when: pino structured logs carry a request id and call id. The error handler logs at error level with the stack. `GET /api/health` reports ESL connectivity and Singtel gateway `REGED` state in freeswitch mode and returns 503 when unregistered. `GET /metrics` exposes active calls, calls by outcome, classifier latency, and STT latency. Compose has a healthcheck for the api. A short alerting doc covers "gateway unregistered" and "call failure rate".
Verify: `curl /api/health` in simulator returns 200 with `gateway: "n/a"`. A health test with a fake ESL returning `NOREG` returns 503.

### B3. Classifier hardening
Status: done
Evidence: All six classifier tests pass in GitHub CI34569980907: all 89 distinct Singapore-English fixtures match, including both amended negation cases; the actual SDK against a hanging fake HTTP provider returns rules within two seconds with one request and a timeout counter. Invalid/error/cancellation-ignoring providers fall back once; model propagation and the env-backed 1500 ms deadline are verified. No external OpenAI request was made.
Why: The OpenAI call has no timeout, so a slow API leaves the callee in silence. The rules are English-only and order-sensitive.
Done when: The OpenAI classify call uses `AbortSignal.timeout(MKTR_CLASSIFIER_TIMEOUT_MS)` (default 1500) with rules fallback and a fallback counter in metrics. Rules cover Singapore English ("can", "can lah", "ok can", "later", "no need", "don't want", "not free", "busy now") with negation handled before the positive match, so "don't call me back" and "no, call me later" are `not_interested` and `callback` respectively. A fixture file of at least 60 transcripts with expected intents drives a unit test, including the audit's misclassified cases. The model id comes from env.
Verify: The classifier fixture test passes at 100 percent on rules. A timeout test with a hanging fake provider returns the rules result within 2 s.

### B4. Validation and media pipeline
Status: done
Evidence: GitHub CI34569980907 passes the 44.1 kHz stereo MP3 browser upload check: original preview bytes retained, canonical 8 kHz mono 16-bit WAV probed, and supplied 123-second duration replaced. HTTP tests reject text-WAV/malformed flows, map multer 400/413, retain immutable-version audio, delete unreferenced files and quarantine interrupted uploads. Build, 99 unit tests, 24 Chromium tests and eight Compose PostgreSQL tests pass.
Why: Flow save stores the raw body, clip duration is client-supplied, and MP3 may not play in FreeSWITCH.
Done when: zod schemas validate `FlowDefinition` on PUT. Upload checks magic bytes, probes duration server-side, and transcodes every upload to 8 kHz mono 16-bit WAV for FreeSWITCH while keeping the original for preview. `DELETE /api/clips/:id` archives a clip referenced by a published version and deletes otherwise. `DELETE /api/flows/:id` exists. multer errors map to 400 or 413.
Verify: An e2e test uploads a 44.1 kHz stereo MP3 and asserts the FreeSWITCH file is 8 kHz mono WAV with duration within 1 s of the probe. Text bytes named `.wav` are rejected with 400. A supplied duration that disagrees with the probe is replaced by the probed value. A malformed flow PUT returns 400.


### B5. SSE robustness
Status: done
Evidence: GitHub CI34569980907 passes npm run test:e2e:restart: an actual simulator API is killed and restarted with durable PostgreSQL state; the authenticated console reconnects with polling blocked, two browser contexts agree on active count, and a real 15-second heartbeat/event ID is observed. SSE public tests verify current-snapshot reconnect and cleanup; Caddy immediate flushing and Vite disconnect forwarding are configured.
Why: No heartbeat, no reconnect, and the capacity meter reflects only this browser's calls.
Done when: The server sends a comment ping every 15 s and an `id:` per event. The client resyncs with `Last-Event-ID` or refetches the call on reconnect. Trunk capacity stays accurate across operators through a bootstrap refresh or a shared stream. The Caddy config disables buffering for `/api/calls/*/events`.
Verify: An e2e test restarts the api mid-call and confirms the console recovers. Two browser contexts show the same active count.

### B6. Delivery hygiene
Status: done
Evidence: Default-branch CI is green: https://github.com/slzwei/mktr-bot/actions/runs/34569980907 at c1e2c11 passes build/typecheck, 99 unit tests (94.37% aggregate line coverage), 31 media tests, eight Compose PostgreSQL 16 tests, backup/restore, 24 Chromium tests, restart recovery, both Compose configurations and API/worker builds. docker run id -u is nonzero; actual containers run non-root Node PID 1, migrate, become healthy, authenticate and stop cleanly in 90/71 ms. docs/backups.md records the successful native PostgreSQL 16/17 restore drills.
Why: No git repo, no CI, a root container with npm as PID 1, a default Postgres password, no backups, and thin unit coverage.
Done when: The folder is a git repo with CI running typecheck, unit, e2e on Chromium, and `docker build`. `engines.node` is pinned. The Dockerfile uses a non-root user, a `HEALTHCHECK`, `CMD ["node", ...]`, and excludes test files. The Postgres password comes from env. `scripts/backup.sh` backs up the database and clip volume with a documented restore. Unit tests cover flow validation, route selection, uploads, the ESL frame parser, and auth middleware.
Verify: CI is green on the default branch. `docker run --rm <image> id -u` is not 0. The restore drill is documented and has been run once.


## Tier C. Before real campaigns

### C1. Contacts, campaigns, and dialer
Status: done
Evidence: GitHub CI34569980907 passes pacing/shared-capacity, Singapore-hours, bounded busy/no-answer retries, pause/stop and the three-contact simulator browser campaign. HTTP/fake-ESL tests prove a campaign retains its pinned graph after republish/current-flow deletion and rejects mismatched metadata; eight Compose PostgreSQL 16 tests establish durable campaign/contact state. No real campaign was started.
Why: The only way to place a call is typing one number into a test console.
Done when: `Contact`, `Campaign`, and `CampaignContact` models exist. CSV import normalises to E.164. A dialer service paces against `MKTR_MAX_CONCURRENT_CALLS`, respects per-campaign calling hours (default Monday to Saturday 09:00 to 20:00 Singapore time), applies a retry policy for no-answer and busy, and caps attempts per contact. The UI can start, pause, and stop a campaign and shows live progress.
Verify: Dialer unit tests cover pacing and hours. An e2e campaign of three simulated contacts completes with outcomes recorded.

### C2. PDPA Do Not Call check and consent record
Status: done
Evidence: GitHub CI34569980907 passes absent/expired/negative/future-evidence gates, voice-withdrawal precedence and queued-originate cancellation while ESL is busy. Chromium shows explicit consent/opt-out entry and no-consent skip reasons; append-only evidence survives real PostgreSQL restart. DNC clearance expires after 21 days per the documented PDPC basis; actual consent, Registry account and carrier actions remain operator-only.
Why: Marketing voice calls to Singapore numbers need a Do Not Call Registry check unless there is clear consent per number.
Done when: Every dial is gated by a consent-or-DNC check: a stored consent record with source and timestamp, or a DNC Registry result cached for at most 30 days. Numbers that fail are skipped and logged. The UI shows why a contact was skipped. A compliance note states the legal basis relied on.
Verify: A unit test proves a contact without consent and without fresh DNC clearance cannot be dialled. The simulator shows the skip reason.

### C2a. Confirmed Singapore DNC batch checks at contact import
Status: done
Evidence: Local `npm run lint`, `npm test` (115/115, including 15 fake-gateway DNC tests), `npm run build` and `npx playwright install chromium && npm run test:e2e` (28/28) pass. `npm run test:db:local` passes 9/9, including S000 JSON evidence and append-only enforcement across restart. Tests prove zero writes for non-S000/partial replies, disabled import compatibility, confirmed credit limits and selectable registered-row UI; preview/permission screenshots were inspected. Compose YAML/default-off wiring checked; Docker unavailable. No live Registry/gateway/call; provisioning and activation remain operator-only.
Why: Typing Registry evidence one number at a time makes imports slow and hides the cost and permission state of a campaign audience.
Done when: Disabled-by-default checking through the mktr-platform gateway batches only eligible new Singapore numbers in groups of 100 after a durable import; a free shared-parser preview and explicit credit cap precede every paid import, and a stated one-credit action supports individual checks. Only complete S000 batches append voice-register evidence with receipt timestamps and all Registry metadata. Failed checks preserve imports, expose status/cause and never retry automatically. Aggregate permission rows, expiry warnings and campaign summaries use the existing ConsentPolicy; manual paths, the 21-day limit and dial gate remain intact. Configuration names, the built contract, compliance note and implementation decisions ship with the code.
Verify: `npm run lint`, `npm test`, `npm run build` and `npx playwright install chromium && npm run test:e2e` pass against fake providers. DNC tests cover 100/101 chunking, zero-spend coverage, non-S000 and incomplete replies writing no evidence, voice/text distinctions, disabled import compatibility, unreachable-gateway import survival, preview/credit limits and session-protected summaries. Chromium proves credits are visible before spending and registered contacts are visibly blocked but selectable. `npm run test:db:local` verifies the additional JSON evidence survives restart without a migration.

### C3. Outcomes, recording, and export
Status: done
Evidence: GitHub CI34569980907 passes fake-ESL answer-time AMD/recording, cause/outcome mapping, delayed hangups and no-speech races; temporary-file retention checks, one-row-per-call CSV export and durable signed outbox retries also pass. Compose and all three image builds are verified (gateway run34569980870). Verified against fake ESL and fake STT; real detection, recording audio, deployment recording-volume use and external webhook receipt remain operator checks.
Why: No answering-machine detection, no busy or no-answer outcomes, no recording, and no export.
Done when: Answering-machine detection on answer produces a `voicemail` outcome. Hangup causes map to `busy`, `no_answer`, or `failed`. Optional session recording has a retention period and a purge job. A signed outcome webhook and a CSV export exist per campaign. Outcomes appear in call history.
Verify: Unit tests cover cause mapping. An e2e export produces one CSV row per call.

### C4. Editor completeness
Status: done
Evidence: GitHub CI34569980907 passes all 24 Chromium tests, including tests/editor.spec.ts for minimal Start→End drafts, publish/delete with immutable history, retry-counter persistence, clip delete/archive, Event logs, read-only Settings, authenticated Help and empty-workspace navigation. Campaigns, permission controls, exports and shared capacity remain integrated; build and all 99 unit tests pass.
Why: Clips and flows cannot be deleted, the retry node has no counter, and three navigation buttons do nothing.
Done when: The UI can delete or archive clips and flows. The retry node exposes `maxAttempts`. The Event logs view shows recent log lines for a call. Settings shows telephony and classifier config read-only. Help links to the runbook. New flows start from a minimal start-to-end template rather than a clone of the demo flow.
Verify: e2e tests cover delete flow, the retry counter in the inspector, and the three navigation views rendering.

### C5. Inbound callbacks to the caller-ID pool
Status: blocked
Evidence: Implementation and all 99 unit/24 Chromium tests pass; the 12 inbound/config tests cover five callbacks sharing the ceiling and draining with five UUID kills while bypassing outbound playback/AMD. Both Compose configurations and complete gateway image build34569980870 pass. Missing operational Verify: private fs_cli results from a running isolated FreeSWITCH loopback test, plus actual Singtel inbound-routing confirmation or a support-ticket reference. No gateway process, carrier contact or real call occurred.
Why: Callees who ring back a caller-ID number reach nothing, and Singtel CPaaS inbound routing is unresolved.
Done when: A FreeSWITCH dialplan answers inbound INVITEs for `+6562773211` to `+6562773219`, plays a configurable clip, optionally records a message, and logs an `inbound_callback` call. Singtel CPaaS inbound routing to the gateway is confirmed, or documented as blocked with the support ticket reference.
Verify: A `fs_cli` loopback originate exercises the inbound dialplan. The Singtel ticket or confirmation is linked in Evidence.
