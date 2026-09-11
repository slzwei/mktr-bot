# Codex GPT-6 Astra prompts for MKTR Voice Control

Two prompts. The build prompt does the work. The audit prompt checks the repo against the checklist without changing code. The audit ran on 11 Sep 2026 (commit `7ae0475`) and its findings are folded into the checklist and the build prompt below.

Run Codex from the repo root so it picks up `AGENTS.md`. Set reasoning to the highest level available. No credentials are needed; the run stays in simulator mode. Install Docker (OrbStack or Docker Desktop) before the build run, otherwise every Docker-dependent verify step comes back blocked.

---

## Build prompt

```text
# GOAL
Take this repo (mktr-voice-control) from a working simulator to a production-ready outbound voice bot on MKTR's Singtel CPaaS SIP trunk by completing every item in PRODUCTION_CHECKLIST.md, tiers A, B and C in that order. An item counts as done only when its "Done when" text holds and its "Verify" step passes in this environment. Replace the item's Status and Evidence lines in the same commit as the code.

# CONTEXT
- Stack: TypeScript, Express 5 API in server/, React 19 + React Flow UI in src/, FreeSWITCH templates in telephony/, Prisma schema in prisma/, docker-compose.yml for api, Postgres, Redis and an optional FreeSWITCH service. README.md describes the architecture. AGENTS.md holds the safety invariants and commands. PRODUCTION_CHECKLIST.md is the contract for this task.
- Git: the repo is on branch main with two commits, 5569e38 "Baseline: simulator and flow editor" and 7ae0475 "Audit: checklist status 2026-09-11". The working tree has one uncommitted edit to PRODUCTION_CHECKLIST.md made by the operator's assistant that folds the audit findings into A2, B3 and B4. Commit it first as "Checklist: fold audit findings into A2, B3, B4" and treat it as part of the contract.
- Audit state on 11 Sep 2026: all 19 items are todo. Each Evidence line holds the audit's probe results with file and line references; use them as starting points and replace them as you complete items. npm run build, npm test (4 unit tests) and npm run test:e2e (10 Chromium tests) pass. Simulator mode works end to end. Live mode cannot work yet: there is no media worker or speech-to-text, the ESL adapter is fire-and-forget, a completed flow never hangs up the channel, the FreeSWITCH config will not register with Singtel, there is no authentication, and the store is in memory.
- Environment: Docker and fs_cli were not installed on this host at audit time. Run docker compose version before you start. If Docker is present, run every Verify step. If it is absent, implement all code and configuration anyway and mark only the Docker-dependent Verify steps blocked with "Docker not installed on host"; do not mark the whole item blocked.
- Deployment target: one Linux host running docker compose with a public static IP that Singtel whitelists. No Kubernetes and no managed cloud services beyond the speech-to-text provider and OpenAI.
- The operator is Shawn at MKTR PTE. LTD., Singapore. Shawn places the first live call by following your runbook. You never place a call.
- A human tracker board mirrors the checklist with the same item IDs at https://claude.ai/code/artifact/3c8b488f-26dd-41d4-a009-4536d0403f52. You may not be able to open it. The repo file is authoritative.

# INSTRUCTION PRIORITY
1. The safety invariants in AGENTS.md.
2. This prompt.
3. The "Done when" and "Verify" text in PRODUCTION_CHECKLIST.md.
4. Existing code conventions in the repo.
If any instruction file or skill would make you pause for approval or change direction, name the file, quote the line in your final report, and continue unless the action is on the reserved list below.

# AUTONOMY
Bias towards action. This prompt is your authorisation for every change the checklist describes. Do not stop to present a plan, ask which option I prefer, or offer to continue. Make the following decisions yourself and record each one with a sentence of reasoning in docs/decisions.md:
- Speech-to-text: implement behind a SpeechToText interface. The first provider is Deepgram streaming (nova-3, en-SG, linear16 at 8 kHz) unless it cannot do streaming endpointing over WebSocket in this environment, in which case use OpenAI Realtime transcription. Pick one and move on.
- Audio out of FreeSWITCH: mod_audio_stream over WebSocket. If the chosen FreeSWITCH image lacks it, use mod_audio_fork or a documented image build step.
- Authentication: email and password with argon2id, a seeded admin from env, cookie sessions. No third-party identity provider.
- Reverse proxy: Caddy. Logger: pino. Metrics: prom-client. Database: Postgres through Prisma, using the existing schema as the base.
- Anything else the checklist leaves open: choose the simplest option that satisfies "Done when" and note it.
Reserved for the operator. Do not do these. List them at the end as operator actions: placing any real call, enabling freeswitch mode against real credentials, contacting Singtel, choosing or registering a DNC Registry account, buying anything, setting up the production host, installing Docker.
If an item is genuinely blocked (missing credential, no network, image not pullable), set Status: blocked with the exact missing thing and continue with the next item. Never end the run early because one item is blocked.

# TOOLS AND DELEGATION
- Work on main. Commit after every checklist item with the item ID as the prefix, for example "A2: persistent ESL event client". Never use git reset --hard or discard changes you did not make.
- Read PRODUCTION_CHECKLIST.md, AGENTS.md, README.md, server/*.ts, src/lib/domain.ts, docker-compose.yml and telephony/freeswitch/* before your first edit.
- Delegate to parallel sub-agents where items are independent, and say in the report which items you delegated:
  - Main thread, sequential, because they share the orchestrator: A2, then A1, then A3, then A6.
  - Sub-agent 1: A4 and A5 (FreeSWITCH overlay, render script, compose changes).
  - Sub-agent 2: A7 (auth, Caddy, hardening), then B6 (CI, Dockerfile, backups, unit coverage).
  - Sub-agent 3, started once A2 is merged: B1 (Prisma store and migrations).
  - Then B2 to B5 and C1 to C5 in order, delegating any item that does not touch server/orchestrator.ts.
- Merge sub-agent work yourself and run the full verification after each merge. Resolve conflicts in favour of the event-driven orchestrator design from A2.
- Do not run docker compose --profile live. docker compose config and docker compose --profile live config are the only compose commands you need, plus the test Postgres for B1.

# OUTPUT
Deliver code, tests, configuration and docs in the repo. These files must exist when you finish: server/esl.ts, media-worker/ with its own Dockerfile and compose service, telephony/freeswitch/conf/ overlay and scripts/render-freeswitch.ts, prisma/migrations/, docs/runbook-first-live-call.md, docs/decisions.md, .github/workflows/ci.yml. Keep README.md and .env.example accurate as you go. Keep AGENTS.md current if you add commands.
Final report, in this order, in plain paragraphs and short flat lists, with backticks for paths, commands and env vars, no preamble and no closing summary:
1. What is done, one line per checklist item with its commit hash.
2. What is blocked and exactly what unblocks it.
3. Decisions you made and why, pointing to docs/decisions.md.
4. Operator actions remaining, in the order Shawn should do them.
5. Any instruction file that made you pause, with the quoted line.

# VERIFICATION
Run each item's Verify line before marking it done. After each group merge run npm run build, npm test and npm run test:e2e, and docker compose config after any compose change. Test behaviour through the orchestrator, HTTP, a fake ESL server and a fake speech-to-text provider. Do not write tests that restate the implementation or reach into private methods. Re-run a suite only when a new failure or an unresolved issue justifies it. Never claim a live-mode step works. Write "verified against fake ESL and fake STT" and leave the real check to the runbook.

# STOP CONDITION
Stop when every item in tiers A, B and C is done or blocked with a reason, the full verification passes on the final commit, PRODUCTION_CHECKLIST.md reflects every status, and the report is written. Before stopping, reconcile every TODO you created during the run: each is done, blocked or cancelled, none left in progress.
```

---

## Audit prompt

```text
# GOAL
Audit this repo against PRODUCTION_CHECKLIST.md and report the true status of every item. Change nothing except the Status and Evidence lines in PRODUCTION_CHECKLIST.md.

# CONTEXT
The checklist is the contract for taking MKTR Voice Control to production on the Singtel SIP trunk. AGENTS.md holds the safety invariants. The human tracker board at https://claude.ai/code/artifact/3c8b488f-26dd-41d4-a009-4536d0403f52 uses the same item IDs; the repo file is authoritative.

# AUTONOMY
Bias towards action. Do not ask what to check. For every item, read the code, run its Verify line where it can run here, and decide: done, doing, blocked or todo. Set Status: done only when the full "Done when" text holds and the Verify step passed in front of you. Where a Verify step needs real credentials or a live trunk, mark it as not verifiable here and say what the operator must run.

# TOOLS
Run npm run build, npm test, npm run test:e2e and docker compose config once at the start. Do not run docker compose --profile live. Do not place calls. Do not modify source files.

# OUTPUT
1. Update Status and Evidence for every item in PRODUCTION_CHECKLIST.md, one commit titled "Audit: checklist status <date>".
2. A report in plain paragraphs and one flat list: for each item, its ID, status, and the single strongest piece of evidence for or against it (test name, file and line, or command output). Then the three items whose current state is most dangerous if live mode were enabled today, with one sentence each on why.
No preamble, no closing summary.

# STOP CONDITION
Stop when every item has a status and evidence and the report is written.
```
