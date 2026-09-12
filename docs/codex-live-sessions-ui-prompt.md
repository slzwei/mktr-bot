# Codex GPT-6 Astra prompt — live sessions UI

Run Codex from the repo root so it picks up `AGENTS.md`. Reasoning: max. No credentials
needed; the run stays in simulator mode, which is where concurrent calls are easiest to
produce. The backend this UI consumes already exists and is tested; only one small server
addition is sanctioned, and it is named below.

Context for the operator, not for Codex: production now allows three concurrent calls
(`MKTR_MAX_CONCURRENT_CALLS=3`, raised from 1 on 12 Sep 2026). The trunk ceiling is five.
Until now the interface could only follow one call at a time, so two of three running calls
were invisible.

---

```text
# GOAL
Build an operator view for watching several concurrent calls at once in this repo
(mktr-voice-control). Today `CallConsole` follows exactly one call and shows its status and a
live technical event timeline. With three calls able to run at the same time, the operator has
no way to see what the other two are doing. Give every running call the same live visibility
the single console already provides, in one view, updating as it happens. You own the design:
layout, hierarchy, navigation placement, components and styling are your decisions.

# INSTRUCTION PRIORITY
1. The safety invariants in AGENTS.md.
2. This prompt.
3. Existing code conventions in the repo.
Never place a real call. Never set MKTR_TELEPHONY_MODE=freeswitch in a committed file or in a
process you start. Never run docker compose --profile live. Simulator only.

# WHAT EXISTS ALREADY — READ BEFORE BUILDING
- `src/App.tsx` is the shell. `type View` lists the nav destinations and `navigation` renders
  them. It already fetches `/api/bootstrap` and refreshes calls and trunk capacity every two
  seconds and on window focus, so a live roster of calls is ALREADY in `data.calls` and
  capacity is already in `data.trunk`. Do not add a second polling loop for the same data.
- `src/components/CallConsole.tsx` is the single-call console. Read it first. It opens
  `new EventSource("/api/calls/" + id + "/events")`, renders a status orb, an event timeline
  headed "Live event timeline", the transcript and a review pane, and it reconnects after one
  second when the stream closes. Its timeline rendering and reconnect handling are the pieces
  worth reusing. It is a drawer opened from the flow editor and from call history; leave that
  behaviour working.
- `src/components/OperatorUI.tsx` exports shared pieces you should reuse rather than
  reinvent: `OutcomeChip`, `EmptyState`, `LoadError`, `SkeletonRows`, `Pager`, `DateCell`.
- `src/lib/operator-display.ts` exports `isCallInProgress(status)`, `outcomeLabels`,
  `basisLabel`, `singaporeTime`, `singaporeDate`, `singaporeDateTime`. Singapore time is the
  house convention for every timestamp shown to an operator.
- `src/components/operator.css` holds the existing design tokens and the `status-orb--*`
  classes. Extend it in the same style.
- `src/components/SystemViews.tsx` has `EventLogsView`, a flat list of the latest events
  across calls. That is a log, not a live session view. Do not confuse the two, and do not
  delete it.

# THE DATA YOU CONSUME — ALREADY BUILT AND TYPED IN src/lib/domain.ts
- `CallSession` carries `id`, `destination`, `callerId`, `flowId`, `flowVersion`, `status`,
  `currentNodeId`, `createdAt`, `endedAt`, `endReason`, `outcome`, `classifierResult`,
  `campaignId`, `contactId`, `dialAuthorization`, `recordingFile`, `recordingExpiresAt` and
  `events`.
- `CallStatus` is queued, dialing, ringing, answered, playing, listening, classifying, ended,
  failed. `isCallInProgress` is true for everything except ended and failed.
- `CallEvent` carries `id`, `type`, `timestamp`, `title`, `detail`, `nodeId`, `latencyMs`.
  `CallEventType` is inbound_callback, queued, dialing, ringing, answered, clip_playing,
  listening, transcript_final, classified, branch_selected, ended, error.
- `TranscriptTurn` carries `at`, `role` ("agent" or "caller"), `text`, `nodeId`, `latencyMs`.
- `TrunkStatus` carries `activeCalls`, `maxConcurrentCalls`, `mode`, `callerIds` and more.
- `GET /api/calls/:id/events` is Server-Sent Events. EVERY frame is a complete `CallSession`
  snapshot, not a delta, and the SSE `id` is the latest event's id. Render from the snapshot.
- `GET /api/calls/:id` returns the call plus a derived `transcript` of `TranscriptTurn`.
- `POST /api/calls/:id/end` stops a running call and returns the updated session.
- `GET /api/bootstrap` returns flows, clips, the 25 most recent calls and trunk status.
- Every route above needs the operator session cookie, which the app already holds.

# HOW TO STREAM SEVERAL CALLS — THIS DECISION IS MADE, DO NOT REDESIGN IT
Open one `EventSource` per running call against the existing `/api/calls/:id/events`. Do not
build a multiplexed all-calls stream and do not add an orchestrator-wide subscription.
Reasons, so you can judge the edges yourself: concurrency is capped at five by
`MKTR_MAX_CONCURRENT_CALLS` and the trunk, so the connection count is bounded and small;
Caddy serves the app over HTTP/2, so the old six-connections-per-origin limit does not apply;
and the existing endpoint's reconnect and snapshot behaviour is already proven by
`tests/sse-restart.spec.ts`, which a new endpoint would have to earn from scratch.
Derive which calls are running from the roster already in `data.calls` using
`isCallInProgress`. Open a stream when a call appears, close it when the call reaches a
terminal status or leaves the roster, and never leak a stream on unmount. If you find a
genuine reason this cannot work, say so in your report and implement the smallest server
addition that does, with tests.

# WHAT TO BUILD
A view that answers, at a glance and without clicking: how many calls are running against
capacity, who each one is with, and what each one is doing right now.

For every running call, the operator must be able to see:
- Who it is: contact name where the call has a `contactId` and the roster knows the name,
  otherwise the destination number. Show the caller ID used.
- Which flow and version is running, and which node the call is on right now
  (`currentNodeId` resolved to the node's label from the flow definition in `data.flows`).
- The live status, distinguishable at a glance between dialing, ringing, and the answered
  states (answered, playing, listening, classifying). Reuse or extend `status-orb--*`.
- How long it has been running, counting up.
- The live technical event timeline, newest first, the same information `CallConsole` shows.
  This is the part the operator asked for by name: they want the dynamic status log, per call,
  for every call at once.
- What has been said so far, if you can show it without crowding the timeline.
- Whether the call is recording.
- A control to stop that call, with the result reflected immediately.
- Where campaign calls are concerned, which campaign it belongs to.

Also show capacity: calls in flight against `maxConcurrentCalls`, and make it obvious when
the trunk is full, because a full trunk is why a campaign has stopped dialing.

Opening one call in the existing `CallConsole` from this view is a reasonable affordance if
your design wants it. Keep the console working as it does today.

# STATES YOU MUST HANDLE
- No calls running. This is the normal state most of the day. It must not look broken, and it
  should point at the thing an operator would do next.
- One call running, and the view filled to capacity. Both must look deliberate.
- A call ending while the operator is watching it: it must stop updating, read as finished
  with its outcome, and not vanish from under the pointer mid-read.
- A call that fails: the end reason is the important text.
- The stream dropping and recovering, without a flash of empty state on every reconnect.
- The initial load before any data arrives.
- A call whose flow version has since been deleted, so the node label cannot be resolved.

# CONSTRAINTS
- TypeScript strict, React 19, no new runtime dependencies. Keep `src/` free of Node imports.
- Do not change the API, the orchestrator, the domain types or the SSE contract.
- Do not change `MKTR_MAX_CONCURRENT_CALLS` or any limit in a committed file.
- Timestamps are Singapore time, via the existing helpers.
- Keyboard reachable, visible focus, `prefers-reduced-motion` respected. A counting timer and
  a live log are both motion; make sure neither traps a screen reader in constant announcements.
- The technical timeline is for troubleshooting. Transcripts contain callee speech; treat them
  with the same care the rest of the app does and never log them to the console.
- Match the existing visual language rather than introducing a second one.

# VERIFY
- `npm run lint`, `npm test`, `npm run test:media` and `npm run build` all pass.
- `npx playwright test` passes. Note that `tests/interactions.spec.ts:91`, the palette drop
  test, is already flaky on main; re-run it to confirm before investigating it.
- Add a Playwright spec for this view that drives more than one simulator call at once and
  proves each tile updates independently and live. The simulator reaches a listen node without
  any provider credentials, and `POST /api/calls` accepts a `scenario` of interested,
  not_interested, callback or uncertain, so you can start calls with different outcomes.
- Screenshot the view with two or three calls running and include it in your report.

# AUTONOMY
Bias towards action. This prompt is your authorisation. Do not stop to present a plan or ask
which layout is preferred: the design is yours. Commit on main with a clear subject, keep
`README.md` accurate if you add a nav destination, and add a line to `docs/decisions.md` for
any decision a future reader would otherwise have to reverse-engineer.

# OUTPUT
Final report, in plain paragraphs and short flat lists, backticks for paths and commands, no
preamble and no closing summary:
1. What you built and where it lives, with the commit hash.
2. The design decisions you made and why, in one line each.
3. Anything in this prompt you found to be wrong about the repo, quoted.
4. What you verified, with the command output that proves it.
5. Anything you deliberately left out and why.
```
