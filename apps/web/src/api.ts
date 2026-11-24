export type Health = {
  ok: boolean;
  mode: "sandbox" | "google";
  llmProvider: string;
  llmConfigured: boolean;
  llmModel: string | null;
  llmError: string | null;
  mcpConnected: boolean;
  googleAuthProblem: string | null;
  agentAvailable: boolean;
  agentError: string | null;
  holdSeconds: number;
};

export type ObligationType = "bill" | "deadline" | "renewal" | "refund" | "appointment" | "travel" | "other";

export type Obligation = {
  id: string;
  emailId: string;
  type: ObligationType;
  title: string;
  dueDate: string | null;
  amount: number | null;
  currency: string | null;
  counterparty: string | null;
  confidence: number;
  evidenceQuote: string;
  emailFrom: string;
  emailSubject: string;
  emailSource: "sandbox" | "google";
};

export type SecurityFlags = {
  hiddenContent: { kind: string; text: string }[];
  injectionSuspected: { pattern: string; text: string; where: "visible" | "hidden" }[];
  rejectedObligations: { reason: string; raw: unknown }[];
};

export type EmailRow = {
  id: string;
  from: string;
  subject: string;
  receivedAt: number;
  source: "sandbox" | "google";
  status: "pending" | "done" | "extraction_failed";
  error: string | null;
  obligationCount: number;
  flags: SecurityFlags | null;
};

export type EmailDetail = {
  email: { id: string; from: { name?: string; address: string }; to: string[]; subject: string; date: string; body: string };
  extractorInput: string;
  status: EmailRow["status"];
  error: string | null;
  flags: SecurityFlags | null;
};

export type ScanSummary = {
  listed: number;
  skipped: number;
  extracted: number;
  failed: number;
  obligations: number;
  hiddenContentEmails: number;
  injectionEmails: number;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  health: () => req<Health>("/api/health"),
  obligations: () => req<{ obligations: Obligation[] }>("/api/obligations").then((r) => r.obligations),
  emails: () => req<{ emails: EmailRow[] }>("/api/emails").then((r) => r.emails),
  email: (id: string) => req<EmailDetail>(`/api/emails/${encodeURIComponent(id)}`),
  scan: (force: boolean) =>
    req<{ summary: ScanSummary }>("/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force }),
    }).then((r) => r.summary),
};

export type TaintInfo = { arg: string; value: string; trusted: boolean; allowlisted: boolean; explanation: string };
export type Action = {
  id: string;
  runId: string;
  obligationId: string | null;
  tool: string;
  tier: "R0" | "R1" | "R2" | "R3";
  args: Record<string, unknown>;
  tainted: boolean;
  decision: "allow" | "require_approval" | "block" | "skipped";
  reason: string;
  rule: string | null;
  status: string;
  preview: string | null;
  warnings: string[];
  taint: TaintInfo[];
  holdUntil: number | null;
  result: unknown;
  verify: { ok: boolean; detail: string } | null;
  createdAt: number;
  canUndo: boolean;
  undoHint: string | null;
};
export type TraceEvent = { ts: number; kind: string; [k: string]: unknown };
export type RunDetail = {
  run: { id: string; goal: string; status: "running" | "awaiting_approval" | "completed" | "failed"; startedAt: number; finishedAt: number | null };
  trace: TraceEvent[];
  actions: Action[];
};
export type PolicyRow = { id: string; enabled: boolean; seed: boolean; valid: boolean; rule: { id: string; description?: string; match: Record<string, unknown>; decision: string; reason: string } | null };
export type Contact = { id: string; name: string; email: string };
export type AuditEntry = { id: number; ts: number; runId: string | null; actionId: string | null; event: string; actor: string; detail: unknown };

const post = <T,>(path: string, body?: unknown) =>
  req<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

export type SecurityAction = Action & { sources: { emailId: string | null; sender: string | null; subject: string | null; hidden: boolean; value: string }[] };
export type SecurityEmail = { id: string; from: string; subject: string; source: string; flags: SecurityFlags };

export const api2 = {
  security: () => req<{ actions: SecurityAction[]; emails: SecurityEmail[] }>("/api/security"),
  startRun: (goal: string) => post<{ runId: string }>("/api/runs", { goal }),
  run: (id: string) => req<RunDetail>(`/api/runs/${id}`),
  actions: (status?: string) => req<{ actions: Action[] }>(`/api/actions${status ? `?status=${status}` : ""}`).then((r) => r.actions),
  approve: (id: string, acknowledgeTaint: boolean) => post<{ action: Action }>(`/api/actions/${id}/approve`, { acknowledgeTaint }),
  reject: (id: string) => post<{ action: Action }>(`/api/actions/${id}/reject`),
  undo: (id: string) => post<{ action: Action }>(`/api/actions/${id}/undo`),
  policies: () => req<{ policies: PolicyRow[] }>("/api/policies").then((r) => r.policies),
  addPolicy: (rule: unknown) => post<unknown>("/api/policies", { rule }),
  togglePolicy: (id: string, enabled: boolean) => req<unknown>(`/api/policies/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }),
  deletePolicy: (id: string) => req<unknown>(`/api/policies/${id}`, { method: "DELETE" }),
  contacts: () => req<{ contacts: Contact[] }>("/api/contacts").then((r) => r.contacts),
  addContact: (name: string, email: string) => post<unknown>("/api/contacts", { name, email }),
  deleteContact: (id: string) => req<unknown>(`/api/contacts/${id}`, { method: "DELETE" }),
  audit: (limit = 100) => req<{ entries: AuditEntry[] }>(`/api/audit?limit=${limit}`).then((r) => r.entries),
};

export type GoogleStatus = {
  configured: boolean;
  missing: string[];
  redirectUri: string;
  setupSteps: string[];
  connected: boolean;
  email: string | null;
  mode: "sandbox" | "google";
  authProblem: string | null;
};
export const googleApi = {
  status: () => req<GoogleStatus>("/api/google/status"),
  setMode: (mode: "sandbox" | "google") => post<GoogleStatus>("/api/settings/mode", { mode }),
  disconnect: () => post<GoogleStatus>("/api/google/disconnect"),
};

export type TelegramStatus = { configured: boolean; linked: boolean; polling: boolean; bot: string | null; lastError: string | null; setup: string[] };
export type Nudge = { obligationId: string; title: string; type: string; dueDate: string | null; dueAt: number; amount: number | null; currency: string | null; counterparty: string | null };
export const channelsApi = {
  telegram: () => req<TelegramStatus>("/api/telegram"),
  nudges: () => req<{ nudges: Nudge[] }>("/api/nudges").then((r) => r.nudges),
};
