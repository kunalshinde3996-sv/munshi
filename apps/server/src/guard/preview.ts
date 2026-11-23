import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";

const fmt = (iso: string, withDate = true) => {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
  return withDate ? `${date} ${time}` : time;
};

const list = (xs: unknown) => (Array.isArray(xs) ? (xs as string[]).join(", ") : String(xs ?? ""));

/** Deterministic human-readable description of what a call will change. No LLM involved. */
export function buildPreview(db: Db, tool: string, a: Record<string, any>, holdSeconds: number): string {
  switch (tool) {
    case "create_event": {
      const end = a.end ?? new Date(Date.parse(a.start) + 30 * 60_000).toISOString();
      const who = a.attendees?.length ? `; invites ${list(a.attendees)}` : "";
      return `Create event “${a.title}” on ${fmt(a.start)}–${fmt(end, false)} IST in Primary calendar${who}`;
    }
    case "create_draft":
      return `Create a DRAFT “${a.subject}” to ${list(a.to)}${a.cc?.length ? `, cc ${list(a.cc)}` : ""} (saved in Drafts, not sent)`;
    case "send_email":
      return `SEND email “${a.subject}” to ${list(a.to)}${a.cc?.length ? `, cc ${list(a.cc)}` : ""}${a.bcc?.length ? `, bcc ${list(a.bcc)}` : ""}. Externally visible; it is held for ${holdSeconds}s before sending and can be cancelled until then.`;
    case "add_label": {
      const e = db.select().from(schema.emails).where(eq(schema.emails.id, a.id)).get();
      return `Add label “${a.label}” to email ${e ? `“${e.subject}”` : a.id}`;
    }
    case "remove_label":
      return `Remove label “${a.label}” from email ${a.id} (undo)`;
    case "delete_draft":
      return `Delete draft ${a.id} (undo)`;
    case "delete_event":
      return `Delete calendar event ${a.id} (undo)`;
    case "list_recent_emails":
      return `Read recent emails${a.query ? ` matching “${a.query}”` : ""} (up to ${a.limit})`;
    case "get_email":
    case "get_draft":
    case "get_event":
      return `Read ${tool.replace("get_", "")} ${a.id}`;
    case "list_events":
      return `Read calendar events${a.from ? ` from ${fmt(a.from)}` : ""}${a.to ? ` to ${fmt(a.to)}` : ""}`;
    default:
      return `Call ${tool}`;
  }
}
