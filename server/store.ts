import { HttpError } from "./http-error.js";
import type { ConsentRecord, DncClearance, DialPermissionStore } from "./compliance.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isCallerId, type CallSession, type Campaign, type CampaignContact, type Clip, type Contact, type FlowDefinition, type FlowNode, type OutcomeDelivery } from "../src/lib/domain.js";

const now = () => new Date().toISOString();

const clips: Clip[] = [
  {
    id: "clip-welcome",
    name: "Opening greeting",
    durationSeconds: 7,
    previewUrl: "/demo-clips/welcome.wav",
    format: "wav",
    status: "ready",
    usedBy: 1,
    updatedAt: now(),
    color: "teal"
  },
  {
    id: "clip-interest",
    name: "Interested response",
    durationSeconds: 7,
    previewUrl: "/demo-clips/interest.wav",
    format: "wav",
    status: "ready",
    usedBy: 1,
    updatedAt: now(),
    color: "blue"
  },
  {
    id: "clip-decline",
    name: "Not interested response",
    durationSeconds: 5,
    previewUrl: "/demo-clips/decline.wav",
    format: "wav",
    status: "ready",
    usedBy: 1,
    updatedAt: now(),
    color: "rose"
  },
  {
    id: "clip-callback",
    name: "Callback confirmation",
    durationSeconds: 6,
    previewUrl: "/demo-clips/callback.wav",
    format: "wav",
    status: "ready",
    usedBy: 1,
    updatedAt: now(),
    color: "orange"
  },
  {
    id: "clip-clarify",
    name: "Clarification prompt",
    durationSeconds: 4,
    previewUrl: "/demo-clips/clarify.wav",
    format: "wav",
    status: "ready",
    usedBy: 1,
    updatedAt: now(),
    color: "orange"
  }
];

const flowNodes: FlowNode[] = [
  {
    id: "start",
    type: "start",
    position: { x: 0, y: 260 },
    data: { label: "Start call", description: "Call answered" }
  },
  {
    id: "opening",
    type: "playClip",
    position: { x: 220, y: 260 },
    data: { label: "Opening greeting", clipId: "clip-welcome", description: "7 sec WAV" }
  },
  {
    id: "listen",
    type: "listen",
    position: { x: 455, y: 260 },
    data: { label: "Listen for reply", description: "Endpoint after 750 ms" }
  },
  {
    id: "classify",
    type: "classify",
    position: { x: 700, y: 260 },
    data: { label: "Classify response", threshold: 0.7, description: "Intent + sentiment" }
  },
  {
    id: "interested",
    type: "playClip",
    position: { x: 970, y: 50 },
    data: { label: "Interested response", clipId: "clip-interest", description: "Positive / interested" }
  },
  {
    id: "callback",
    type: "playClip",
    position: { x: 970, y: 210 },
    data: { label: "Callback confirmation", clipId: "clip-callback", description: "Callback requested" }
  },
  {
    id: "decline",
    type: "playClip",
    position: { x: 970, y: 370 },
    data: { label: "Not interested", clipId: "clip-decline", description: "Negative response" }
  },
  {
    id: "retry",
    type: "retry",
    position: { x: 970, y: 530 },
    data: { label: "Clarify once", clipId: "clip-clarify", maxAttempts: 1, description: "Low confidence fallback" }
  },
  {
    id: "end-interest",
    type: "end",
    position: { x: 1245, y: 50 },
    data: { label: "End call" }
  },
  {
    id: "end-callback",
    type: "end",
    position: { x: 1245, y: 210 },
    data: { label: "End call" }
  },
  {
    id: "end-decline",
    type: "end",
    position: { x: 1245, y: 370 },
    data: { label: "End call" }
  },
  {
    id: "end-uncertain",
    type: "end",
    position: { x: 1245, y: 530 },
    data: { label: "End: uncertain" }
  }
];

const initialFlow: FlowDefinition = {
  id: "flow-prospect-intake",
  name: "Prospect qualification",
  version: 3,
  status: "published",
  startNodeId: "start",
  nodes: flowNodes,
  edges: [
    { id: "e-start-opening", source: "start", target: "opening" },
    { id: "e-opening-listen", source: "opening", target: "listen" },
    { id: "e-listen-classify", source: "listen", target: "classify", condition: { fallback: true } },
    {
      id: "e-classify-interested",
      source: "classify",
      target: "interested",
      label: "Interested",
      condition: { intent: "interested", sentiment: "positive" }
    },
    {
      id: "e-classify-callback",
      source: "classify",
      target: "callback",
      label: "Callback",
      condition: { intent: "callback" }
    },
    {
      id: "e-classify-decline",
      source: "classify",
      target: "decline",
      label: "Not interested",
      condition: { intent: "not_interested", sentiment: "negative" }
    },
    {
      id: "e-classify-retry",
      source: "classify",
      target: "retry",
      label: "Low confidence",
      condition: { confidenceBelow: 0.7, fallback: true }
    },
    { id: "e-interested-end", source: "interested", target: "end-interest" },
    { id: "e-callback-end", source: "callback", target: "end-callback" },
    { id: "e-decline-end", source: "decline", target: "end-decline" },
    { id: "e-retry-end", source: "retry", target: "end-uncertain" }
  ],
  updatedAt: now()
};

const clone = <T>(value: T): T => structuredClone(value);

export type ClipAsset = Pick<Clip, "assetUrl" | "originalFilename" | "format" | "previewUrl"> & { telephonyAssetUrl?: string };

export type StoreSnapshot = {
  flows: FlowDefinition[];
  versions: FlowDefinition[];
  clips: Clip[];
  calls: CallSession[];
  consents?: ConsentRecord[];
  dncClearances?: DncClearance[];
  contacts?: Contact[];
  campaigns?: Campaign[];
  campaignContacts?: CampaignContact[];
  outcomeDeliveries?: OutcomeDelivery[];
};

/** Mutations update the process cache immediately. Await flush before acknowledging
 * writes or creating provider side effects. A failed durable write closes this gate. */
export interface Store extends DialPermissionStore {
  saveConsent(record: ConsentRecord): ConsentRecord;
  saveDncClearance(record: DncClearance): DncClearance;
  listFlows(): FlowDefinition[];
  getFlow(id: string): FlowDefinition | undefined;
  getFlowVersion(id: string, version: number): FlowDefinition | undefined;
  listFlowVersions(id?: string): FlowDefinition[];
  saveFlow(flow: FlowDefinition): FlowDefinition;
  createDraft(name: string): FlowDefinition;
  deleteFlow(id: string): FlowDefinition | undefined;
  listClips(): Clip[];
  getClip(id: string): Clip | undefined;
  createClip(name: string, durationSeconds: number, asset?: ClipAsset): Clip;
  saveClip(clip: Clip): Clip;
  isClipReferencedByPublishedVersion(id: string): boolean;
  deleteClip(id: string): Clip | undefined;
  saveCall(session: CallSession): CallSession;
  getCall(id: string): CallSession | undefined;
  listCalls(): CallSession[];
  listContacts(): Contact[];
  getContact(id: string): Contact | undefined;
  findContactByPhone(phone: string): Contact | undefined;
  saveContacts(contacts: Contact[]): Contact[];
  listCampaigns(): Campaign[];
  getCampaign(id: string): Campaign | undefined;
  saveCampaign(campaign: Campaign, contacts?: CampaignContact[]): Campaign;
  listCampaignContacts(campaignId: string): CampaignContact[];
  saveCampaignContact(contact: CampaignContact): CampaignContact;
  assertHealthy(): void;
  listOutcomeDeliveries(campaignId?: string): OutcomeDelivery[];
  saveOutcomeDelivery(delivery: OutcomeDelivery): OutcomeDelivery;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export class InMemoryStore implements Store {
  protected readonly flows = new Map<string, FlowDefinition>();
  protected readonly versions = new Map<string, FlowDefinition>();
  protected readonly clips = new Map<string, Clip>();
  protected readonly consents = new Map<string, ConsentRecord>();
  protected readonly dncClearances = new Map<string, DncClearance>();
  protected readonly lastOptOut = new Map<string, ConsentRecord>();
  protected readonly complianceIds = new Set<string>();
  protected readonly calls = new Map<string, CallSession>();
  protected readonly contacts = new Map<string, Contact>();
  protected readonly campaigns = new Map<string, Campaign>();
  protected readonly campaignContacts = new Map<string, CampaignContact>();
  protected readonly outcomeDeliveries = new Map<string, OutcomeDelivery>();

  constructor(snapshot?: StoreSnapshot) {
    const initial = snapshot ?? { flows: [initialFlow], versions: [initialFlow], clips, calls: [] };
    initial.flows.forEach((flow) => this.flows.set(flow.id, clone(flow)));
    initial.versions.forEach((flow) => this.versions.set(this.versionKey(flow.id, flow.version), clone(flow)));
    initial.clips.forEach((clip) => this.clips.set(clip.id, clone(clip)));
    initial.calls.forEach((call) => this.calls.set(call.id, clone(call)));
    initial.contacts?.forEach((contact) => this.contacts.set(contact.id, clone(contact)));
    initial.campaigns?.forEach((campaign) => this.campaigns.set(campaign.id, clone(campaign)));
    initial.campaignContacts?.forEach((contact) => this.campaignContacts.set(contact.id, clone(contact)));
    initial.consents?.forEach((record) => {
      if (record.revokedAt && Date.parse(record.revokedAt) >= Date.parse(this.lastOptOut.get(record.phone)?.revokedAt ?? "1970-01-01")) this.lastOptOut.set(record.phone, clone(record));
      const optOut = this.lastOptOut.get(record.phone);
      this.consents.set(record.phone, clone(!record.revokedAt && optOut?.revokedAt && Date.parse(record.consentedAt) <= Date.parse(optOut.revokedAt) ? optOut : record));
      this.complianceIds.add(record.id);
    });
    initial.dncClearances?.forEach((record) => { this.dncClearances.set(record.phone, clone(record)); this.complianceIds.add(record.id); });
    initial.outcomeDeliveries?.forEach((delivery) => this.outcomeDeliveries.set(delivery.id, clone(delivery)));
    this.refreshClipUsage();
  }

  getConsent(phone: string): ConsentRecord | undefined { const record = this.consents.get(phone); return record ? clone(record) : undefined; }
  getDncClearance(phone: string): DncClearance | undefined { const record = this.dncClearances.get(phone); return record ? clone(record) : undefined; }
  saveConsent(record: ConsentRecord): ConsentRecord {
    this.assertWritable();
    const prior = this.lastOptOut.get(record.phone);
    if (!record.revokedAt && prior?.revokedAt && Date.parse(record.consentedAt) <= Date.parse(prior.revokedAt)) throw new HttpError(409, "New consent must have been given after the recorded opt-out.");
    if (this.complianceIds.has(record.id)) throw new Error("Consent evidence is append-only; record a new decision.");
    if (record.revokedAt && Date.parse(record.revokedAt) >= Date.parse(prior?.revokedAt ?? "1970-01-01")) this.lastOptOut.set(record.phone, clone(record));
    this.complianceIds.add(record.id); this.consents.set(record.phone, clone(record)); this.writeConsent(clone(record)); return clone(record);
  }
  saveDncClearance(record: DncClearance): DncClearance {
    this.assertWritable();
    const prior = this.dncClearances.get(record.phone);
    if (prior && Date.parse(record.checkedAt) < Date.parse(prior.checkedAt)) throw new HttpError(409, "DNC result predates the latest recorded Registry check.");
    if (prior && !prior.cleared && record.cleared && Date.parse(record.checkedAt) === Date.parse(prior.checkedAt)) throw new HttpError(409, "A newer Registry check is required to replace a negative result.");
    if (this.complianceIds.has(record.id)) throw new Error("DNC evidence is append-only; record a new result.");
    this.complianceIds.add(record.id); this.dncClearances.set(record.phone, clone(record)); this.writeDncClearance(clone(record)); return clone(record);
  }
  protected writeConsent(_record: ConsentRecord): void { return; }
  protected writeDncClearance(_record: DncClearance): void { return; }

  listFlows(): FlowDefinition[] { return [...this.flows.values()].map(clone); }
  getFlow(id: string): FlowDefinition | undefined { const flow = this.flows.get(id); return flow ? clone(flow) : undefined; }
  getFlowVersion(id: string, version: number): FlowDefinition | undefined {
    const flow = this.versions.get(this.versionKey(id, version));
    return flow ? clone(flow) : undefined;
  }
  listFlowVersions(id?: string): FlowDefinition[] {
    return [...this.versions.values()].filter((flow) => id === undefined || flow.id === id).sort((a, b) => a.version - b.version).map(clone);
  }
  saveFlow(flow: FlowDefinition): FlowDefinition {
    this.assertWritable();
    const previous = this.getFlowVersion(flow.id, flow.version);
    if (flow.status === "published" && previous) {
      const graph = (value: FlowDefinition) => ({ ...value, updatedAt: undefined });
      if (!isDeepStrictEqual(graph(previous), graph(flow))) throw new Error("Published flow versions are immutable. Save a draft and publish a new version.");
      return previous;
    }
    if (flow.status === "published" && (!Number.isInteger(flow.version) || flow.version < 1)) throw new Error("Published flow versions must be positive integers.");
    const saved = { ...clone(flow), updatedAt: now() };
    this.flows.set(saved.id, saved);
    if (saved.status === "published") this.versions.set(this.versionKey(saved.id, saved.version), clone(saved));
    this.refreshClipUsage();
    this.writeFlow(saved);
    return clone(saved);
  }
  createDraft(name: string): FlowDefinition {
    const source = this.getFlow(initialFlow.id) ?? clone(initialFlow);
    return this.saveFlow({ ...source, id: randomUUID(), name, version: 0, status: "draft", updatedAt: now() });
  }
  deleteFlow(id: string): FlowDefinition | undefined {
    this.assertWritable();
    const previous = this.getFlow(id);
    if (!previous) return undefined;
    this.flows.delete(id);
    this.refreshClipUsage();
    this.writeFlowDeletion(id);
    return previous;
  }
  isClipReferencedByPublishedVersion(id: string): boolean {
    return [...this.versions.values()].some((flow) => flow.nodes.some((node) => node.data.clipId === id));
  }
  deleteClip(id: string): Clip | undefined {
    this.assertWritable();
    if (this.isClipReferencedByPublishedVersion(id)) throw new Error("Archive clips referenced by a published flow version; historical media cannot be deleted.");
    const previous = this.getClip(id);
    if (!previous) return undefined;
    this.clips.delete(id);
    this.writeClipDeletion(id);
    return previous;
  }
  listClips(): Clip[] { return [...this.clips.values()].map(clone); }
  getClip(id: string): Clip | undefined { const clip = this.clips.get(id); return clip ? clone(clip) : undefined; }
  createClip(name: string, durationSeconds: number, asset?: ClipAsset): Clip {
    const colors: Clip["color"][] = ["teal", "orange", "blue", "rose"];
    return this.saveClip({
      id: randomUUID(), name, durationSeconds, format: asset?.format ?? "wav", status: "ready",
      ...asset, usedBy: 0,
      updatedAt: now(), color: colors[this.clips.size % colors.length]
    });
  }
  saveClip(clip: Clip): Clip {
    this.assertWritable();
    const saved = { ...clone(clip), updatedAt: now() };
    this.clips.set(saved.id, saved);
    this.refreshClipUsage();
    this.writeClip(saved);
    return clone(saved);
  }
  saveCall(session: CallSession): CallSession {
    this.assertWritable();
    if (!this.getFlowVersion(session.flowId, session.flowVersion)) throw new Error("Call snapshot requires an existing immutable published flow version.");
    this.calls.set(session.id, clone(session));
    this.writeCall(clone(session));
    return clone(session);
  }
  getCall(id: string): CallSession | undefined { const call = this.calls.get(id); return call ? clone(call) : undefined; }
  listCalls(): CallSession[] { return [...this.calls.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone); }
  listContacts(): Contact[] { return [...this.contacts.values()].map(clone); }
  getContact(id: string): Contact | undefined { const contact = this.contacts.get(id); return contact ? clone(contact) : undefined; }
  findContactByPhone(phone: string): Contact | undefined { const contact = [...this.contacts.values()].find((item) => item.phone === phone); return contact ? clone(contact) : undefined; }
  saveContacts(contacts: Contact[]): Contact[] {
    this.assertWritable();
    const phones = new Map([...this.contacts.values()].map((contact) => [contact.phone, contact.id]));
    for (const contact of contacts) {
      if (!/^\+[1-9]\d{7,14}$/.test(contact.phone)) throw new Error("Contact phone must be normalized E.164.");
      if (phones.has(contact.phone) && phones.get(contact.phone) !== contact.id) throw new Error("Contact phone already exists.");
      const previous = this.getContact(contact.id);
      if (previous && previous.phone !== contact.phone) throw new Error("Create a new contact when its phone changes; campaign history is immutable.");
      phones.set(contact.phone, contact.id);
    }
    contacts.forEach((contact) => this.contacts.set(contact.id, clone(contact)));
    this.writeContacts(clone(contacts));
    return clone(contacts);
  }
  listCampaigns(): Campaign[] { return [...this.campaigns.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone); }
  getCampaign(id: string): Campaign | undefined { const campaign = this.campaigns.get(id); return campaign ? clone(campaign) : undefined; }
  saveCampaign(campaign: Campaign, contacts?: CampaignContact[]): Campaign {
    this.assertWritable();
    if (!this.getFlowVersion(campaign.flowId, campaign.flowVersion)) throw new Error("Campaign requires an immutable published flow version.");
    if (!isCallerId(campaign.callerId)) throw new Error("Campaign caller ID must be approved.");
    const previous = this.getCampaign(campaign.id);
    if (previous && (previous.flowId !== campaign.flowId || previous.flowVersion !== campaign.flowVersion || previous.callerId !== campaign.callerId)) throw new Error("Campaign flow version and caller ID are pinned; create a new campaign to change them.");
    if (contacts && previous) throw new Error("Campaign contact membership is immutable.");
    const contactIds = new Set<string>();
    for (const contact of contacts ?? []) {
      if (contact.campaignId !== campaign.id || !this.getContact(contact.contactId) || contactIds.has(contact.contactId)) throw new Error("Campaign requires unique existing contacts.");
      contactIds.add(contact.contactId);
    }
    this.campaigns.set(campaign.id, clone(campaign));
    contacts?.forEach((contact) => this.campaignContacts.set(contact.id, clone(contact)));
    this.writeCampaign(clone(campaign), contacts ? clone(contacts) : undefined);
    return clone(campaign);
  }
  listCampaignContacts(campaignId: string): CampaignContact[] { return [...this.campaignContacts.values()].filter((contact) => contact.campaignId === campaignId).sort((a, b) => a.ordinal - b.ordinal).map(clone); }
  saveCampaignContact(contact: CampaignContact): CampaignContact {
    this.assertWritable();
    const previous = this.campaignContacts.get(contact.id);
    if (!previous || previous.campaignId !== contact.campaignId || previous.contactId !== contact.contactId || previous.ordinal !== contact.ordinal) throw new Error("Campaign contact membership is immutable.");
    this.campaignContacts.set(contact.id, clone(contact));
    this.writeCampaignContact(clone(contact));
    return clone(contact);
  }
  assertHealthy(): void { this.assertWritable(); }
  async flush(): Promise<void> { return; }
  listOutcomeDeliveries(campaignId?: string): OutcomeDelivery[] { return [...this.outcomeDeliveries.values()].filter((entry) => campaignId === undefined || entry.campaignId === campaignId).map(clone); }
  saveOutcomeDelivery(delivery: OutcomeDelivery): OutcomeDelivery {
    this.assertWritable();
    const call = this.getCall(delivery.callId);
    if (!call || call.campaignId !== delivery.campaignId || !this.getCampaign(delivery.campaignId)) throw new Error("Outcome delivery requires a call belonging to the campaign.");
    if (!Number.isSafeInteger(delivery.attempts) || delivery.attempts < 0 || delivery.attempts > 8) throw new Error("Outcome delivery allows at most eight attempts.");
    const previous = this.outcomeDeliveries.get(delivery.id);
    if (previous && (previous.callId !== delivery.callId || previous.campaignId !== delivery.campaignId || previous.url !== delivery.url || previous.payload !== delivery.payload || previous.createdAt !== delivery.createdAt)) throw new Error("Outcome delivery identity, target and payload are immutable.");
    if (previous && delivery.attempts < previous.attempts) throw new Error("Outcome delivery attempts cannot decrease.");
    if (previous && previous.status !== "pending" && delivery.status !== previous.status) throw new Error("Terminal outcome delivery status cannot change.");
    if ([...this.outcomeDeliveries.values()].some((entry) => entry.id !== delivery.id && entry.callId === delivery.callId)) throw new Error("A call has exactly one stable outcome delivery.");
    this.outcomeDeliveries.set(delivery.id, clone(delivery));
    this.writeOutcomeDelivery(clone(delivery));
    return clone(delivery);
  }
  async close(): Promise<void> { return; }
  protected assertWritable(): void { return; }
  protected writeFlowDeletion(_id: string): void { return; }
  protected writeClipDeletion(_id: string): void { return; }
  protected writeFlow(_flow: FlowDefinition): void { return; }
  protected writeClip(_clip: Clip): void { return; }
  protected writeCall(_session: CallSession): void { return; }
  protected writeContacts(_contacts: Contact[]): void { return; }
  protected writeCampaign(_campaign: Campaign, _contacts?: CampaignContact[]): void { return; }
  protected writeCampaignContact(_contact: CampaignContact): void { return; }
  protected writeOutcomeDelivery(_delivery: OutcomeDelivery): void { return; }
  protected versionKey(id: string, version: number): string { return `${id}:${version}`; }
  protected refreshClipUsage(): void {
    const usage = new Map<string, number>();
    this.flows.forEach((flow) => flow.nodes.forEach((node) => {
      if (node.data.clipId) usage.set(node.data.clipId, (usage.get(node.data.clipId) ?? 0) + 1);
    }));
    this.clips.forEach((clip) => { clip.usedBy = usage.get(clip.id) ?? 0; });
  }
}
