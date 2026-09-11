import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ConsentPolicy, DialConsentError, type ConsentRecord, type DncClearance, type DialPermissionStore } from "./compliance.js";
import { logger } from "./logger.js";

export interface ComplianceStore extends DialPermissionStore {
  saveConsent(record: ConsentRecord): ConsentRecord;
  saveDncClearance(record: DncClearance): DncClearance;
  flush(): Promise<void>;
}
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/, "Use an E.164 phone number.");
const source = z.string().trim().min(3).max(500);
const pastTimestamp = z.string().datetime({ offset: true }).refine((value) => Date.parse(value) <= Date.now(), "Evidence timestamp cannot be in the future.");

/** Mounted only behind the operator session middleware. */
export function complianceRoutes(store: ComplianceStore) {
  const router = Router();
  router.get("/:phone", async (request, response) => {
    const number = phone.parse(request.params.phone);
    await store.flush();
    let decision: { allowed: boolean; basis?: string; skipReason?: string };
    try { decision = { allowed: true, basis: new ConsentPolicy(store).authorize(number).basis }; }
    catch (error) { if (!(error instanceof DialConsentError)) throw error; decision = { allowed: false, skipReason: error.skipReason }; }
    response.json({ phone: number, ...decision, consent: store.getConsent(number), dnc: store.getDncClearance(number) });
  });
  router.post("/consent", async (request, response) => {
    const body = z.object({ phone, source, consentedAt: pastTimestamp, purpose: z.literal("voice_marketing") }).strict().parse(request.body);
    const record = store.saveConsent({ ...body, id: randomUUID(), recordedAt: new Date().toISOString() });
    await store.flush();
    logger.info({ recordId: record.id, operatorId: response.locals.operator.id }, "Voice consent evidence recorded");
    response.status(201).json(record);
  });
  router.post("/opt-out", async (request, response) => {
    const body = z.object({ phone, source }).strict().parse(request.body);
    const now = new Date().toISOString();
    const record = store.saveConsent({ ...body, id: randomUUID(), recordedAt: now, consentedAt: store.getConsent(body.phone)?.consentedAt ?? now, purpose: "voice_marketing", revokedAt: now });
    await store.flush();
    logger.info({ recordId: record.id, operatorId: response.locals.operator.id }, "Voice marketing opt-out recorded");
    response.status(201).json(record);
  });
  router.post("/dnc", async (request, response) => {
    const body = z.object({ phone: phone.regex(/^\+65\d{8}$/), checkedAt: pastTimestamp, cleared: z.boolean(), source: z.literal("Singapore DNC Registry"), reference: source }).strict().parse(request.body);
    const record = store.saveDncClearance({ ...body, id: randomUUID(), recordedAt: new Date().toISOString() });
    await store.flush();
    logger.info({ recordId: record.id, operatorId: response.locals.operator.id }, "DNC result evidence recorded");
    response.status(201).json(record);
  });
  return router;
}
