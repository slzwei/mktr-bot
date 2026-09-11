import { CallOrchestrator } from "../orchestrator.js";
import type { DialPolicy } from "../compliance.js";

/** Explicit dependency injection for unrelated fake-provider behavior tests only.
 * This file is excluded from the production compiler and Docker build context. */
const fixturePolicy: DialPolicy = { authorize: () => ({ basis: "consent", recordId: "test-only-consent", checkedAt: new Date().toISOString() }) };
export class FixtureCallOrchestrator extends CallOrchestrator {
  constructor(...[store, adapter, classifier, playbackDelay, deadlines, policy]: ConstructorParameters<typeof CallOrchestrator>) {
    super(store, adapter, classifier, playbackDelay, deadlines, policy ?? fixturePolicy);
  }
}
