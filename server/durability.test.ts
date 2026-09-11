import assert from "node:assert/strict";
import test from "node:test";
import { FixtureCallOrchestrator as CallOrchestrator } from "./test-support/fixture-orchestrator.js";
import { InMemoryStore } from "./store.js";
import { SimulatedTelephonyAdapter } from "./telephony.js";

test("origination and SSE wait for the call UUID durability barrier without double-counting capacity", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  class StoreWithDelayedDisk extends InMemoryStore { override flush() { return barrier; } }
  class ObservedAdapter extends SimulatedTelephonyAdapter {
    originates = 0;
    override async originate(...args: Parameters<SimulatedTelephonyAdapter["originate"]>) { this.originates++; return super.originate(...args); }
  }
  const store = new StoreWithDelayedDisk(); const adapter = new ObservedAdapter(); const calls = new CallOrchestrator(store, adapter);
  const starts = Array.from({ length: 5 }, () => calls.start({ destination: "+6591234567", callerId: "+6562773211", flowId: "flow-prospect-intake" }));
  assert.equal(calls.activeCallCount(), 5); assert.equal(adapter.originates, 0);
  let updates = 0; const unsubscribe = calls.subscribe(store.listCalls()[0].id, () => { updates++; });
  await Promise.resolve(); assert.equal(updates, 0);
  release(); const sessions = await Promise.all(starts);
  assert.equal(adapter.originates, 5); assert.ok(updates >= 1);
  unsubscribe(); await Promise.all(sessions.map((call) => calls.stop(call.id)));
});
