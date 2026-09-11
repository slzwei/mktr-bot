import type { CallListPage, CallSession, CallSummary, TranscriptTurn } from "../src/lib/domain.js";

/**
 * Call history projections. Pure functions over stored calls — no new state.
 *
 * Two jobs:
 *  - `callTranscript` rebuilds the conversation from the event timeline, so the UI
 *    renders turns instead of re-deriving them from raw events.
 *  - `listCallSummaries` pages and filters the history. The list deliberately omits
 *    the `events` array: a 500-contact campaign produces thousands of calls, each
 *    carrying its whole timeline, and `/api/bootstrap` used to ship all of it at once.
 */

/** What the bot said (a clip) and what the caller said (a final transcript), in order. */
export function callTranscript(call: Pick<CallSession, "events">): TranscriptTurn[] {
  return (call.events ?? [])
    .filter((event) => (event.type === "transcript_final" || event.type === "clip_playing") && Boolean(event.detail?.trim()))
    .map((event) => ({
      at: event.timestamp,
      role: event.type === "transcript_final" ? ("caller" as const) : ("agent" as const),
      text: event.detail!.trim(),
      nodeId: event.nodeId,
      latencyMs: event.latencyMs,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

function durationSeconds(call: CallSession): number | null {
  if (!call.endedAt) return null;
  const ms = Date.parse(call.endedAt) - Date.parse(call.createdAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
}

export type CallHistoryQuery = {
  limit?: number;
  cursor?: string;
  campaignId?: string;
  contactId?: string;
  status?: string;
  outcome?: string;
  /** Case-insensitive substring over the destination number and contact name. */
  search?: string;
};

export type CallHistoryLookups = {
  contactName(contactId: string): string | undefined;
  campaignName(campaignId: string): string | undefined;
};

export function summariseCall(call: CallSession, lookups: CallHistoryLookups): CallSummary {
  return {
    id: call.id,
    destination: call.destination,
    callerId: call.callerId,
    contactId: call.contactId,
    contactName: call.contactId ? lookups.contactName(call.contactId) : undefined,
    campaignId: call.campaignId,
    campaignName: call.campaignId ? lookups.campaignName(call.campaignId) : undefined,
    flowId: call.flowId,
    flowVersion: call.flowVersion,
    status: call.status,
    outcome: call.outcome,
    direction: call.direction,
    createdAt: call.createdAt,
    endedAt: call.endedAt,
    durationSeconds: durationSeconds(call),
    endReason: call.endReason,
    // A recording that has passed its retention expiry is gone; do not advertise it.
    hasRecording: Boolean(call.recordingFile && call.recordingExpiresAt && Date.parse(call.recordingExpiresAt) > Date.now()),
    transcriptTurns: callTranscript(call).length,
    dialBasis: call.dialAuthorization?.basis ?? null,
  };
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Newest first, cursor-paged on `createdAt|id` so a call created mid-page cannot
 * shift rows onto a page the caller has already read.
 */
export function listCallSummaries(calls: CallSession[], query: CallHistoryQuery, lookups: CallHistoryLookups): CallListPage {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const needle = query.search?.trim().toLowerCase();

  const ordered = [...calls].sort((a, b) => `${b.createdAt}|${b.id}`.localeCompare(`${a.createdAt}|${a.id}`));

  const matched = ordered.filter((call) => {
    if (query.campaignId && call.campaignId !== query.campaignId) return false;
    if (query.contactId && call.contactId !== query.contactId) return false;
    if (query.status && call.status !== query.status) return false;
    if (query.outcome && call.outcome !== query.outcome) return false;
    if (needle) {
      const name = call.contactId ? lookups.contactName(call.contactId) ?? "" : "";
      if (!`${call.destination} ${name}`.toLowerCase().includes(needle)) return false;
    }
    return true;
  });

  const start = query.cursor ? matched.findIndex((call) => `${call.createdAt}|${call.id}` === query.cursor) + 1 : 0;
  // An unknown cursor (a deleted call, a doctored value) restarts at the top rather
  // than silently returning the whole list from index 0 as if it were page one.
  const from = query.cursor && start === 0 ? matched.length : start;
  const page = matched.slice(from, from + limit);
  const last = page[page.length - 1];

  return {
    calls: page.map((call) => summariseCall(call, lookups)),
    nextCursor: last && from + limit < matched.length ? `${last.createdAt}|${last.id}` : null,
    total: matched.length,
  };
}
