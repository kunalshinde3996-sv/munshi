import { JsonStore, SANDBOX_USER_EMAIL } from "@munshi/mcp-common";
import { buildFixtureEmails } from "./fixtures.js";
import type {
  Draft, Email, EmailSummary, GmailBackend, ListOptions, SendInput,
} from "./types.js";

interface State {
  counter: number;
  /** Extra labels per email id (fixtures are regenerated each call so dates stay upcoming). */
  labels: Record<string, string[]>;
  drafts: Draft[];
  sent: Email[];
}

/** SANDBOX DATA backend. Writes persist in a JSON file so verify/undo work across calls. */
export class SandboxGmailBackend implements GmailBackend {
  readonly source = "sandbox" as const;
  private readonly store: JsonStore<State>;

  constructor(dir: string, private readonly clock: () => Date = () => new Date()) {
    this.store = new JsonStore<State>(dir, "sandbox-gmail.json", () => ({
      counter: 0, labels: {}, drafts: [], sent: [],
    }));
  }

  async userAddress() {
    return SANDBOX_USER_EMAIL;
  }

  private allEmails(state: State): Email[] {
    const inbox = buildFixtureEmails(this.clock()).map((e) => ({
      ...e,
      labels: [...new Set([...e.labels, ...(state.labels[e.id] ?? [])])],
    }));
    const sent = state.sent.map((e) => ({
      ...e,
      labels: [...new Set([...e.labels, ...(state.labels[e.id] ?? [])])],
    }));
    return [...inbox, ...sent];
  }

  async listRecentEmails({ limit, query, label }: ListOptions): Promise<EmailSummary[]> {
    const state = this.store.read();
    const q = query?.toLowerCase();
    return this.allEmails(state)
      .filter((e) => !e.labels.includes("SENT") || label === "SENT")
      .filter((e) => (label ? e.labels.includes(label) : true))
      .filter((e) =>
        q ? `${e.subject} ${e.from.address} ${e.from.name ?? ""} ${e.body}`.toLowerCase().includes(q) : true)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit)
      .map(({ body: _b, cc: _c, to: _t, ...summary }) => summary);
  }

  async getEmail(id: string): Promise<Email> {
    const found = this.allEmails(this.store.read()).find((e) => e.id === id);
    if (!found) throw new Error(`Email not found: ${id}`);
    return found;
  }

  async createDraft(input: SendInput): Promise<Draft> {
    return this.store.update((s) => {
      const draft: Draft = {
        id: `sbx-draft-${++s.counter}`, ...input, createdAt: this.clock().toISOString(),
      };
      s.drafts.push(draft);
      return draft;
    });
  }

  async getDraft(id: string): Promise<Draft> {
    const d = this.store.read().drafts.find((x) => x.id === id);
    if (!d) throw new Error(`Draft not found: ${id}`);
    return d;
  }

  async deleteDraft(id: string) {
    return this.store.update((s) => {
      const i = s.drafts.findIndex((x) => x.id === id);
      if (i < 0) throw new Error(`Draft not found: ${id}`);
      s.drafts.splice(i, 1);
      return { deleted: true as const, id };
    });
  }

  async sendEmail(input: SendInput): Promise<Email> {
    return this.store.update((s) => {
      const id = `sbx-sent-${++s.counter}`;
      const email: Email = {
        id, threadId: `sbx-thread-${id}`,
        from: { address: SANDBOX_USER_EMAIL },
        to: [...input.to, ...input.bcc], cc: input.cc,
        subject: input.subject, body: input.body,
        date: this.clock().toISOString(),
        labels: ["SENT"], snippet: input.body.slice(0, 110),
      };
      s.sent.push(email);
      return email;
    });
  }

  async addLabel(id: string, label: string): Promise<Email> {
    await this.getEmail(id); // throws if missing
    this.store.update((s) => {
      s.labels[id] = [...new Set([...(s.labels[id] ?? []), label])];
    });
    return this.getEmail(id);
  }

  async removeLabel(id: string, label: string): Promise<Email> {
    await this.getEmail(id);
    this.store.update((s) => {
      s.labels[id] = (s.labels[id] ?? []).filter((l) => l !== label);
    });
    return this.getEmail(id);
  }
}
