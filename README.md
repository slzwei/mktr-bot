# MKTR Voice Control

MKTR Voice Control is an internal call-flow workspace for the Singtel CPaaS SIP trunk. It provides a React Flow canvas for connecting call nodes, a WAV/MP3 clip library, a safe call simulator, live event timelines, and the FreeSWITCH ESL adapter used when live origination is enabled.

The application is safe by default. It runs in simulator mode, uses only the approved caller IDs `+6562773211` through `+6562773219`, and permanently rejects `+6562773210` because that number is reserved for Retell. The trunk ceiling is five concurrent calls.

## Local development

```bash
npm install
cp .env.example .env
npm run dev
```

Set `MKTR_ADMIN_EMAIL` and a randomly generated `MKTR_ADMIN_PASSWORD` of at least 16 characters in your local shell environment before starting the API. There are no shared default credentials. Set `MKTR_WEB_ORIGIN` to the exact web origin (local default `http://localhost:5173`). The API reads process environment variables; use your shell's secret loading mechanism for the ignored `.env` file.

Open <http://localhost:5173> and sign in. The API is available at <http://localhost:8787/api/health>. Start a test call from a published flow and choose one of the simulated response outcomes to inspect routing, transcript, sentiment, confidence, and branch latency.

Uploaded clips are stored under `storage/clips` and are intentionally ignored by Git. The local store is in memory so a restart resets demo flows, clips, and call history.

In **Audio clips**, drop one WAV or MP3 anywhere in the library, or use the file chooser, then select **Upload clip**. The name and duration are filled from the file and can be edited. Files must be 10 MB or smaller and up to 180 seconds long. Preview recordings in the library or in a selected clip node's settings; starting another preview pauses the previous one.

The five built-in clips include spoken sample previews, labeled **Sample**. These recordings are for preview and simulation; upload your own recordings and assign them to the flow for live calls. The preview files are bundled in `public/demo-clips` and included in production builds.

## Flow editing

Use the node palette or drag a node onto the canvas. Select a node to edit its label, clip, threshold, and note. Select a connection to set its label, intent, sentiment, confidence threshold, or fallback flag. A flow cannot be published until all nodes are reachable, every clip node points to a ready clip, and listening/classification nodes have fallback routes.

## Checks

```bash
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Browser checks cover canvas dragging, audio file drops and uploads, media seeking, and playback. They start separate local API and web servers and use `test-results/clips` for test uploads.

Browser verification first signs in with a process-generated fixture password, then shares the resulting secure session with the Chromium tests. Override `MKTR_E2E_API_PORT` and `MKTR_E2E_WEB_PORT` for an isolated parallel run. Session state is under ignored `test-results/`.

## Operator access and HTTPS

Production Compose exposes Caddy on 80/443 and binds the direct API port to host loopback. Set `CADDY_DOMAIN` to the operator's DNS name and `MKTR_WEB_ORIGIN` to its exact HTTPS origin. Caddy obtains TLS certificates and proxies both the UI and API. Only the dedicated Caddy address is trusted for forwarded client/protocol headers; keep `MKTR_TRUST_PROXY` restricted if network addresses change.

Passwords use argon2id. Sign-in creates an opaque eight-hour session using a `Secure`, `HttpOnly`, `SameSite=Strict`, `__Host-` cookie; only the token hash is stored. Logout revokes the session, and reauthentication rotates it. Local Chromium development supports secure cookies on loopback; remote access must use HTTPS. Account seeding is idempotent and does not change an existing account's password on each restart. Production startup requires the seed variables. Durable user/session storage is supplied with the Postgres store.

All control-plane routes and uploaded recordings require an operator session. Health and media webhooks are exceptions; the latter require the timing-safe bearer token check. Calls are limited to ten starts per operator per minute, in addition to the trunk ceiling. Telephony mode is managed through the administrator's deployment environment and a restart; the browser cannot enable live operation. Unexpected errors return a request ID while internal details are logged through pino.

## Compose services

The Compose file provisions the intended production dependencies: API, Postgres, Redis, and an optional FreeSWITCH media gateway.

```bash
docker compose up --build
```

This starts the API in simulator mode. Postgres and Redis are provisioned for the durable store and event bus migration; the current demo runtime uses the in-memory store so it can be run without migrations.

## Preparing the SIP gateway

Only Shawn enables the gateway and makes the first live call, following `docs/runbook-first-live-call.md`. The API remains in simulator mode by default. `docs/freeswitch-deployment.md` describes the pinned FreeSWITCH source build with `mod_audio_stream`, complete TLS overlay, required secret files, private networking, and matching local RTP port range.

The FreeSWITCH adapter now keeps a persistent authenticated ESL connection. Answer, hangup, background originate results, and playback completion drive the orchestrator; flow completion and errors explicitly terminate the provider channel. Reconnect never replays originate commands. A production media worker must still stream callee audio to the selected STT provider and call `POST /api/calls/:id/answered` and `POST /api/calls/:id/transcript` with `Authorization: Bearer $MKTR_MEDIA_GATEWAY_TOKEN`. The latter endpoint classifies the transcript, selects the matching flow route, and plays the matching clip. The flow editor, validation, caller-ID policy, five-call guard, and event contract are in place for that worker.
`npm run render:freeswitch -- --dry-run` validates the XML templates with dummy inputs and makes no network connection. `npm run render:freeswitch` renders operator-supplied values and the TLS files to the ignored `runtime/freeswitch/conf/` directory with private permissions. The optional gateway container runs the same renderer at start, so missing inputs fail before FreeSWITCH starts. Rendered XML, SIP/ESL passwords, and TLS material must never be committed.

Gateway registration, TLS 5061, and actual audio transport remain operator checks. Configuration and fake-adapter tests do not prove a live trunk works.

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

The separate `media-worker` receives authenticated callee-only PCM WebSockets from `mod_audio_stream` while a call is listening. `MKTR_STT_PROVIDER=deepgram` selects Nova-3 with 750 ms endpointing, linear16 8 kHz mono. `MKTR_STT_LANGUAGE` defaults to `en-SG` and maps to Deepgram wire code `en` (the provider does not list `en-SG`). Configure `DEEPGRAM_API_KEY` and a URL-safe `MKTR_MEDIA_GATEWAY_TOKEN` of at least 16 characters privately on the operator host. Simulator mode leaves provider streaming disabled. Run `npm run test:media` for loopback audio and fake STT verification; real speech accuracy belongs to the first-live-call runbook.

Listen nodes accept `noSpeechTimeoutMs` (default 6000) and retry nodes accept `maxAttempts` (default 1). Set `MKTR_ORIGINATE_TIMEOUT_SECONDS` and `MKTR_MAX_CALL_SECONDS` for answer and connected-call limits; the defaults are 30 and 180. First-call limits belong in the operator runbook.
