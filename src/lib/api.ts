import type {
  BootstrapData,
  CallSession,
  CampaignDetail,
  CampaignInput,
  Contact,
  Clip,
  FlowDefinition,
  TestCallInput
} from "./domain";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type Operator = { id: string; email: string; role: "admin" | "operator" };

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
  importContacts: (csv: string) => request<{ imported: number; duplicates: number; contacts: Contact[] }>("/api/contacts/import", { method: "POST", body: JSON.stringify({ csv }) }),
  campaigns: () => request<CampaignDetail[]>("/api/campaigns"),
  campaign: (id: string) => request<CampaignDetail>(`/api/campaigns/${id}`),
  createCampaign: (input: CampaignInput) => request<CampaignDetail>("/api/campaigns", { method: "POST", body: JSON.stringify(input) }),
  controlCampaign: (id: string, action: "start" | "pause" | "stop") => request<CampaignDetail>(`/api/campaigns/${id}/${action}`, { method: "POST", body: "{}" }),
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
