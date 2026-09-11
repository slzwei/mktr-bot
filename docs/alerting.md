# Health, logs, and alerts

The API writes JSON pino logs to stdout. Every HTTP record includes its generated `requestId`; call routes and call-state records also include `callId`. Unexpected request failures log an error-level `err` object with its stack, while the response exposes only a generic message and request ID. Logs omit transcripts, credentials, raw ESL replies and phone-number metric labels. Use `LOG_LEVEL` to adjust verbosity; the default is `info`.

`GET /api/health` is an unauthenticated readiness check. Simulator responses are HTTP 200 with `gateway: "n/a"` and `esl: "n/a"`. For a configured gateway, the API queries `sofia status gateway singtel` through the existing authenticated ESL client. Only an exact `State REGED` and a connected ESL client produce 200; unregistered, disconnected, unconfigured, malformed-reply or timed-out probes produce 503. Parallel checks share one pending command, the result is cached for one second, and the response deadline is 1.5 seconds. The probe never originates or replays calls. Compose runs this readiness check every 30 seconds, with a three-second timeout and three retries.

`GET /metrics` exposes a `prom-client` registry. It is available on the loopback API binding or from trusted containers; Caddy returns 404 for the public path. Scrape it from a host-local Prometheus process at `127.0.0.1:8787/metrics` every 15–30 seconds. Metrics have fixed labels, with no phone numbers, call IDs, flow names or transcripts. No hosted monitoring account is needed.

| Metric | Meaning |
| --- | --- |
| `mktr_active_calls` | Current occupied slots from the orchestrator at scrape time |
| `mktr_calls_total{outcome}` | Calls reaching a terminal outcome since this process started |
| `mktr_classifier_duration_seconds{provider}` | Classification duration including rules fallback |
| `mktr_stt_duration_seconds{provider}` | Final-transcript delivery latency after the utterance ends |
| `mktr_turn_duration_seconds{provider}` | Speech end to reply playback start: the delay the callee hears, covering endpointing, transcription, delivery, classification and the ESL playback commands; buckets span 0.2–3 s |
| `mktr_classifier_fallbacks_total{reason}` | Provider failures or deadlines completed by rules |
| `mktr_gateway_registered{mode}` | Result of the most recent readiness probe |

For **gateway unregistered**, alert when `mktr_gateway_registered{mode="freeswitch"} == 0` persists for one minute, or when the external readiness monitor receives 503 twice. Also alert on `up == 0` for the API scrape job; a missing process produces no readiness gauge. Pause campaigns, inspect the `Gateway readiness changed` log with `esl`, `gateway` and `reason`, and use the private `fs_cli` diagnostics from the runbook. Check host egress, public-IP whitelist, TLS date/CA and credentials; never disable verification or raise the call ceiling to clear the alert.

For **call failure rate**, alert when `sum(increase(mktr_calls_total{outcome="failed"}[5m])) / clamp_min(sum(increase(mktr_calls_total[5m])), 1) > 0.2` and at least five calls completed in that window. Track busy and no-answer separately; they are expected contact outcomes, not infrastructure failures. Pause the affected campaign, correlate call IDs across the state and error logs, and inspect gateway readiness, classifier fallback rate, and the STT/classifier latency histograms before resuming. Counter resets after API restart are expected; use `rate`/`increase`, not subtraction of raw counter values.

Runtime integration uses the exported `voiceMetrics` instance: call `observeCall(session)` from the orchestrator's central publish path; `createApp` binds the active-call gauge to `activeCallCount()`. The classifier wrapper observes classification duration and fallback reason. The accepted media transcript path observes `sttLatencyMs` with the configured provider only after its window/utterance validation succeeds, so rejected/repeated webhooks cannot inflate timing samples. The same receipt anchors a turn at its arrival time minus `sttLatencyMs`; the turn is observed when the next clip's `playClip` command resolves and logged per call as `Turn completed`. A receipt without timing, or a reply that hangs up instead of playing a clip, produces no turn sample. Per-call terminal observations are idempotent within the bounded correlation history. Do not replay historical terminal database rows into the metrics after restart.

Verified with actual simulator HTTP/curl and fake ESL responses. The live registration, container healthcheck and host monitoring setup remain operator checks; Docker is not installed on host.
