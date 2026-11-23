import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  backendMode, guarded, META_KEY, metaFor, SANDBOX_LABEL, sandboxDir, type ToolName,
} from "@munshi/mcp-common";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { GoogleCalendarBackend } from "./google.js";
import { SandboxCalendarBackend } from "./sandbox.js";
import type { CalendarBackend } from "./types.js";

const iso = z.string().datetime({ offset: true });
const wrap = (b: CalendarBackend, data: Record<string, unknown>) => ({
  source: b.source, ...(b.source === "sandbox" ? { label: SANDBOX_LABEL } : {}), ...data,
});

export function createCalendarServer(backend: CalendarBackend): McpServer {
  const server = new McpServer({ name: "munshi-calendar", version: "0.1.0" });
  const reg = <S extends z.ZodRawShape>(
    name: ToolName, description: string, shape: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<Record<string, unknown>>,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema: shape, _meta: { [META_KEY]: metaFor(name) } },
      (async (args: z.infer<z.ZodObject<S>>) => guarded(async () => wrap(backend, await handler(args)))) as never,
    );

  reg("list_events", "List calendar events, optionally within a start-time window.",
    { from: iso.optional(), to: iso.optional(), limit: z.number().int().min(1).max(100).default(50) },
    async (a) => ({ events: await backend.listEvents(a) }));

  reg("get_event", "Get one event by id.", { id: z.string().min(1) },
    async ({ id }) => ({ event: await backend.getEvent(id) }));

  reg("create_event", "Create a calendar event. If end is omitted it defaults to 30 minutes after start.",
    {
      title: z.string().min(1).max(200),
      start: iso,
      end: iso.optional(),
      description: z.string().default(""),
      attendees: z.array(z.string().email()).default([]),
      reminderMinutes: z.number().int().min(0).max(40320).optional(),
    },
    async (a) => {
      const end = a.end ?? new Date(Date.parse(a.start) + 30 * 60_000).toISOString();
      if (Date.parse(end) <= Date.parse(a.start)) throw new Error("end must be after start");
      return { event: await backend.createEvent({ ...a, end }) };
    });

  reg("delete_event", "Delete an event by id (Guard-internal undo for create_event).",
    { id: z.string().min(1) },
    async ({ id }) => ({ result: await backend.deleteEvent(id) }));

  return server;
}

export function backendFromEnv(): CalendarBackend {
  return backendMode() === "google" ? new GoogleCalendarBackend() : new SandboxCalendarBackend(sandboxDir());
}

/** Entry point when spawned as a stdio child process. */
export async function main() {
  const server = createCalendarServer(backendFromEnv());
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
