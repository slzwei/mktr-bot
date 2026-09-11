# Contacts and campaigns

Open **Campaigns** while signed in. Import UTF-8 CSV with a required `phone` header and optional `name` header, for example:

```csv
name,phone
Example contact,91234567
```

Singapore local eight-digit numbers starting with 3, 6, 8 or 9 gain `+65`; Singapore numbers beginning `65` and international numbers beginning `+` or `00` are also accepted. Spaces, parentheses, periods and hyphens are removed. Extensions, letters, invalid Singapore lengths, malformed quoting and unsupported headers are rejected. Import validates all rows before one transaction and limits each batch to 1,000 contacts / 1 MB. Duplicate normalized phone numbers are ignored, preserving the existing contact and its history. CSV data alone grants no permission. With optional Registry checking enabled, the free preview states the paid credit count before confirmation, and a successful import checks eligible new Singapore numbers in batches of 100. Results and failures appear after import; failed checks leave contacts imported and subject to the existing permission gate. See [batch checking](dnc-batch-checking.md).

Select contacts, an approved caller ID, and a published flow. Creation pins that exact published version and caller ID, even if the flow is later edited or archived. Campaign membership is fixed: create another campaign when changing the audience, caller ID or flow version. Caller-ID choices come from `CALLER_IDS` in `src/lib/domain.ts`.

Calling hours default to Monday–Saturday, 09:00 inclusive until 20:00 exclusive, in `Asia/Singapore`. Each campaign uses one same-day time window and selected weekdays. `24:00` is allowed as the end of a day; overnight windows are unsupported. Starting outside permitted hours leaves the campaign running and waiting for its window. These are operating defaults, not an assertion that a particular marketing call is legally permitted.

The single API process runs one scheduler. It starts at most one call per 250 ms tick, with a default minimum 1,000 ms between starts in the same campaign. Total active calls count against `MKTR_MAX_CONCURRENT_CALLS`, including test-console calls and other campaigns; the orchestrator independently enforces the five-call trunk ceiling. Defaults are three attempts per contact with 60 seconds between busy/no-answer retries. Operators may configure 1–5 attempts, retry delays of 1–86,400 seconds, and dial spacing of 100–60,000 ms. Other terminal outcomes finish the contact. Policy refusals are skipped with a visible reason and consume no dial attempt.

**Pause** prevents new attempts and lets calls already underway finish. **Start** resumes a paused campaign. **Stop** ends active calls and marks queued contacts skipped; stopped and completed campaigns cannot restart. If channel termination cannot be confirmed, the API returns an error and call history retains the active channel for operator review. Live progress shows attempts, outcomes, next retry times and skip/error reasons, refreshing every second.

Each attempt commits before the provider side effect. On API restart, call reconciliation runs before the dialer starts. Confirmed call IDs and outcomes restore from Postgres. An attempt interrupted before a call ID was confirmed is marked `interrupted` and requires review of provider records before starting another campaign for that contact. This avoids repeating an originate whose delivery is uncertain. Scheduler failures halt further starts and log context; inspect storage/provider health before restarting the API. Shutdown closes and awaits the scheduler before draining calls and disconnecting Postgres.

Authenticated routes are `GET /api/contacts`, `POST /api/contacts/preview`, `POST /api/contacts/import`, `GET /api/compliance/summary`, `GET /api/campaigns`, `POST /api/campaigns`, `GET /api/campaigns/:id`, and `POST /api/campaigns/:id/:action` (`start`, `pause`, `stop`). Free preview accepts `{csv}`. Import accepts `{csv}` while Registry checking is disabled, or `{csv, maxDncCredits}` with the displayed credit count when enabled; controls accept `{}`. The permission summary covers every contact in one request, including the basis, expiry and blocking reason. Creation accepts `name`, `flowId`, `callerId`, `contactIds` and optional `flowVersion`, `callingHours`, `maxAttempts`, `retryDelaySeconds`, `dialIntervalMs`. Timestamps are stored in UTC; calling hours and displayed next attempts use Singapore time.

Campaign behavior is verified against fake ESL and the simulator; media transcription is separately verified against fake STT. No real calls were placed. Shawn owns the first real-call procedure in `docs/runbook-first-live-call.md`.
