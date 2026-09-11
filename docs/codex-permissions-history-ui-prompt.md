# Codex GPT-6 Astra prompt — permissions and call-history UI

Run Codex from the repo root so it picks up `AGENTS.md`. Reasoning: max. No credentials
needed; the run stays in simulator mode. The backend this UI consumes is already merged
at commit `64e95c3` and is not to be changed.

---

```text
# GOAL
Build the operator UI for two things in this repo (mktr-voice-control): contact permissions
and call history. The backend is DONE and merged — every endpoint and type below already
exists and is tested. Your job is the interface: pages, components, styles, navigation and
states. You own the design. Do not redesign the API.

# INSTRUCTION PRIORITY
1. The safety invariants in AGENTS.md.
2. This prompt.
3. Existing code conventions in the repo.
Never place a real call. Never set MKTR_TELEPHONY_MODE=freeswitch. Simulator only.

# WHAT EXISTS ALREADY — READ BEFORE BUILDING
- `src/App.tsx` is the shell. It already has a "Call history" nav item (`view === "calls"`)
  rendering a five-column table (Destination, Caller ID, Flow, Outcome, Started). Clicking a
  row opens `CallConsole` with that call. A recording download link appears when the call has
  an unexpired recording. This WORKS — improve it, do not rebuild it from scratch.
- `src/components/CallConsole.tsx` renders a call's event timeline under the heading "Live
  event timeline". It is used for both live and past calls. Past calls need a view that does
  not read as live.
- `src/components/CampaignsPanel.tsx` renders contacts as selectable rows with a permission
  state via `permissionDisplay()` in `src/lib/permission-display.ts`. That helper returns
  `{tone, label, detail}` for Dialable / On the No Voice Call Register / No permission /
  Dialable · clearance expiring.
- Styling lives in `src/styles.css`, `src/components/campaigns.css`, `src/components/consent.css`.
  Follow the existing visual language — this is one product, not a new one.

# THE API YOU CONSUME (already built, already typed in src/lib/domain.ts)

`api.complianceSummary()` → `{ contacts: ContactPermission[], dncEnabled: boolean }`

  ContactPermission = {
    phone, dialable, basis: "consent" | "dnc" | null, clearanceExpiresAt, skipReason?,
    checkedAt: string | null,
    registers: { noVoiceCall, noTextMessage, noFax } | null,
    reference: string | null,
  }

`api.contacts()` → `Contact[]` ({ id, name, phone, createdAt, ... })

`api.callHistory({ limit?, cursor?, campaignId?, contactId?, status?, outcome?, search? })`
  → `{ calls: CallSummary[], nextCursor: string | null, total: number }`

  CallSummary = {
    id, destination, callerId, contactId?, contactName?, campaignId?, campaignName?,
    flowId, flowVersion, status, outcome?, direction?, createdAt, endedAt?,
    durationSeconds: number | null, endReason?, hasRecording: boolean,
    transcriptTurns: number, dialBasis: "consent" | "dnc" | null,
  }

`api.call(id)` → the full `CallSession` plus `transcript: TranscriptTurn[]`

  TranscriptTurn = { at, role: "agent" | "caller", text, nodeId?, latencyMs? }

Recording download stays `GET /api/calls/:id/recording`.

# WHAT TO BUILD

## 1. Contact permissions
Operators need to see, for every contact, what permission exists and what it rests on.
Surface per contact: the phone number and name; whether it is dialable and on what basis;
the skip reason when blocked; the date the evidence was obtained (`checkedAt`); the expiry
(`clearanceExpiresAt`); the evidence reference; and all three PDPC registers.

THE ONE RULE THAT MATTERS: **only `noVoiceCall` blocks a call.** Text or fax registration
does NOT stop a voice call — that is a deliberate compliance decision recorded in
docs/decisions.md. The three registers must be visually distinguishable so nobody reads a
text registration as the reason a call was blocked. `registers: null` means no Registry
verdict exists (consent-based or manually entered) — render that as unknown, never as clear.
An absent verdict must never look like a clean one.

Decide yourself whether this is a new nav page, a section of Campaigns, or both. If you add
a page, add it to the `navigation` array and the `View` union in `src/App.tsx`. Sorting,
filtering and search are yours to judge — a 500-contact import is the realistic size.

## 2. Call history
Move the existing table onto `api.callHistory()` so it pages instead of relying on
`/api/bootstrap`, which now returns only the 25 most recent calls. Add paging using
`nextCursor` (a null cursor means the end) and show `total`. Add filtering and search — the
API supports campaign, contact, status, outcome and a destination/name search.

Show per row what an operator scanning a campaign needs: who was called (name and number),
when, how long, the outcome, whether a recording exists, and whether there is a transcript
(`transcriptTurns`).

## 3. Call detail with the transcript
Clicking a call must show its conversation. Render `transcript` as turns — agent and caller
visually distinct, in time order, readable as a conversation rather than a log. Keep the raw
event timeline available for debugging, but the transcript is the primary content for a past
call. Keep the recording link. Show the outcome, end reason, duration, flow version, and the
permission basis the dial relied on (`dialBasis`).

A live call must still work exactly as it does now.

# DESIGN BAR — THIS MUST LOOK LIKE A POLISHED COMMERCIAL SAAS

This is the bar the work is judged against. An operator should open these pages and assume
they are paying for the product. Functional-but-plain is a failure here.

**Extend the existing system, do not invent a second one.** `src/styles.css` defines the
palette on `:root`: `--ink #17211d`, `--muted #6d7973`, `--line #d8dfdb`, `--soft #f4f7f5`,
`--panel #ffffff`, accent `--teal #0b7a62` (with `--teal-dark`), plus `--orange`, `--blue`,
`--rose` for status. Inter is the typeface. The app is light-only — do not add a dark theme.
If you need new tokens (elevation, radii, spacing steps, semantic status colours), add them
to `:root` alongside the existing ones and use them everywhere rather than hard-coding values.

What "polished" means concretely here:

- **Hierarchy.** One unambiguous page title per view, a supporting line that says what the
  page is for, then content. Section headers are clearly subordinate. A reader should know
  where they are and what matters most without reading every word.
- **Spacing on a consistent rhythm.** Pick a 4px-based scale and keep to it. Generous around
  page furniture, tighter inside data rows. Inconsistent gaps are the single most common tell
  of unpolished work.
- **Data density done properly.** These tables are read at 500 rows. Sticky header, aligned
  columns, `font-variant-numeric: tabular-nums` on anything numeric or time-based, truncation
  with a title attribute rather than wrapping that destroys the grid. No zebra striping —
  hairline row separators in `--line` read cleaner.
- **Status as calm semantic chips**, not loud badges. Colour carries meaning and nothing else:
  never use the accent decoratively. Blocked, dialable, expiring and unknown must be
  distinguishable at a glance AND without relying on colour alone.
- **Restrained depth.** Hairline borders plus at most one soft shadow level. No cards nested
  inside cards, no heavy chrome, no gradients as decoration, no emoji, no clip-art empty-state
  illustrations. `lucide-react` icons only, sized consistently, never as ornament.
- **Every state designed.** Loading uses skeleton rows that match the real row geometry, not a
  centred spinner that collapses the layout. Empty states say what the page will show and how
  to get there. Errors state what failed and what to do. A call still in progress, and a call
  with no conversation, are normal states and must look deliberate.
- **Motion is subtle and fast.** 120–160ms, ease-out, on hover, focus and disclosure only.
  Nothing bounces. Respect `prefers-reduced-motion`.
- **Interaction quality.** Every interactive row has distinct rest, hover, focus-visible and
  active states. Focus rings are visible and on-brand, never `outline: none`. Hit targets are
  comfortable. Text contrast meets AA.
- **The transcript is the showpiece.** Render it as a real conversation: clear speaker
  separation, the two roles visually distinct without looking like a chat toy, timestamps and
  latency present but recessed to a secondary tier. It should be pleasant to read end to end.
- **The three registers need a considered treatment.** Voice is the decision; text and fax are
  reference. Design that asymmetry rather than printing three equal checkboxes — but keep all
  three legible and unambiguous, including the "no verdict" case.
- **Responsive down to a laptop and a narrow window.** The shell has a sidebar; content must
  not overflow horizontally. Tables may scroll inside their own container; the page must not.

Judge your own output: screenshot the finished pages, look at them, and fix what a designer
would flag. Say in your report what you would improve with more time.

# STATES YOU MUST HANDLE
Loading, empty (no contacts, no calls, no transcript), error, and a call still in progress
(no `endedAt`, no outcome). A transcript of zero turns is normal for an unanswered call and
must read as "no conversation", not as a failure.

# CONSTRAINTS
- Do NOT change anything in `server/`, `src/lib/domain.ts` or `src/lib/api.ts`. They are the
  contract. If you believe the contract is wrong, say so in your report and work around it.
- Do not add a dependency without saying why in your report. `lucide-react` is already used
  for icons.
- Accessible: real buttons, labels, keyboard reachable, sensible aria. The existing code uses
  `data-testid` on rows the tests target — keep `contact-permission-row` working.
- Singapore time for anything shown to an operator, matching the existing
  `toLocaleString("en-SG", { timeZone: "Asia/Singapore" })` usage.
- Never render a phone number as permitted when `registers` is null and there is no consent.

# VERIFY
`npm run lint`, `npm test`, `npm run build`, and `npx playwright install chromium &&
npm run test:e2e` must all pass. Add Playwright coverage for: the three registers rendering
distinctly with only voice blocking; the check date appearing; paging through history; and a
past call's transcript rendering as agent/caller turns. Existing tests must keep passing —
if one fails because you moved markup it targets, update the test deliberately and say so.

# AUTONOMY
Bias to action. Make the design calls yourself and state them in your report. Do not ask
which option to prefer. Do not commit — leave the work in the tree and report what you built,
what you decided, and anything you could not verify.
```
