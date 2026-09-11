import assert from "node:assert/strict";
import test from "node:test";
import type { CallEvent, CallSession } from "../src/lib/domain.js";
import { callTranscript, listCallSummaries, summariseCall } from "./call-history.js";

const lookups = {
  contactName: (id: string) => ({ "contact-1": "Jane Tan", "contact-2": "Sam Lim" })[id],
  campaignName: (id: string) => ({ "campaign-1": "September outreach" })[id],
};

const event = (type: CallEvent["type"], timestamp: string, detail?: string, extra: Partial<CallEvent> = {}): CallEvent =>
  ({ id: `${type}-${timestamp}`, type, timestamp, title: type, detail, ...extra });

function call(overrides: Partial<CallSession> = {}): CallSession {
  return {
    id: "call-1", providerCallId: "p-1", destination: "+6591234567", callerId: "+6562773211",
    flowId: "flow-1", flowVersion: 3, status: "ended", createdAt: "2026-09-11T02:00:00.000Z",
    endedAt: "2026-09-11T02:01:30.000Z", events: [], ...overrides,
  } as CallSession;
}

test("the transcript interleaves what the bot played and what the caller said, in order", () => {
  const turns = callTranscript(call({
    events: [
      event("clip_playing", "2026-09-11T02:00:05.000Z", "Hello, this is MKTR calling about your enquiry."),
      event("transcript_final", "2026-09-11T02:00:12.000Z", "Yes, I remember.", { nodeId: "listen-1", latencyMs: 420 }),
      event("classified", "2026-09-11T02:00:13.000Z", "intent=interested"),
      event("clip_playing", "2026-09-11T02:00:15.000Z", "Great — may I book a time?"),
      event("transcript_final", "2026-09-11T02:00:21.000Z", "Tomorrow afternoon works."),
    ],
  }));

  assert.deepEqual(turns.map((turn) => [turn.role, turn.text]), [
    ["agent", "Hello, this is MKTR calling about your enquiry."],
    ["caller", "Yes, I remember."],
    ["agent", "Great — may I book a time?"],
    ["caller", "Tomorrow afternoon works."],
  ]);
  // Classification and other timeline noise is not conversation.
  assert.equal(turns.length, 4);
  assert.equal(turns[1].latencyMs, 420);
  assert.equal(turns[1].nodeId, "listen-1");
});

test("events out of order are sorted, and empty or absent text is not a turn", () => {
  const turns = callTranscript(call({
    events: [
      event("transcript_final", "2026-09-11T02:00:30.000Z", "Second"),
      event("clip_playing", "2026-09-11T02:00:10.000Z", "First"),
      event("transcript_final", "2026-09-11T02:00:40.000Z", "   "),
      event("clip_playing", "2026-09-11T02:00:50.000Z"),
    ],
  }));
  assert.deepEqual(turns.map((turn) => turn.text), ["First", "Second"]);
});

test("a summary resolves contact and campaign names and computes duration", () => {
  const summary = summariseCall(call({
    contactId: "contact-1", campaignId: "campaign-1", outcome: "interested",
    dialAuthorization: { basis: "dnc", recordId: "rec-1", checkedAt: "2026-09-11T01:00:00.000Z" },
    events: [event("transcript_final", "2026-09-11T02:00:12.000Z", "Yes")],
  }), lookups);

  assert.equal(summary.contactName, "Jane Tan");
  assert.equal(summary.campaignName, "September outreach");
  assert.equal(summary.durationSeconds, 90);
  assert.equal(summary.transcriptTurns, 1);
  assert.equal(summary.dialBasis, "dnc");
  assert.equal((summary as unknown as { events?: unknown }).events, undefined, "the list projection must not carry the event array");
});

test("an expired recording is not advertised as available", () => {
  const past = new Date(Date.now() - 86400000).toISOString();
  const future = new Date(Date.now() + 86400000).toISOString();
  assert.equal(summariseCall(call({ recordingFile: "a.wav", recordingExpiresAt: past }), lookups).hasRecording, false);
  assert.equal(summariseCall(call({ recordingFile: "a.wav", recordingExpiresAt: future }), lookups).hasRecording, true);
  assert.equal(summariseCall(call({ recordingFile: "a.wav" }), lookups).hasRecording, false);
});

test("history is newest first, filtered, and paged without repeating or skipping a row", () => {
  const calls = Array.from({ length: 5 }, (_, index) => call({
    id: `call-${index}`,
    createdAt: `2026-09-11T02:0${index}:00.000Z`,
    campaignId: index % 2 === 0 ? "campaign-1" : "campaign-2",
  }));

  const first = listCallSummaries(calls, { limit: 2 }, lookups);
  assert.deepEqual(first.calls.map((row) => row.id), ["call-4", "call-3"]);
  assert.equal(first.total, 5);
  assert.ok(first.nextCursor);

  const second = listCallSummaries(calls, { limit: 2, cursor: first.nextCursor! }, lookups);
  assert.deepEqual(second.calls.map((row) => row.id), ["call-2", "call-1"]);

  const third = listCallSummaries(calls, { limit: 2, cursor: second.nextCursor! }, lookups);
  assert.deepEqual(third.calls.map((row) => row.id), ["call-0"]);
  assert.equal(third.nextCursor, null, "the final page ends the walk");

  const filtered = listCallSummaries(calls, { campaignId: "campaign-1" }, lookups);
  assert.deepEqual(filtered.calls.map((row) => row.id), ["call-4", "call-2", "call-0"]);
  assert.equal(filtered.total, 3);
});

test("search matches the destination or the contact name, case-insensitively", () => {
  const calls = [
    call({ id: "a", destination: "+6591234567", contactId: "contact-1" }),
    call({ id: "b", destination: "+6588887777", contactId: "contact-2" }),
  ];
  assert.deepEqual(listCallSummaries(calls, { search: "jane" }, lookups).calls.map((row) => row.id), ["a"]);
  assert.deepEqual(listCallSummaries(calls, { search: "8888" }, lookups).calls.map((row) => row.id), ["b"]);
  assert.deepEqual(listCallSummaries(calls, { search: "nobody" }, lookups).calls, []);
});

test("an unknown cursor returns nothing rather than silently restarting at page one", () => {
  const calls = [call({ id: "a" }), call({ id: "b", createdAt: "2026-09-11T03:00:00.000Z" })];
  const page = listCallSummaries(calls, { cursor: "2026-01-01T00:00:00.000Z|deleted-call" }, lookups);
  assert.deepEqual(page.calls, []);
  assert.equal(page.nextCursor, null);
});
