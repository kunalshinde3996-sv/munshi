import { z } from "zod";
import type { ToolName } from "./meta.js";

const iso = z.string().datetime({ offset: true });
const addrs = z.array(z.string().email()).default([]);
const id = z.string().min(1);

/**
 * Tool argument schemas: the single definition used by the MCP servers (to validate calls) AND by the
 * Guard (to validate agent-proposed calls before anything is executed).
 */
export const ARG_SHAPES = {
  list_recent_emails: {
    limit: z.number().int().min(1).max(50).default(20),
    query: z.string().optional().describe("Case-insensitive text filter"),
    label: z.string().optional(),
  },
  get_email: { id },
  get_draft: { id },
  create_draft: { to: z.array(z.string().email()).min(1), cc: addrs, bcc: addrs, subject: z.string().min(1), body: z.string() },
  delete_draft: { id },
  send_email: { to: z.array(z.string().email()).min(1), cc: addrs, bcc: addrs, subject: z.string().min(1), body: z.string() },
  add_label: { id, label: z.string().min(1) },
  remove_label: { id, label: z.string().min(1) },
  list_events: { from: iso.optional(), to: iso.optional(), limit: z.number().int().min(1).max(100).default(50) },
  get_event: { id },
  create_event: {
    title: z.string().min(1).max(200),
    start: iso,
    end: iso.optional(),
    description: z.string().default(""),
    attendees: z.array(z.string().email()).default([]),
    reminderMinutes: z.number().int().min(0).max(40320).optional(),
  },
  delete_event: { id },
} satisfies Record<ToolName, z.ZodRawShape>;

/** Strict: unknown arguments are rejected rather than silently dropped. */
export const strictArgSchema = (name: ToolName) => z.object(ARG_SHAPES[name]).strict();
