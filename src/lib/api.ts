import type {
  BootstrapData,
  CallSession,
  Clip,
  FlowDefinition,
  TestCallInput
} from "./domain";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!(init?.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, {
    ...init,
    headers
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new ApiError(data.error ?? "Request failed.", response.status);
  return data;
}

export const api = {
  bootstrap: () => request<BootstrapData>("/api/bootstrap"),
  createFlow: (name: string) => request<FlowDefinition>("/api/flows", { method: "POST", body: JSON.stringify({ name }) }),
  saveFlow: (flow: FlowDefinition) => request<FlowDefinition>(`/api/flows/${flow.id}`, { method: "PUT", body: JSON.stringify(flow) }),
  publishFlow: (flowId: string) => request<{ flow: FlowDefinition; validation: { valid: boolean; errors: string[] } }>(`/api/flows/${flowId}/publish`, { method: "POST" }),
  createClip: (name: string, durationSeconds: number) => request<Clip>("/api/clips", { method: "POST", body: JSON.stringify({ name, durationSeconds }) }),
  uploadClip: (file: File, name: string, durationSeconds: number) => {
    const body = new FormData();
    body.set("file", file);
    body.set("name", name);
    body.set("durationSeconds", String(durationSeconds));
    return request<Clip>("/api/clips/upload", { method: "POST", body });
  },
  startCall: (input: TestCallInput) => request<CallSession>("/api/calls", { method: "POST", body: JSON.stringify(input) }),
  stopCall: (id: string) => request<CallSession>(`/api/calls/${id}/end`, { method: "POST" })
};
