# Automated batch DNC checking

**Status: built for mktr-bot (C2a), shipped disabled.** Verified against a loopback fake
gateway only. Part A describes the separately provisioned mktr-platform contract, not a
gateway implementation or live verification performed in this repository.

Automated prepaid checks supplement the existing manual evidence paths. Companion: [voice marketing consent and DNC checks](compliance.md),
which states the legal basis and the 21-day validity rule this builds on.

Names only in this file — it is a public repo. Real values live in `/etc/mktr/voice.env`.

---

## 1. What changes, and what deliberately does not

**Unchanged: the dial gate.** `ConsentPolicy.authorize()` already refuses any dial without a
stored consent record or a `DncClearance` newer than 21 days, and already returns the skip
reason the campaign UI shows. This work only changes *how those clearance records get
written* — today an operator types them one at a time through `POST /api/compliance/dnc`.
No change to `compliance.ts`, the dialer, or the skip-reason paths.

**Changed when enabled:** a free CSV preview states the credit count, then an explicit import
confirmation imports contacts and scrubs new Singapore numbers in batches of 100. Complete
S000 responses write one `DncClearance` per number with the transaction ID as evidence.
A separate one-number action states its one-credit cost before checking.

**Why batch beats per-dial.** The Registry API takes up to 100 numbers per signed request and
bills 1 prepaid credit per number either way, so batching does not reduce spend — it removes
99 round-trips, 99 signatures and 99 timestamps per hundred contacts, and it keeps a network
call out of the dial loop. A 1,000-contact import becomes 10 requests.

---

## 2. Architecture — mktr-bot does not hold the PDPC credential

```
mktr-bot (voice droplet 159.65.14.135)
   │  HTTPS + HMAC over raw body
   ▼
mktr-platform  api.mktr.sg  POST /api/external/dnc-batch
   │  owns: org code · RSA signing key · hourly budget · call lock · Sentry
   │  HTTP CONNECT via dnc-egress droplet 159.89.201.126  ← the only IP PDPC allowlists
   ▼
PDPC  POST https://www.dnc.gov.sg/realtime/check/registry
```

PDPC binds one certificate, one allowlisted egress IP and one prepaid credit pool to the
MKTR org account, and its spec requires request timestamps that never regress across our
requests. A second independent signer on a second host with its own clock is the one thing
that arrangement cannot absorb, so the signing key stays in mktr-platform — which already
has the proxy, the serialising advisory lock, the budget guard and the alerting.

Consequences worth stating plainly:

- The voice droplet holds **one** secret we mint ourselves and can rotate, not PDPC's identity.
- The voice droplet never talks to the `dnc-egress` droplet, so tightening that proxy's
  firewall later does not involve mktr-bot.
- mktr-platform being down blocks *scrubbing*, never *dialling* — the dial gate reads stored
  records. This is only true because the check is batch and ahead-of-time.

---

## 3. Part A — mktr-platform: `POST /api/external/dnc-batch`

**Built 2026-09-11, unmounted.** `backend/src/routes/externalDncBatch.js` +
`backend/src/controllers/externalDncBatchController.js`, tests in
`backend/test/unit/externalDncBatchController.test.js`. Mounted beside the existing
`/api/external/*` family, which already gets raw-body capture and the rate-limiter
exemption from `server_internal.js`. This section is the contract as shipped.

**Auth:** HMAC-SHA256 over the raw body, `X-Webhook-Signature: sha256=<hex>`, freshness
from the signed `timestamp` (≤5 min old, ≤2 min into the future), timing-safe compare —
the same wire contract as `/api/external/held-leads`. The secret is **dedicated**
(`EXTERNAL_DNC_BATCH_SECRET`, not `EXTERNAL_APP_SECRET`) so a compromised voice droplet
cannot reach the lead-ops, billing, wallet or held-lead endpoints.

**Request**

```jsonc
{ "timestamp": "2026-09-11T08:00:00.000Z",   // signed; freshness gated on this
  "caller": "mktr-bot",                       // REQUIRED, ≤64 chars; audit attribution only
  "numbers": ["91234567", "81234567"] }       // 1–100, unique, 8-digit SG
```

`caller` is required and rejected with 400 `caller_required` when absent — it is what the
audit line and Sentry context name when a spend has to be traced back, and it is never
trusted for authorisation (the secret is the only thing that grants access).

**Response 200** — the only response that carries verdicts.

```jsonc
{ "success": true,
  "data": {
    "statusCode": "S000",
    "transactionId": "105965540",
    "createdTime": "2026-09-11 16:00:02",       // PDPC's string, no timezone — evidence only
    "validUntil": "2026-10-02T15:59:59.000Z",   // PDPC's ~30-day validity, or null
    "results": [ { "number": "91234567", "noVoiceCall": false, "noTextMessage": false, "noFax": false } ]
  } }
```

Verdicts come back in the **requested order**, with one entry per requested number, in the
normalised 8-digit form.

`transactionId` is always a non-empty string on a 200 — it becomes the clearance
`reference`, and `ConsentPolicy` refuses to dial on a clearance whose reference is blank,
so a verdict that cannot be evidenced is not permission. `createdTime` and `validUntil`
are **nullable**: they are PDPC's own metadata, read by no gate, and `validUntil` is
parsed out of a human-readable `msg` ("…valid until 06-Nov-2020"), so any wording change
on PDPC's side nulls it. A client must accept null for those two — rejecting the batch
would discard up to 100 verdicts the Registry has already billed for. The binding expiry
is the caller's own `checkedAt + 21 days` either way (§4).

**Every error** uses one envelope; `statusCode`/`reason` appear only when PDPC answered:

```jsonc
{ "success": false, "error": "insufficient_credits", "message": "…",
  "statusCode": "S301", "reason": "insufficient_credits" }
```

**The one contract detail that matters most: this endpoint must never fail open.**
`/api/dnc/check` deliberately collapses every error to `registered:false` because a broken
check must not block a consumer's form submission. The opposite is required here — a caller
that cannot tell "not on the register" from "we never got an answer" will mint a false
clearance and dial a registered number. So:

| Situation | HTTP | `error` | Sentry |
|---|---|---|---|
| PDPC `S000` with a verdict for every requested number | 200 | — | — |
| PDPC `S301` insufficient credits | 402 | `insufficient_credits` | yes |
| PDPC `S401`/`S402`/`S404` auth, `S403` timestamp, `S101`/`S102`/`S405` bad request | 502 | `dnc_rejected` | yes |
| PDPC `S000` missing a verdict for any requested number | 502 | `incomplete_results` | yes |
| PDPC `S501` | 503 | `dnc_error` | — |
| null or unrecognised status code | 503 | `unknown_status` | yes |
| transport error / timeout | 503 | `dnc_unreachable` | yes |
| DNC not configured or disabled | 503 | `dnc_unavailable` | — |
| Over budget | 429 | `budget_exceeded` | — |
| empty, >100, duplicate or non-SG `numbers`; missing `caller` | 400 | `numbers_required` · `too_many_numbers` · `duplicate_numbers` · `invalid_numbers` · `caller_required` | — |
| bad signature, stale or future timestamp | 401 | `unauthorized` | — |
| raw body over 64 KB | 413 | `payload_too_large` | — |
| `EXTERNAL_DNC_BATCH_SECRET` unset, or raw body not captured | 500 | `server_misconfigured` | — |

Three details the earlier draft of this section did not cover, all of them the same rule
applied further:

- **A partial `S000` is not an answer.** If the Registry answers `S000` but the result set
  does not contain every requested number, the whole batch fails with 502
  `incomplete_results` and no verdicts. A partial 200 is exactly the false clearance this
  endpoint exists to prevent.
- **A null status code alerts.** `mapStatusCode` raises no alert on its `default` branch.
  `parseResponse` now reads both the flat `status_code` and the `{ errorTo: { code } }`
  envelope (merged in mktr-platform #483), but PDPC has said the envelope may change
  again, and an empty body, an unparsable body or an HTML error page from the egress
  proxy all parse to null — a code we cannot read means we cannot say WHY there is no
  verdict, which is exactly what a human needs to hear. 503 `unknown_status` + Sentry.
- **Duplicates are judged on the normalised form**, so `+6591234567` and `91234567` in one
  request is a duplicate — it would bill twice for one number.

Nothing is billed for a 400/401/413: validation and auth both run before the Registry call.

**Allow at least 40 seconds for a reply.** mktr-platform serialises every Registry call
through one `dnc_call` Postgres advisory lock taken with `SET LOCAL lock_timeout = '30s'`,
then allows `DNC_TIMEOUT_MS` (5s) for PDPC itself — so a batch that queues behind a
capture-time check or the 30-minute backfill sweep can take ~35s to answer. A client
timeout below that abandons a request PDPC still bills for: the credits are spent, the
gateway returns 200 to nobody, and no evidence is written. Fail-closed, but paid for.

**Budget isolation.** `checkNumbers` decrements one in-process hourly budget shared by every
caller (`DNC_HOURLY_BUDGET`, default 1,000). A single 1,000-contact import would consume the
entire hour and starve the live lead funnel. Batch callers therefore spend from
`DNC_BATCH_HOURLY_BUDGET` (default **500**), injected through the `deps.withinBudget` hook
`checkNumbers` already accepts — which *replaces* the global counter for these calls, so the
two pools are independent in both directions. `0` freezes the endpoint without unmounting
it. A batch larger than the remaining allowance bills nothing at all (the guard runs on the
whole batch, before the call).

**Operator provisioning** (`backend/env.example`, all three default to inert):

| Variable | Default | Purpose |
|---|---|---|
| `DNC_BATCH_EXTERNAL_ENABLED` | `false` | Route flag — the route is **not mounted** until `true` |
| `EXTERNAL_DNC_BATCH_SECRET` | *(empty)* | Dedicated HMAC secret, same value on both hosts (`openssl rand -hex 32`) |
| `DNC_BATCH_HOURLY_BUDGET` | `500` | Batch-only credit allowance |

The endpoint also needs the platform's existing DNC credential set live
(`DNC_API_ENABLED=true` + org code + eService id + private key, and the egress proxy in
prod); without it every request answers 503 `dnc_unavailable` and bills nothing.

---

## 4. Part B — mktr-bot: built import checking

`server/dnc.ts` imports only shared domain types from `src/`. One `DncChecker` per API/store
serializes runs and rechecks coverage before sending, avoiding concurrent duplicate spend.

```
new DncChecker(store, config).scrubPhones(phones, maxCredits) →
  keep +65XXXXXXXX only
  drop phones with valid recorded consent
  drop phones with a verifiable result inside 21 days (positive or negative; never future)
  dedupe
  enforce the operator-confirmed maximum credit count before sending anything
  chunk 100 → one signed gateway POST per chunk
  on complete S000 → one DncClearance per number
  on anything else → write nothing for that batch, return failure, stop the run
```

**Record written per number**

| Field | Value |
|---|---|
| `phone` | `+65` + the eight digits |
| `checkedAt` | Time the response was received, never the timezone-free `createdTime` |
| `recordedAt` | Server recording time |
| `cleared` | `noVoiceCall === false`; text/fax registration does not block voice calls |
| `source` | Literal `Singapore DNC Registry` |
| `reference` | PDPC `transactionId` |
| `evidence` | `statusCode: "S000"`, `createdTime`, `validUntil`, `noVoiceCall`, `noTextMessage`, `noFax` |

`checkedAt + 21 days` stays the binding expiry. The returned validity date is evidence,
not an extension of local permission; `compliance.ts` is unchanged. Confirmed in
`prisma/schema.prisma` and `PrismaStore.writeDncClearance`: the complete record is stored
in `snapshot Json` and restored from that snapshot, so the evidence requires no migration.

The checker requires HTTP 200, `success:true`, `statusCode:S000`, a transaction ID,
creation/validity metadata, three actual boolean flags and an exact one-to-one match to
requested numbers. Missing, duplicate, extra or substituted results invalidate the whole
batch before any write. Non-S000 codes are preserved from top-level, `data` or `error`
envelopes. Responses are bounded to 128 KB and requests to ten seconds; redirects and
retries are disabled. A transport error or lost/invalid reply may already have spent
credits, so the UI reports uncertainty rather than claiming zero spend.

**Hook point:** checking follows `importContacts` in the route, after import durability.
With the flag unset, the original strict `{csv}` request and
`{ imported, duplicates, contacts }` HTTP 201 response are unchanged. When enabled, the
request is `{csv, maxDncCredits}` and the response adds a `dnc` object:

| Field | Meaning |
|---|---|
| `checked`, `cleared`, `registered` | Numbers with durably recorded complete S000 results, split by voice registration |
| `skippedAlreadyCovered` | Unique Singapore numbers with valid consent or fresh positive/negative Registry evidence |
| `skippedNotSingapore` | Unique input numbers outside +65 plus eight digits |
| `failed` | Eligible numbers left without a confirmed recorded result, including the unsent remainder |
| `submitted` | Numbers included in outgoing requests; not proof of billing or a balance |
| `failure` | Optional `statusCode`, gateway `httpStatus`, contextual `message` and `billingUncertain` |

A failed or ambiguous batch creates no evidence and never fails the successful import.
Earlier complete S000 batches retain their evidence; the failed batch and remaining
unsent numbers need a successful check or valid recorded consent before dialing. If
coverage changes after preview and the confirmed credit cap is too small, checking stops
with `preview_changed` before sending anything, while retaining the import. Consent or
fresh evidence arriving in the meantime can reduce actual spending below the preview.

**Configuration names:** `MKTR_DNC_GATEWAY_URL`, `MKTR_DNC_GATEWAY_SECRET`,
`MKTR_DNC_ENABLED`. Only the exact enable value `true` activates checking. The URL is the
complete batch endpoint and must use HTTPS without embedded credentials or a fragment;
HTTP loopback is accepted for fake gateway tests. The dedicated shared secret requires
at least 32 characters. Missing or invalid configuration reports a check failure without
rolling back import. No upstream Registry credentials belong in this application.

**Free preview:** authenticated `POST /api/contacts/preview` accepts `{csv}` and shares
`previewContacts` with import for all CSV validation, normalization and deduplication. It
writes nothing and returns `imported`, `duplicates`, `needsCheck`, `alreadyCovered`,
`notSingapore`, `credits` and `dncEnabled`. Counts concern new contacts only; existing
contact-book duplicates are not rechecked on reimport. Credits are zero while disabled.
The UI invalidates the preview on CSV changes and confirms its price as `maxDncCredits`.

**Permission summary:** authenticated `GET /api/compliance/summary` returns `dncEnabled`
and a `contacts` array for every contact: `phone`, `dialable`, `basis` (consent, dnc or
null), `clearanceExpiresAt` and any `skipReason`. It delegates permission to
`ConsentPolicy`. The UI polls this single endpoint rather than requesting each contact,
shows blocked rows distinctly, and summarizes total/dialable/blocked contacts and reasons
in campaign detail. Blocked contacts remain selectable; the dial gate enforces permission.

**One-number action:** authenticated `POST /api/compliance/dnc/check` accepts a Singapore
`phone` and `maxCredits:1`. The UI states the one-credit cost before clicking; valid consent
or a fresh result reduces actual checking to zero. It uses the same checker and evidence
path, and returns 503 while disabled. Existing manual evidence routes remain available.

---

## 5. Expiry refresh — automatic paid sweep cancelled

Checking at import means clearance expires 21 days after receipt, regardless of campaign
progress. The original draft proposed a background sweep. That would spend credits
without showing and confirming a credit count, so it is cancelled for this implementation.
Rows instead show a warning and Singapore expiry date within three days. The operator can
use the explicit one-credit action after expiry or record externally obtained evidence.
A fresh result, including one close to expiry, is not rechecked. Expired campaigns remain
subject to the unchanged dial gate. A future bulk refresh would require its own explicit
preview and spending confirmation; no scheduler or hidden renewal is shipped.

---

## 6. Credit safety

- Never recheck within validity, including registered results, or check valid consent.
- Reimport ignores existing contacts. One campaign's result is reusable for every campaign
  until the 21-day expiry. Recorded opt-outs continue blocking even after a clear result.
- CSV import retains the 1,000-contact / 1 MB limits. Requests carry at most 100 numbers.
- Preview and the confirmation button show the intended credits before any paid request.
- `maxDncCredits` caps the run even if coverage changes before import; single checks cap at one.
- Any non-S000 status, including S301 insufficient credits, stops the run immediately.
- `checked` confirms stored S000 results; `submitted` counts numbers sent. Failed-request
  billing and account balance are not inferred. Lost replies are never retried automatically.
- Permission reads, previews, contact selection and campaign start never purchase checks.

---

## 7. Verification

`server/dnc.test.ts` exercises the checker and authenticated HTTP routes against a fake
loopback gateway that verifies HMAC against the exact received bytes:

- one request for 100 numbers and two for 101; ISO timestamps and receipt-time evidence
- zero requests for valid consent/fresh positive or negative results; input/concurrent dedupe
- every non-S000 status creates zero records and preserves its status code
- malformed/partial S000, duplicate/extra/substituted numbers, missing or nonboolean flags,
  absent evidence, redirect, oversized response, lost reply and timeout create no clearance
- a later failure retains only earlier complete S000 evidence and stops further batches
- voice-registered numbers are refused with the existing register skip reason; text/fax-only
  registration permits a simulated voice dial; opt-outs remain authoritative
- preview validation/duplicates match import and write nothing; unset flag keeps legacy import
- an unreachable gateway retains imported contacts, reports failure and leaves them undialable
- session protection, explicit credit limits, changing coverage and aggregate permission status

`tests/dnc.spec.ts` exercises the built UI and real HTTP routes with a separate fake gateway:
pasted/file preview before spending, register state while still selectable, failed-import
outcome, one-number action/manual paths and expiring clearance dates. The ordinary browser
API explicitly leaves DNC disabled. `npm run build` supplies the built UI used by these tests.
The Prisma integration suite verifies automatic evidence survives a disposable database restart.

Required checks: `npm run lint`, `npm test`, `npm run build`,
`npx playwright install chromium && npm run test:e2e`. No live gateway or Registry calls.

Separately required on mktr-platform: signature/freshness rejection, input limits, S301
passthrough as HTTP 402 and budget isolation from capture-time checks. These are not
claimed as verified by the mktr-bot fake gateway tests.

---

## 8. Operator rollout order

All provisioning, activation, purchases and live checks below belong to the operator.

1. Deploy and verify the mktr-platform batch endpoint while disabled, including dedicated
   authentication, timestamp checks, serialization and isolated batch budget. Deploy
   mktr-bot with its flag unset. The gateway implementation is outside this repository.
2. Confirm the Registry account, tariff and available prepaid credits in the org portal;
   only the operator buys credits or arranges upstream access.
3. Mint a dedicated shared secret of at least 32 characters and provision it privately on
   both hosts. Configure mktr-bot's complete gateway URL and secret; keep its flag off.
4. Enable the gateway after its configuration and budget are ready, then enable
   `MKTR_DNC_ENABLED` on the voice host and restart the API. Telephony mode is unaffected.
5. Use the UI's explicit one-credit check or a small CSV preview, inspect the displayed
   credits and deliberately confirm the paid action. Verify the actual transaction,
   evidence and permission state, including an operator-authorized registered-number check.
   Turning the flag off stops further paid checks; stored evidence still expires normally.

Documentation and C2a evidence ship with the code. Real gateway activation and billing
verification have not been performed by the agent.

---

## 9. Resolved decisions and operational follow-up

- Operator: confirm the credit tariff and current balance in the Registry org portal;
  the API cannot report a balance and signals S301 once credits are insufficient.
- Resolved: registered numbers remain stored and selectable; fresh negative evidence
  prevents repeat spend, reimport ignores duplicates and the unchanged dial gate blocks
  attempts without later valid consent or clearance.
- Cancelled: automatic paid expiry sweep, because it would bypass spending confirmation.
- Gateway error-envelope compatibility remains an mktr-platform integration responsibility;
  this client preserves documented codes and refuses incomplete or unknown successes.
- Implementation choices and their reasons are recorded under C2a in `docs/decisions.md`.
