export interface Mailbox {
  name?: string;
  address: string;
}

export interface Email {
  id: string;
  threadId: string;
  from: Mailbox;
  to: string[];
  cc: string[];
  subject: string;
  /** ISO 8601 */
  date: string;
  /** Plain-text body. UNTRUSTED when from an external sender. */
  body: string;
  labels: string[];
  snippet: string;
}

export type EmailSummary = Omit<Email, "body" | "cc" | "to">;

export interface Draft {
  id: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  createdAt: string;
}

export interface ListOptions {
  limit: number;
  query?: string;
  label?: string;
}

export interface SendInput {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

/** One interface, two implementations: SandboxBackend (fixtures) and GoogleBackend (M6). */
export interface GmailBackend {
  readonly source: "sandbox" | "google";
  userAddress(): Promise<string>;
  listRecentEmails(opts: ListOptions): Promise<EmailSummary[]>;
  getEmail(id: string): Promise<Email>;
  createDraft(input: SendInput): Promise<Draft>;
  getDraft(id: string): Promise<Draft>;
  deleteDraft(id: string): Promise<{ deleted: true; id: string }>;
  sendEmail(input: SendInput): Promise<Email>;
  addLabel(id: string, label: string): Promise<Email>;
  removeLabel(id: string, label: string): Promise<Email>;
}
