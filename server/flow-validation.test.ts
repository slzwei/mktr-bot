import assert from "node:assert/strict";
import test from "node:test";
import { validateFlow } from "./flow-validation.js";
import { InMemoryStore } from "./store.js";

test("flow publication accepts the complete reachable demo and rejects a dangling connection", () => {
  const store = new InMemoryStore();
  const flow = store.getFlow("flow-prospect-intake")!;
  assert.equal(validateFlow(flow, store.listClips()).valid, true);
  flow.edges.push({ id: "broken", source: "start", target: "missing" });
  assert.equal(validateFlow(flow, store.listClips()).valid, false);
});

test("flow publication rejects unavailable clips, unreachable nodes and a missing listening fallback", () => {
  const store = new InMemoryStore();
  const flow = store.getFlow("flow-prospect-intake")!;
  flow.nodes.find((node) => node.id === "opening")!.data.clipId = "missing-clip";
  flow.nodes.push({ id: "orphan", type: "end", position: { x: 0, y: 0 }, data: { label: "Unreachable end" } });
  flow.edges.find((edge) => edge.source === "listen")!.condition = {};
  const result = validateFlow(flow, store.listClips());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /ready audio clip/.test(error)));
  assert.ok(result.errors.some((error) => /unreachable/.test(error)));
  assert.ok(result.errors.some((error) => /fallback/.test(error)));
});
