import type { CallSession } from "./domain";
import { isCallInProgress } from "./operator-display";

/** Bootstrap reads and reconnect refetches can arrive behind an SSE snapshot. */
export function latestCallSnapshot(current: CallSession | undefined, incoming: CallSession): CallSession {
  if (!current || current.id !== incoming.id) return incoming;
  if (!isCallInProgress(current.status) && isCallInProgress(incoming.status)) return current;
  if (isCallInProgress(current.status) && !isCallInProgress(incoming.status)) return incoming;
  return incoming.events.length < current.events.length ? current : incoming;
}
