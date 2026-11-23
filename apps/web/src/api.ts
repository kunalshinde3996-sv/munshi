export type Health = {
  ok: boolean;
  mode: "sandbox" | "google";
  llmProvider: string;
  llmConfigured: boolean;
  llmModel: string | null;
  llmError: string | null;
  mcpConnected: boolean;
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
