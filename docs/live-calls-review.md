# Concurrent live calls review

Implemented 12 September 2026. Verification is incomplete because this editing session denies local sockets; no real calls, gateways or provider requests were started.

## Implementation

`src/components/LiveCallsView.tsx` adds the Live calls navigation destination. A capacity banner precedes responsive cards with contact/destination, caller ID, campaign, flow/version, current node, status, elapsed duration, recording state, newest-first technical events and captured caller speech. End applies the returned session immediately. Finished cards retain their outcome and end reason in their original positions until explicitly dismissed or the operator leaves the view.

`src/components/CallEventTimeline.tsx` and `src/lib/use-call-stream.ts` share the existing console's event rendering and reconnection behavior. Each running roster entry owns one EventSource. The stream closes on terminal completion, roster removal, view unmount or console closure. Dropped connections keep their last snapshot and resync on reconnect; a permanently closed transport is recreated after one second. `src/lib/call-snapshot.ts` guards against delayed reads shortening a timeline or reviving a completed call. The App's existing two-second/focus refresh remains the sole roster poll, and event frames no longer trigger extra bootstrap reads.

Node labels require a matching published flow version. Contact/campaign names use the existing authenticated lookup APIs when the observed identities change. Reduced motion initially pauses timers and logs, with a keyboard-accessible resume control; statuses, End controls and final outcomes remain current. Timelines and counters do not continuously announce updates. Styles extend `operator.css` and existing tokens/status orbs. The console's editor/history entry points and Event logs remain available.

## Clarifications to the prompt

- “With three calls able to run at the same time”: the repository default and trunk ceiling are five. The view reads `maxConcurrentCalls`, so it also supports a deployment capped at three. No limits changed.
- “a flat list of the latest events across calls”: `EventLogsView` selects one call and shows up to 200 of that call's events. It was left intact.
- “renders ... the transcript and a review pane”: the active `CallConsole` currently shows a technical timeline and classifier result; its conversation/review appears after completion. Shared extraction preserves that behavior.
- Bootstrap has call IDs and metadata but no contact or campaign names. Agent clip events generally contain “Pre-recorded clip”, not the actual words spoken; the new view labels these as technical events and only calls captured callee text speech.
- Deleting a current flow preserves immutable published versions on the server. The workspace's `data.flows` still cannot resolve removed or older versions. The fallback states this instead of showing a potentially incorrect node label.

## Verification evidence

- `npm run lint`: exit 0, `tsc --noEmit`.
- `npm run build`: exit 0, Prisma Client generated, TypeScript compiled, Vite production build completed. Vite still reports its advisory about a JavaScript chunk exceeding 500 kB.
- Additional strict TypeScript checking of `tests/live-calls.spec.ts` and its imported fixture: exit 0. This also corrected the existing disabled DNC fixture's missing empty gateway configuration fields.
- `npx playwright test --list`: exit 0, `Total: 42 tests in 9 files`, including seven new Live calls scenarios.
- `npm test` and `npm run test:media`: exit 1 before suites run, `Error: listen EPERM: operation not permitted .../tsx-501/...pipe`.
- `node --import tsx --test server/**/*.test.ts`: an additional run without the CLI's IPC setup reports `tests 138`, `pass 60`, `fail 78`; socket-dependent tests fail with `listen EPERM` or consequent unavailable-server errors. This is not a passing unit-suite result.
- Both `npx playwright test` and the targeted Live calls run: exit 1 during server startup, `Error: Process from config.webServer exited early.` Debug output identifies `connect EPERM 127.0.0.1:18877`. No browser test reached execution, including the known palette-drop test; its flakiness could not be assessed here.
- `git diff --check`: exit 0.

The main concurrent-call spec starts three consent-authorized simulator calls through `POST /api/calls`, with interested, callback and not-interested scenarios, then freezes bootstrap and blocks call-detail reads. It checks each independent SSE timeline, Singapore timestamps, caller speech and timer, and retains stopped/completed/failed outcomes despite stale bootstrap responses. Other scenarios cover five slots, terminal and navigation cleanup, roster removal, HTTP reconnect failures, natural differing outcomes, stop retry, name fallback/retry, missing versions, recording metadata, reduced motion, keyboard scrolling and initial load/retry. These scenarios are authored and typechecked, not runtime-verified.

The three-call spec writes and attaches `live-calls-three.png`; the capacity and idle specs also capture one-call, five-call and narrow-screen layouts. These screenshots were not generated because the sandbox prevented test startup. There is no substitute mock screenshot presented as running simulator evidence.

## Deliberate boundaries

- The existing API, orchestrator, domain types, SSE contract, telephony modes and concurrency limits are unchanged.
- Only the current 25-call bootstrap roster is streamed. A discrepancy against authoritative trunk capacity is disclosed, since sufficiently old running calls can fall outside that roster.
- Full recording playback and the conversation review remain in the existing history console. The multi-call view prioritizes technical events and actual captured caller speech.
- Retained cards are scoped to the current view visit; nothing containing callee speech is written to browser storage or console logs.

Local socket access is required to finish runtime verification and inspect the requested screenshot. C6 remains `doing` until those checks pass.
