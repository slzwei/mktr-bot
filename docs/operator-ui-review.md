# Operator UI review · 11 September 2026

Contact permissions and call history now have dedicated operator views. The work is uncommitted. No dependencies were added; `server/`, `src/lib/domain.ts`, `src/lib/api.ts`, the lockfile and telephony configuration are unchanged.

Contact permissions uses one aggregate permission read and one contact read. It supports name/number/reference search, permission filters, sorting by name, evidence date or expiry, and 50 contacts per page. The browser fixture exercises 500 contacts. Voice verdicts have their own decision column; text and fax are neutral reference rows. All absent verdicts explicitly say unknown. Contact names, numbers, blocking reasons, evidence dates, expiry and references remain available, with titles for truncated values. Evidence entry remains in Campaigns.

The existing Call history navigation and CallConsole selection flow are extended. The list now requests 25 summaries per page through `api.callHistory()`, supports campaign, contact, status and outcome filters plus destination/name search, shows the returned total, and uses the returned cursor until it is null. Previous-page navigation retains the visited cursor stack. Background updates retain the current rows and scroll position; changed filters or pages show skeleton rows. Recording availability and transcript turn counts are visible alongside the contact, campaign, caller ID, flow version, start time, duration and outcome.

Completed calls open with outcome and dial-time evidence above a conversation of agent/caller turns. Speaker labels, alignment and a restrained caller border distinguish the roles. Timestamps and processing latency are secondary; zero latency remains visible. Raw events remain under Technical events. Unanswered calls show “No conversation.” Active calls retain their end control, event timeline, reconnection and capacity updates, and transition to conversation review when they finish. Close restores keyboard focus; Escape closes the console.

The design extends the existing light palette and typography, with shared spacing, status, radius and motion tokens in `src/styles.css`. Tables have sticky headers, internal scrolling, tabular numerals and hairline separators. New interactions use visible focus rings and 140 ms transitions, with reduced-motion support. Detail becomes an overlay on smaller windows. Screenshots were reviewed at 1440, 1024 and 640 pixels, and the conversation at 390 pixels. The review led to more space between evidence labels and dates, improved filter wrapping, and paging controls kept in view on desktop.

Two contract details are handled entirely in the UI:

- The actual aggregate method is `api.permissionSummary()`, rather than the prompt’s `complianceSummary()` name.
- The backend can return `dialable: true` for manually entered DNC evidence with `registers: null`. Under this task’s stricter display rule, that state is “Permission unverified,” never dialable. The same presentation rule is applied to Campaigns and its permission form. Valid recorded consent still shows dialable with all Registry verdicts unknown. The underlying backend permission policy is unchanged. Full call detail exposes the basis through `dialAuthorization.basis`; duration is calculated from its start/end timestamps, matching the history projection.

Verification completed locally:

| Check | Result |
| --- | --- |
| `npm run lint` | Pass |
| `npm test` | 126 passed |
| `npm run build` | Pass |
| `npx playwright install chromium` | Pass |
| `npm run test:e2e` | 34 passed, including six new operator UI tests |
| `npm run test:e2e:restart -- --output=test-results/restart-ui-check` | 1 passed; disposable PostgreSQL and two browsers |
| `git diff --check` | Pass |

New browser coverage uses the built UI and real HTTP routes with a disposable in-memory simulator, seeded history and generated fixture credentials. It covers all three registers, consent and missing verdicts, evidence dates, expiry, 500 contacts, cursor paging beyond bootstrap, every history filter, recording links, ordered agent/caller turns, zero-turn calls, active-to-ended transition, keyboard opening/closing, request failures and retries, obsolete detail responses, and contained scrolling. Interrupted reads are used only for failure/loading/race fixtures. All checks use simulators or fake providers; no real calls or paid Registry requests were made.

Two existing tests were deliberately updated: `tests/dnc.spec.ts` now gives its expiring-clearance fixture an actual Registry snapshot, since a manual result without a verdict must now display unverified. `tests/sse-restart.spec.ts` checks the completed conversation view instead of the removed terminal live-summary markup, while preserving the heartbeat, reconnection, retained-session and two-operator capacity assertions.

The in-app browser could not initialize in this environment, so visual review used Chromium screenshots from the Playwright suite. The Vite build reports a non-failing JavaScript chunk-size advisory (about 526 kB before gzip). With more time, I would add saved history filters, in-transcript search, and split the flow editor into a separate bundle.

Review screenshots are local, ignored test artifacts regenerated by `npm run test:e2e`.
Playwright writes them into its per-test output folders under `test-results/`, one folder
per test; search for the file names below rather than a collected directory:

`permissions-desktop.png`, `permissions-1024.png`, `permissions-640.png`,
`permissions-loading.png`, `permissions-empty.png`, `permissions-error.png`,
`history-desktop.png`, `history-640.png`, `history-empty.png`, `history-error.png`,
`conversation-desktop.png`, `conversation-390.png`, `no-conversation.png`,
`live-call.png`, `detail-loading.png`, `detail-error.png`.
