import { Prisma, PrismaClient } from "@prisma/client";
import type { CallSession, Campaign, CampaignContact, Clip, Contact, FlowDefinition } from "../src/lib/domain.js";
import type { AuthSession, AuthStore, AuthUser } from "./auth.js";
import { logger } from "./logger.js";
import { InMemoryStore, type ClipAsset, type StoreSnapshot } from "./store.js";

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const asSnapshot = <T>(value: Prisma.JsonValue): T => structuredClone(value) as T;

/** Single API process cache backed by ordered Postgres transactions. Any failed
 * transaction latches the store unhealthy; a new process reloads committed state.
 * This prevents later acknowledgements from concealing an earlier lost write. */
export class PrismaStore extends InMemoryStore implements AuthStore {
  private pending: Promise<void> = Promise.resolve();
  private failure?: Error;
  private closed = false;

  private constructor(private readonly client: PrismaClient, snapshot: StoreSnapshot) { super(snapshot); }

  static async connect(databaseUrl: string, options: { seedDemo?: boolean } = {}): Promise<PrismaStore> {
    const client = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
    try {
      await client.$connect();
      const [flows, versions, clips, calls, contacts, campaigns, campaignContacts] = await client.$transaction([
        client.flow.findMany(), client.flowVersion.findMany(), client.clip.findMany(), client.call.findMany(),
        client.contact.findMany(), client.campaign.findMany(), client.campaignContact.findMany()
      ]);
      let store = new PrismaStore(client, {
        flows: flows.filter((flow) => !flow.deletedAt).map((flow) => ({ id: flow.id, name: flow.name, version: flow.version, status: flow.status, startNodeId: flow.startNodeId, nodes: asSnapshot(flow.nodes), edges: asSnapshot(flow.edges), updatedAt: flow.updatedAt.toISOString() })),
        versions: versions.map((version) => asSnapshot<FlowDefinition>(version.graph)),
        clips: clips.map((clip) => asSnapshot<Clip>(clip.snapshot)),
        calls: calls.map((call) => asSnapshot<CallSession>(call.snapshot)),
        contacts: contacts.map((contact) => asSnapshot<Contact>(contact.snapshot)),
        campaigns: campaigns.map((campaign) => asSnapshot<Campaign>(campaign.snapshot)),
        campaignContacts: campaignContacts.map((contact) => asSnapshot<CampaignContact>(contact.snapshot))
      });
      // Seed only a completely empty application database, never re-create deleted content.
      if (options.seedDemo !== false && flows.length === 0 && versions.length === 0 && clips.length === 0 && calls.length === 0 && contacts.length === 0 && campaigns.length === 0) {
        const seed = new InMemoryStore();
        await client.$transaction(async (transaction) => {
          for (const clip of seed.listClips()) await transaction.clip.create({ data: {
            id: clip.id, name: clip.name, durationSeconds: clip.durationSeconds, format: clip.format,
            status: clip.status, assetUrl: clip.assetUrl, previewUrl: clip.previewUrl, color: clip.color,
            snapshot: json(clip), updatedAt: new Date(clip.updatedAt)
          } });
          for (const flow of seed.listFlows()) {
            await transaction.flow.create({ data: { id: flow.id, name: flow.name, version: flow.version, status: flow.status, startNodeId: flow.startNodeId, nodes: json(flow.nodes), edges: json(flow.edges), updatedAt: new Date(flow.updatedAt) } });
            await transaction.flowVersion.create({ data: { flowId: flow.id, version: flow.version, graph: json(flow), publishedAt: new Date(flow.updatedAt) } });
          }
        });
        store = new PrismaStore(client, { flows: seed.listFlows(), versions: seed.listFlowVersions(), clips: seed.listClips(), calls: [] });
      }
      await client.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
      return store;
    } catch (error) {
      await client.$disconnect();
      throw new Error("Postgres store initialization failed; API startup refused.", { cause: error });
    }
  }

  override async flush(): Promise<void> {
    for (;;) {
      const barrier = this.pending;
      await barrier;
      this.assertWritable();
      if (barrier === this.pending) return;
    }
  }
  override async close(): Promise<void> {
    try { await this.flush(); }
    finally { this.closed = true; await this.client.$disconnect(); }
  }
  protected override assertWritable(): void {
    if (this.failure) throw new Error("Postgres write failed; restart the API after database recovery before accepting further writes.", { cause: this.failure });
    if (this.closed) throw new Error("Postgres store is closed.");
  }
  private enqueue(write: () => Promise<unknown>): void {
    this.assertWritable();
    this.pending = this.pending.then(async () => {
      if (this.failure) return;
      try { await write(); }
      catch (error) {
        this.failure = error instanceof Error ? error : new Error(String(error));
        logger.error({ err: this.failure }, "Durable store write failed; further writes and call origination are blocked until restart");
      }
    });
  }
  protected override writeFlow(flow: FlowDefinition): void {
    const snapshot = structuredClone(flow);
    this.enqueue(() => this.client.$transaction(async (transaction) => {
      const data = { deletedAt: null, name: snapshot.name, version: snapshot.version, status: snapshot.status, startNodeId: snapshot.startNodeId, nodes: json(snapshot.nodes), edges: json(snapshot.edges), updatedAt: new Date(snapshot.updatedAt), publishedAt: snapshot.status === "published" ? new Date(snapshot.updatedAt) : undefined };
      await transaction.flow.upsert({ where: { id: snapshot.id }, create: { id: snapshot.id, ...data }, update: data });
      if (snapshot.status === "published") {
        // No update/upsert of a revision is allowed. Postgres also enforces immutability.
        await transaction.flowVersion.create({ data: { flowId: snapshot.id, version: snapshot.version, graph: json(snapshot), publishedAt: new Date(snapshot.updatedAt) } });
      }
    }));
  }
  protected override writeFlowDeletion(id: string): void {
    this.enqueue(() => this.client.flow.update({ where: { id }, data: { deletedAt: new Date() } }));
  }
  protected override writeClipDeletion(id: string): void {
    this.enqueue(() => this.client.clip.delete({ where: { id } }));
  }
  protected override writeClip(clip: Clip): void {
    const data = { name: clip.name, durationSeconds: clip.durationSeconds, format: clip.format, status: clip.status, assetUrl: clip.assetUrl ?? null, previewUrl: clip.previewUrl ?? null, telephonyAssetUrl: (clip as Clip & ClipAsset).telephonyAssetUrl ?? null, originalFilename: clip.originalFilename ?? null, color: clip.color, snapshot: json(clip), updatedAt: new Date(clip.updatedAt) };
    this.enqueue(() => this.client.clip.upsert({ where: { id: clip.id }, create: { id: clip.id, ...data }, update: data }));
  }
  protected override writeCall(call: CallSession): void {
    const snapshot = structuredClone(call);
    this.enqueue(() => this.client.$transaction(async (transaction) => {
      const data = {
        providerCallId: snapshot.providerCallId, destination: snapshot.destination, callerId: snapshot.callerId,
        flowId: snapshot.flowId, flowVersion: snapshot.flowVersion, status: snapshot.status,
        campaignId: snapshot.campaignId ?? null, contactId: snapshot.contactId ?? null,
        currentNodeId: snapshot.currentNodeId ?? null, endReason: snapshot.endReason ?? null,
        classifier: snapshot.classifierResult ? json(snapshot.classifierResult) : Prisma.DbNull,
        createdAt: new Date(snapshot.createdAt), endedAt: snapshot.endedAt ? new Date(snapshot.endedAt) : null,
        snapshot: json(snapshot)
      };
      await transaction.call.upsert({ where: { id: snapshot.id }, create: { id: snapshot.id, ...data }, update: data });
      if (snapshot.events.length) await transaction.callEvent.createMany({
        data: snapshot.events.map((event) => ({ ...event, callId: snapshot.id, timestamp: new Date(event.timestamp) })), skipDuplicates: true
      });
    }));
  }

  protected override writeContacts(contacts: Contact[]): void {
    this.enqueue(() => this.client.$transaction(contacts.map((contact) => {
      const data = { name: contact.name, phone: contact.phone, snapshot: json(contact), createdAt: new Date(contact.createdAt), updatedAt: new Date(contact.updatedAt) };
      return this.client.contact.upsert({ where: { id: contact.id }, create: { id: contact.id, ...data }, update: data });
    })));
  }
  protected override writeCampaign(campaign: Campaign, contacts?: CampaignContact[]): void {
    this.enqueue(() => this.client.$transaction(async (transaction) => {
      const data = {
        name: campaign.name, flowId: campaign.flowId, flowVersion: campaign.flowVersion, callerId: campaign.callerId,
        status: campaign.status, callingHours: json(campaign.callingHours), maxAttempts: campaign.maxAttempts,
        retryDelaySeconds: campaign.retryDelaySeconds, dialIntervalMs: campaign.dialIntervalMs,
        lastDialAt: campaign.lastDialAt ? new Date(campaign.lastDialAt) : null, snapshot: json(campaign),
        createdAt: new Date(campaign.createdAt), updatedAt: new Date(campaign.updatedAt)
      };
      await transaction.campaign.upsert({ where: { id: campaign.id }, create: { id: campaign.id, ...data }, update: data });
      if (contacts?.length) await transaction.campaignContact.createMany({ data: contacts.map((contact) => ({ id: contact.id, ...this.campaignContactData(contact) })) });
    }));
  }
  protected override writeCampaignContact(contact: CampaignContact): void {
    this.enqueue(() => this.client.campaignContact.update({ where: { id: contact.id }, data: this.campaignContactData(contact) }));
  }
  private campaignContactData(contact: CampaignContact) {
    return {
      campaignId: contact.campaignId, contactId: contact.contactId, ordinal: contact.ordinal, status: contact.status,
      attempts: contact.attempts, nextAttemptAt: contact.nextAttemptAt ? new Date(contact.nextAttemptAt) : null,
      lastAttemptAt: contact.lastAttemptAt ? new Date(contact.lastAttemptAt) : null, lastCallId: contact.lastCallId ?? null,
      outcome: contact.outcome ?? null, skipReason: contact.skipReason ?? null, snapshot: json(contact)
    };
  }

  async findUserByEmail(email: string): Promise<AuthUser | undefined> {
    await this.flush();
    return await this.client.user.findUnique({ where: { email: email.toLowerCase() } }) ?? undefined;
  }
  async findUserById(id: string): Promise<AuthUser | undefined> {
    await this.flush();
    return await this.client.user.findUnique({ where: { id } }) ?? undefined;
  }
  async saveUser(user: AuthUser): Promise<void> {
    const data = { email: user.email.toLowerCase(), passwordHash: user.passwordHash, role: user.role };
    this.enqueue(() => this.client.user.upsert({ where: { id: user.id }, create: { id: user.id, ...data }, update: data }));
    await this.flush();
  }
  async getSession(tokenHash: string): Promise<AuthSession | undefined> {
    await this.flush();
    const session = await this.client.session.findUnique({ where: { tokenHash } });
    return session ? { tokenHash: session.tokenHash, userId: session.userId, expiresAt: session.expiresAt.toISOString() } : undefined;
  }
  async saveSession(session: AuthSession): Promise<void> {
    const data = { userId: session.userId, expiresAt: new Date(session.expiresAt) };
    this.enqueue(() => this.client.$transaction([
      this.client.session.deleteMany({ where: { expiresAt: { lte: new Date() } } }),
      this.client.session.upsert({ where: { tokenHash: session.tokenHash }, create: { tokenHash: session.tokenHash, ...data }, update: data })
    ]));
    await this.flush();
  }
  async deleteSession(tokenHash: string): Promise<void> {
    this.enqueue(() => this.client.session.deleteMany({ where: { tokenHash } }));
    await this.flush();
  }
}
