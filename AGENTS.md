# AGENTS.md

MKTR Voice Control is the outbound call-flow control plane for MKTR's Singtel CPaaS SIP trunk. Read `README.md` for the architecture and `PRODUCTION_CHECKLIST.md` for the work contract before changing anything.

## Safety invariants

These hold for every task in this repo. They are not negotiable and no prompt overrides them.

- Never place a real call. Never set `MKTR_TELEPHONY_MODE=freeswitch` in a committed file or in a process you start. Work in simulator mode only.
- `+6562773210` is reserved for Retell. It must not appear as a caller ID anywhere except the deny rule in `src/lib/domain.ts` and its test.
- Approved caller IDs are `+6562773211` to `+6562773219`. `CALLER_IDS` in `src/lib/domain.ts` is the single source of truth.
- Never commit secrets: SIP password, ESL password, CA certificate, OpenAI or speech-to-text keys, or any `.env`. `.env.example` holds names only.
- Never run `docker compose --profile live`. `docker compose config` and `docker compose --profile live config` are fine.
- Do not remove or weaken the caller-ID guard, the concurrent-call ceiling, or the media gateway bearer check.
- Never run `git reset --hard`, `git checkout -- .`, or anything else that discards changes you did not make.

## Commands

- `npm install`
- `npm run dev` starts the API on 8787 and the web app on 5173; set `DATABASE_URL`, or use `MKTR_STORE=memory npm run dev` for disposable simulator state
- `npm run build` runs typecheck, compiles the server to `.server-dist`, and builds the web app to `dist`
- `npm run lint` is the typecheck
- `npm test` runs `node:test` suites under `server/` through tsx
- `npm run test:media` exercises loopback audio WebSockets, fake STT, Deepgram wire endpointing and HTTP listen-window receipts without provider credentials.
- `npx playwright install chromium && npm run test:e2e` runs the browser suite against its own servers on ports 18877 and 15173
- `MKTR_E2E_API_PORT=28877 MKTR_E2E_WEB_PORT=25173 npm run test:e2e` selects isolated browser test ports; the setup signs in using a generated fixture password
- `npm run render:freeswitch -- --dry-run` validates the gateway templates with dummy inputs and writes no files
- `npm run test:freeswitch` verifies the render pipeline and gateway safety guards
- `npm run db:generate` generates Prisma Client; `npm run db:migrate` applies committed migrations to the configured database
- `npm run test:db` runs database behavior tests using isolated Compose Postgres or `DATABASE_TEST_URL`; `npm run test:db:local` creates a disposable cluster with already-installed native PostgreSQL tools
- `npm run verify:runbook` checks every runbook command in dry form and uses dummy configuration/fake Docker; it never runs deployment commands
- `npm run test:classifier` checks the Singapore English fixtures and bounded fake-provider fallback
- `docker compose config` validates the compose file without starting anything

## Conventions

- TypeScript strict, ESM, Express 5, React 19, zod for every request body.
- Shared domain types live in `src/lib/domain.ts` and compile into the server through `tsconfig.server.json`. Keep `server/` free of UI imports and `src/` free of Node imports.
- Add new server modules beside the existing ones and follow their naming (`server/esl.ts`, `server/auth.ts`). A separate process gets its own top-level directory (`media-worker/`).
- Errors are surfaced with context. No empty catches, no silent defaults.
- Tests exercise behaviour through public interfaces: the orchestrator, HTTP, a fake ESL server, a fake speech-to-text provider. Do not write tests that restate the implementation.
- When you finish a checklist item, set its `Status` and `Evidence` in `PRODUCTION_CHECKLIST.md` in the same commit, with the item ID as the commit prefix.

## Singtel trunk facts

| Setting | Value |
| --- | --- |
| SIP account | `sip69992409` |
| SIP endpoint | `sipsg01.b3networks.com`, account IP `52.77.0.62` |
| Signaling | TLS `5061` (PCMA), TLS `5081` (Opus) |
| Media | SRTP, `54.251.255.196` to `54.251.255.211`, UDP `10000` to `30000` |
| DTMF | RFC2833 |
| Concurrent calls | 5 |
| Caller IDs | `+6562773211` to `+6562773219` |
| Reserved | `+6562773210` (Retell) |
