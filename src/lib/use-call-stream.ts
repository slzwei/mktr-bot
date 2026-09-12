import { useEffect, useState } from "react";
import { api } from "./api";
import type { CallSession } from "./domain";
import { latestCallSnapshot } from "./call-snapshot";
import { isCallInProgress } from "./operator-display";

/** One authenticated snapshot stream. Native retries handle dropped sockets;
 * permanently closed transports are recreated after one second. */
export function useCallStream(callId: string | undefined, enabled: boolean, onUpdated: (call: CallSession) => void) {
  const [state, setState] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  useEffect(() => {
    if (!callId || !enabled) return;
    let disposed = false;
    let finished = false;
    let resyncing = false;
    let messages = 0;
    let latest: CallSession | undefined;
    let events: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const accept = (call: CallSession) => {
      if (disposed || finished || call.id !== callId) return;
      latest = latestCallSnapshot(latest, call);
      if (!isCallInProgress(latest.status)) {
        finished = true;
        clearTimeout(retry);
        events?.close();
      }
      onUpdated(latest);
    };
    const resync = async () => {
      if (resyncing || disposed || finished) return;
      resyncing = true;
      const before = messages;
      try {
        const call = await api.getCall(callId);
        if (before === messages) accept(call);
      } catch {
        // Keep the last snapshot visible, with connection failure surfaced by the consumer.
        if (!disposed && !finished && before === messages) setState("reconnecting");
      } finally { resyncing = false; }
    };
    const connect = () => {
      if (disposed || finished) return;
      const stream = new EventSource(`/api/calls/${callId}/events`);
      events = stream;
      stream.onopen = () => {
        if (!disposed && !finished) { setState("connected"); void resync(); }
      };
      stream.onmessage = (event) => {
        if (disposed || finished) return;
        messages += 1;
        try { accept(JSON.parse(event.data) as CallSession); setState("connected"); }
        catch { setState("reconnecting"); void resync(); }
      };
      stream.onerror = () => {
        if (disposed || finished) return;
        setState("reconnecting");
        void resync();
        if (stream.readyState === EventSource.CLOSED) {
          clearTimeout(retry);
          retry = setTimeout(connect, 1000);
        }
      };
    };
    setState("connecting");
    connect();
    return () => { disposed = true; clearTimeout(retry); events?.close(); };
  }, [callId, enabled, onUpdated]);
  return state;
}
