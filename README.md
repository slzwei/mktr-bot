# MKTR Voice Control

MKTR Voice Control is an internal call-flow workspace for the Singtel CPaaS SIP trunk. It provides a React Flow canvas for connecting call nodes, a WAV/MP3 clip library, a safe call simulator, live event timelines, and the FreeSWITCH ESL adapter used when live origination is enabled.

The application runs in simulator mode by default. `CALLER_IDS` in `src/lib/domain.ts` supplies the approved caller IDs, and the guard permanently denies the Retell-reserved number. The trunk ceiling is five concurrent calls. Provider behavior is verified against fake ESL and fake STT; real Singtel registration, media and first-call checks remain operator actions.

## Local development

Use Node `24.14.0` and install the locked dependencies:

```bash
npm ci
```

Create a private environment file outside Git containing `MKTR_ADMIN_EMAIL` and a randomly generated `MKTR_ADMIN_PASSWORD` of at least 16 characters. There are no shared default credentials. Set `MKTR_WEB_ORIGIN` to the exact web origin (local default `http://localhost:5173`). `.env.example` is a names-only inventory; fill required values and omit unused optional entries. Set the nonsecret shell variable `MKTR_DEV_ENV` to the absolute path of your private file, then launch through Node's environment-file loader:

```bash
: "${MKTR_DEV_ENV:?Set the absolute private developer env-file path}"
MKTR_TELEPHONY_MODE=simulated MKTR_STORE=memory node --env-file="$MKTR_DEV_ENV" node_modules/concurrently/dist/bin/concurrently.js -n api,web -c cyan,green "npm:dev:api" "npm:dev:web"
```

Node loads the file without evaluating shell commands and passes the values to both development servers. The explicit process overrides keep this launch in simulator mode with disposable memory storage. Plain `npm run dev` requires the same variables to have already been loaded into its environment; it does not automatically load `.env` for the API.

Open <http://localhost:5173> and sign in; API health is at <http://localhost:8787/api/health>. In Campaigns → Voice call permission, record consent or a qualifying DNC result for the selected simulator destination. Then start a test call from a published flow and choose a simulated response to inspect routing, transcript, sentiment and latency. Imported contacts and simulator mode do not bypass the consent gate.

Uploaded clips are stored under `storage/clips` and are intentionally ignored by Git. The explicit local `MKTR_STORE=memory` option resets flows, clip metadata, calls, campaigns, permission records and sessions on restart; files on disk are not a durable substitute for their database records. The default runtime uses Postgres through Prisma with `DATABASE_URL`, applies migrations at startup, preserves immutable published flow versions and restores call snapshots; see [durable store operations](docs/store.md).

In **Audio clips**, drop one WAV or MP3 anywhere in the library, or use the file chooser, then select **Upload clip**. The browser fills the name and a duration hint; the server measures the audio and replaces the supplied duration with the measured value rounded to whole seconds. Files must be 10 MB or smaller and up to 180 seconds long. Preview recordings in the library or in a selected clip node's settings; starting another preview pauses the previous one.

Local upload processing requires `ffmpeg` and `ffprobe` on `PATH`; the production API Dockerfile includes them. Uploads are checked for WAV/MP3 signatures, probed, and decoded into a separate 8 kHz mono 16-bit PCM WAV. `assetUrl` and `previewUrl` retain the exact original for browser preview, while `telephonyAssetUrl` identifies the canonical FreeSWITCH file. Temporary uploads are private and cleaned after success or failure; startup reconciliation quarantines files left by an interrupted upload. Invalid audio returns 400 and files over 10 MB return 413.

The **Campaigns** screen imports contacts from CSV, pins a published flow and approved caller ID, and starts, pauses or stops paced campaigns with live progress. Default hours are Monday–Saturday 09:00–20:00 Singapore time; busy/no-answer retries are bounded per contact. Contacts, campaigns, membership and attempts persist through Prisma. See [campaign operations](docs/campaigns.md) for import rules, retry settings and restart behavior. CSV data alone grants no permission. Optional [batch Registry checking](docs/dnc-batch-checking.md) ships disabled; when enabled, a free preview states the credit count before import and complete S000 responses automatically record Singapore voice results. Contact rows and campaign detail show current permission and blocking reasons.

Campaigns export one CSV row per call attempt and show normalized outcomes in history. Administrators can configure a signed outcome webhook on a server-approved HTTPS host; delivery IDs, payloads and bounded retry state survive restarts in Postgres. Webhooks are off until `MKTR_OUTCOME_WEBHOOK_ALLOWED_HOSTS` and `MKTR_OUTCOME_WEBHOOK_SECRET` are configured privately. See [outcome exports and receiver verification](docs/outcome-webhooks.md) for signatures, deduplication and delivery review.

Flow PUT requests use strict zod schemas for graph/node/edge shapes, finite coordinates, thresholds and optional timeout/retry controls. Deleting a flow removes it from the current workspace while preserving immutable published versions and call history. Deleting a clip archives it and retains its files when any published version references it, including versions of deleted flows; otherwise its record and media files are removed. Publication still requires ready clips.

The five built-in clips include spoken sample previews, labeled **Sample**. These recordings are for preview and simulation; upload your own recordings and assign them to the flow for live calls. The preview files are bundled in `public/demo-clips` and included in production builds.

## Flow editing

New flows start with a minimal Start → End path. Use the node palette or drag a node onto the canvas. Select a node to edit its label, clip, threshold, retry attempt count, and note. Select a connection to set its label, intent, sentiment, confidence threshold, or fallback flag. A flow cannot be published until all nodes are reachable, every clip node points to a ready clip, and listening/classification nodes have fallback routes.

The trash control beside the flow selector removes the current flow while retaining published versions and call history. Audio-library **Remove** controls delete unused clips and archive clips retained by published history. An empty workspace still allows navigation and creation of a new flow.

**Event logs** shows the latest 200 recorded events for a selected call. **Settings** shows the active telephony mode, call limits, classifier mode and model as read-only values; its authenticated API response excludes credentials. **Help** opens the packaged first-call runbook through the same operator session.

## Checks

```bash
npm test
npm run test:db # isolated Compose Postgres
# npm run test:db:local # existing native Postgres tools
npm run build
npx playwright install chromium
npm run test:e2e
npm run test:e2e:restart # requires existing native PostgreSQL tools
```

Browser checks cover editor/audio behavior, deletion/archive, permission gating, campaigns, CSV export, operator views and live capacity updates; the separate restart suite checks SSE recovery. They start separate local API and web servers and use `test-results/clips` for test uploads.

Node is pinned to `24.14.0` in `engines.node`, `.nvmrc`, the application images and CI. CI is configured to run typecheck, unit coverage, worker/database/backup checks, Chromium e2e, compose validation, and API/worker image builds. The API image uses the `node` user, starts Node directly, and probes `/api/health`. Build contexts exclude private environments/certificates, runtime files and test fixtures; the runtime retains compiled application files, Prisma CLI/client/migrations and the first-call Help document while excluding test sources and development dependencies. `MKTR_POSTGRES_PASSWORD` must be a randomly generated URI-safe password (for example hexadecimal); Compose has no shared default database password and Postgres refuses an empty one.

See `docs/backups.md` for the consistent database/clip backup, restore procedure and completed native PostgreSQL 16/17 drills. `npm run test:backup` creates and removes only its own disposable localhost database cluster. The default-branch [CI run 34569980907](https://github.com/slzwei/mktr-bot/actions/runs/34569980907) passed the full suite, Compose PostgreSQL 16 tests, API/worker image builds and container startup/shutdown checks. The separate [gateway image build](https://github.com/slzwei/mktr-bot/actions/runs/34569980870) also passed. See [the verification record](docs/verification-2026-09-11.md) for the operator checks still outstanding.

The source repository is [slzwei/mktr-bot](https://github.com/slzwei/mktr-bot), with [GitHub Actions verification](https://github.com/slzwei/mktr-bot/actions). `npm run test:containers` uses the built `mktr-voice-control:ci` and `mktr-media-worker:ci` images to exercise production startup, migrations, non-root Node PID 1, healthchecks, authentication and clean shutdown. It creates its own internal Docker network and disposable PostgreSQL 16 container, fixes telephony to simulator mode, and removes only those fixtures. Docker is required; no gateway, real provider credentials or calls are involved.

Browser verification first signs in with a process-generated fixture password, then shares the resulting secure session with the Chromium tests. Override `MKTR_E2E_API_PORT` and `MKTR_E2E_WEB_PORT` for an isolated parallel run. Session state is under ignored `test-results/`.

The restart browser test creates its own native Postgres cluster, signs in two browser contexts, observes the 15-second stream heartbeat, crashes and restarts only its simulator API, and verifies the open console recovers and both operators see the same call count. It generates fixture credentials in memory and removes its own database and temporary files. It never connects to a SIP trunk.

Call updates include event IDs and a comment heartbeat every 15 seconds. The console keeps native EventSource reconnection enabled and refetches the current call whenever a stream opens again. Operational state refreshes every two seconds and on window focus so another operator's activity reaches the capacity meter without overwriting an unsaved flow. Caddy flushes `/api/calls/*/events` immediately; the API disables intermediary buffering and releases each subscription on disconnect.

## Operator access and HTTPS

Production Compose exposes Caddy on 80/443 and binds the direct API port to host loopback. Set `CADDY_DOMAIN` to the operator's DNS name and `MKTR_WEB_ORIGIN` to its exact HTTPS origin. Caddy obtains TLS certificates and proxies both the UI and API. Only the dedicated Caddy address is trusted for forwarded client/protocol headers; keep `MKTR_TRUST_PROXY` restricted if network addresses change.

Passwords use argon2id. Sign-in creates an opaque eight-hour session using a `Secure`, `HttpOnly`, `SameSite=Strict`, `__Host-` cookie; only the token hash is stored. Logout revokes the session, and reauthentication rotates it. Local Chromium development supports secure cookies on loopback; remote access must use HTTPS. Account seeding is idempotent and does not change an existing account's password on each restart. Production startup requires the seed variables. Durable user/session storage is supplied with the Postgres store.

All control-plane routes and uploaded recordings require an operator session. Health and media webhooks are exceptions; the latter require the timing-safe bearer token check. Calls are limited to ten starts per operator per minute, in addition to the trunk ceiling. Telephony mode is managed through the administrator's deployment environment and a restart; the browser cannot enable live operation. Unexpected errors return a request ID while internal details are logged through pino.

## Compose services

Compose defines API, media worker, Caddy, Postgres, Redis and an optional FreeSWITCH gateway. It requires a prepared private deployment environment, admin/database credentials and existing certificate mounts, even while the API is simulated. Follow the operator runbook for installation, image builds and startup; validate the selected environment without starting services:

```bash
: "${MKTR_DEPLOY_ENV:?Set the protected deployment environment file}"
docker compose --env-file "$MKTR_DEPLOY_ENV" config --quiet
```

API and worker default to simulator mode. Postgres holds flows, immutable published graphs, clips, calls/events, contacts/campaigns, consent/DNC records, webhook deliveries, users and sessions. The API applies committed Prisma migrations before listening and reconciles uploaded files at boot. Redis is reserved for later multi-process coordination; the supported deployment has one API process.

## Preparing the SIP gateway

Only Shawn enables the gateway and makes the first live call, following [the first-call runbook](docs/runbook-first-live-call.md). `npm run verify:runbook` parses the runbook commands and runs isolated configuration/diagnostic fixtures without credentials. Shawn must record his review and one approved test destination before executing the operator steps. The API remains in simulator mode by default. `docs/freeswitch-deployment.md` describes the pinned FreeSWITCH source build with `mod_audio_stream`, complete TLS overlay, required secret files, private networking, and matching local RTP port range.

The FreeSWITCH adapter keeps a persistent authenticated ESL connection. Answer, hangup, originate results and playback completion drive the orchestrator; flow completion and errors terminate the provider channel. Reconnect reconciles channels and never replays originate commands. During each listen window, the media worker verifies that window through the bearer-protected API, streams callee PCM to Deepgram, and submits one final transcript with stable window/utterance receipt IDs. The API classifies the transcript, selects the published flow route and plays its canonical clip. Answer confirmation comes from ESL.
`npm run render:freeswitch -- --dry-run` validates the XML templates with dummy inputs and makes no network connection. `npm run render:freeswitch` renders operator-supplied values and the TLS files to the ignored `runtime/freeswitch/conf/` directory with private permissions. The optional gateway container runs the same renderer at start, so missing inputs fail before FreeSWITCH starts. Rendered XML, SIP/ESL passwords, and TLS material must never be committed.

Gateway registration, TLS 5061, and actual audio transport remain operator checks. Configuration and fake-adapter tests do not prove a live trunk works.

Inbound callbacks have a separate provider-owned dialplan and remain disabled by default. `MKTR_INBOUND_CLIP_FILE` selects a ready uploaded canonical WAV; optional message recording shares the retained recording volume. Source-IP ACL checks and the same 1–5 gateway session limit protect the caller-ID pool. The API stores callback history through authenticated ESL events. See [inbound setup and outstanding operator checks](docs/inbound-callbacks.md); Singtel routing and the real `fs_cli` loopback verification are blocked here.

## Monitoring

`GET /api/health` returns HTTP 200 with `gateway: "n/a"` in simulator mode. Gateway readiness requires a connected ESL session and an exact Singtel `REGED` state; failures return 503. Compose probes the API, and pino JSON logs correlate request IDs with call IDs. Aggregate Prometheus metrics are available at the local API's `/metrics` path; Caddy hides that path from the public origin. `mktr_turn_duration_seconds` measures each reply from the end of the callee's speech to the start of clip playback. `docs/alerting.md` documents the metrics and responses to gateway registration loss and call failures.

Classification defaults to the Singapore English rules provider. Selecting `MKTR_CLASSIFIER_MODE=openai` requires an API key and uses `MKTR_OPENAI_CLASSIFIER_MODEL`; `MKTR_CLASSIFIER_TIMEOUT_MS` defaults to 1500 ms with an observable rules fallback. `docs/classifier.md` explains the rule precedence and fake-provider verification.

## Singtel values in this workspace

| Setting | Value |
| --- | --- |
| SIP account | `sip69992409` |
| SIP endpoint | `sipsg01.b3networks.com` |
| Account-specific IP | `52.77.0.62` |
| PCMA TLS | `5061` |
| Opus TLS | `5081` |
| Media | SRTP `54.251.255.196-54.251.255.211`, UDP `10000-30000` |
| DTMF | RFC2833 |
| Concurrent calls | `5` |

The separate `media-worker` receives authenticated callee-only PCM WebSockets from `mod_audio_stream` while a call is listening. `MKTR_STT_PROVIDER=deepgram` selects Nova-3 over linear16 8 kHz mono at Deepgram's Sydney origin; `MKTR_DEEPGRAM_BASE_URL` (default `https://api.au.deepgram.com`, a bare https origin) selects another region. Endpointing, the silence after the caller stops before the reply is final, is set per listen node in the flow editor (default 300 ms, range 100–1000 ms) and reaches the worker through its listen-window lookup. `MKTR_STT_LANGUAGE` defaults to `en-SG` and maps to Deepgram wire code `en` (the provider does not list `en-SG`). Configure `DEEPGRAM_API_KEY` and a URL-safe `MKTR_MEDIA_GATEWAY_TOKEN` of at least 16 characters privately on the operator host. Simulator mode leaves provider streaming disabled. Run `npm run test:media` for loopback audio and fake STT verification; real speech accuracy belongs to the first-live-call runbook. `MKTR_PCM_CAPTURE_ENABLED=true` makes the worker keep the exact callee PCM and arrival timing of every listen window under an ignored directory, and `npx tsx scripts/replay-stt.ts` replays a capture into a chosen engine at the recorded pacing to time end of speech to transcript; see [media worker behavior](docs/media-worker.md).

The worker cancels and bounds provider connections, closes audio after one utterance, and retries lost transcript replies using the same receipt ID. Audio capacity is released independently of pending HTTP delivery. STT latency uses the final word's audio timestamp; unknown timing is omitted. See [media worker behavior](docs/media-worker.md) for lifecycle limits, receipt handling, and the estimate's precision.

Listen nodes accept `noSpeechTimeoutMs` (default 6000) and retry nodes accept `maxAttempts` (default 1). Set `MKTR_ORIGINATE_TIMEOUT_SECONDS` and `MKTR_MAX_CALL_SECONDS` for answer and connected-call limits; the defaults are 30 and 180. First-call limits belong in the operator runbook.

On API startup or ESL reconnection, MKTR channels and stored active calls are reconciled before dialing is allowed. Interrupted calls terminate with a recorded restart reason. SIGTERM/SIGINT drain active channels within the 20-second Compose grace period; unconfirmed hangups are logged and the independent provider duration limit remains in force.

Every console/campaign dial, including the simulator, now requires recorded voice consent or a fresh affirmative DNC result. Record actual evidence in Campaigns; imported CSV rows do not grant permission. Clearances expire after 21 days, and explicit voice opt-outs prevent subsequent attempts. See `docs/compliance.md` for the relied-on basis and operator workflow. Automated tests use isolated fixture evidence only.

Outbound answers start local voicemail beep detection; normalized outcomes appear in history and campaign CSV. Optional session audio uses `recording-data` and an hourly/boot retention purge; see `docs/recording-and-amd.md`. All provider behavior is verified against fake ESL and fake STT; real detection/audio checks remain in Shawn's runbook.

## Deployed host

Production runs on the DigitalOcean droplet `mktr-voice` at https://voice.mktr.sg. Host facts, everyday commands, the redeploy procedure, and the defects found during the first live call are in [docs/deployment-mktr-voice.md](docs/deployment-mktr-voice.md). A new host is prepared with `scripts/bootstrap-host.sh`.
