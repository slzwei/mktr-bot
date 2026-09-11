import type {
  BootstrapData,
  CallListPage,
  CallSession,
  CampaignDetail,
  CampaignInput,
  Contact,
  ContactImportPreview,
  ContactImportResult,
  DncCheckResult,
  DncRegistryEvidence,
  PermissionSummary,
  OutcomeDeliverySummary,
  TranscriptTurn,
  Clip,
  FlowDefinition,
  OperatorSettings,
  TestCallInput
} from "./domain";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type Operator = { id: string; email: string; role: "admin" | "operator" };

export type VoiceConsent = {
  id: string;
  phone: string;
  source: string;
  consentedAt: string;
  recordedAt: string;
  purpose: "voice_marketing";
  revokedAt?: string;
};
export type DncResult = {
  id: string;
  phone: string;
  checkedAt: string;
  recordedAt: string;
  cleared: boolean;
  source: "Singapore DNC Registry";
  reference: string;
  evidence?: DncRegistryEvidence;
};
export type VoicePermission = {
  phone: string;
  allowed: boolean;
  basis?: "consent" | "dnc";
  skipReason?: string;
  consent?: VoiceConsent;
  dnc?: DncResult;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!(init?.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers
  });
  const data = (await response.json()) as T & { error?: string };
  if (response.status === 401 && !url.startsWith("/api/auth/")) window.dispatchEvent(new Event("mktr:sign-in-required"));
  if (!response.ok) throw new ApiError(data.error ?? "Request failed.", response.status);
  return data;
}

export const api = {
  session: () => request<{ user: Operator }>("/api/auth/session"),
  login: (email: string, password: string) => request<{ user: Operator }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  bootstrap: () => request<BootstrapData>("/api/bootstrap"),
  contacts: () => request<Contact[]>("/api/contacts"),
  /** Paged, filterable call history. Omits the event array — use `call(id)` for detail. */
  callHistory: (query: { limit?: number; cursor?: string; campaignId?: string; contactId?: string; status?: string; outcome?: string; search?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
    const qs = params.toString();
    return request<CallListPage>(`/api/calls${qs ? `?${qs}` : ""}`);
  },
  /** One call with its full event timeline plus the derived conversation transcript. */
  call: (id: string) => request<CallSession & { transcript: TranscriptTurn[] }>(`/api/calls/${id}`),
  previewContacts: (csv: string) => request<ContactImportPreview>("/api/contacts/preview", { method: "POST", body: JSON.stringify({ csv }) }),
  importContacts: (csv: string, maxDncCredits?: number) => request<ContactImportResult>("/api/contacts/import", { method: "POST", body: JSON.stringify({ csv, maxDncCredits }) }),
  permissionSummary: () => request<PermissionSummary>("/api/compliance/summary"),
  checkDnc: (phone: string) => request<DncCheckResult>("/api/compliance/dnc/check", { method: "POST", body: JSON.stringify({ phone, maxCredits: 1 }) }),
  campaigns: () => request<CampaignDetail[]>("/api/campaigns"),
  campaign: (id: string) => request<CampaignDetail>(`/api/campaigns/${id}`),
  createCampaign: (input: CampaignInput) => request<CampaignDetail>("/api/campaigns", { method: "POST", body: JSON.stringify(input) }),
  controlCampaign: (id: string, action: "start" | "pause" | "stop") => request<CampaignDetail>(`/api/campaigns/${id}/${action}`, { method: "POST", body: "{}" }),
  voicePermission: (phone: string) => request<VoicePermission>(`/api/compliance/${encodeURIComponent(phone)}`),
  recordVoiceConsent: (input: { phone: string; source: string; consentedAt: string; purpose: "voice_marketing" }) => request<VoiceConsent>("/api/compliance/consent", { method: "POST", body: JSON.stringify(input) }),
  recordDncResult: (input: { phone: string; checkedAt: string; cleared: boolean; source: "Singapore DNC Registry"; reference: string }) => request<DncResult>("/api/compliance/dnc", { method: "POST", body: JSON.stringify(input) }),
  recordVoiceOptOut: (input: { phone: string; source: string }) => request<VoiceConsent>("/api/compliance/opt-out", { method: "POST", body: JSON.stringify(input) }),
  setOutcomeWebhook: (id: string, url: string | null) => request<CampaignDetail>(`/api/campaigns/${id}/outcome-webhook`, { method: "PUT", body: JSON.stringify({ url }) }),
  outcomeDeliveries: (id: string) => request<{ configured: boolean; deliveries: OutcomeDeliverySummary[] }>(`/api/campaigns/${id}/outcome-deliveries`),
  settings: () => request<OperatorSettings>("/api/settings"),
  createFlow: (name: string) => request<FlowDefinition>("/api/flows", { method: "POST", body: JSON.stringify({ name }) }),
  saveFlow: (flow: FlowDefinition) => request<FlowDefinition>(`/api/flows/${flow.id}`, { method: "PUT", body: JSON.stringify(flow) }),
  publishFlow: (flowId: string) => request<{ flow: FlowDefinition; validation: { valid: boolean; errors: string[] } }>(`/api/flows/${flowId}/publish`, { method: "POST" }),
  deleteFlow: (flowId: string) => request<{ deleted: true; id: string }>(`/api/flows/${flowId}`, { method: "DELETE" }),
  deleteClip: (clipId: string) => request<{ archived: boolean; deleted?: true; id?: string; clip?: Clip }>(`/api/clips/${clipId}`, { method: "DELETE" }),
  createClip: (name: string, durationSeconds: number) => request<Clip>("/api/clips", { method: "POST", body: JSON.stringify({ name, durationSeconds }) }),
  uploadClip: (file: File, name: string, durationSeconds: number) => {
    const body = new FormData();
    body.set("file", file);
    body.set("name", name);
    body.set("durationSeconds", String(durationSeconds));
    return request<Clip>("/api/clips/upload", { method: "POST", body });
  },
  startCall: (input: TestCallInput) => request<CallSession>("/api/calls", { method: "POST", body: JSON.stringify(input) }),
  getCall: (id: string) => request<CallSession>(`/api/calls/${id}`),
  stopCall: (id: string) => request<CallSession>(`/api/calls/${id}/end`, { method: "POST" })
};
