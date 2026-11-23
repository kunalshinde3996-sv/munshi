import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ARG_SHAPES, backendMode, guarded, META_KEY, metaFor, SANDBOX_LABEL, sandboxDir, type ToolName,
} from "@munshi/mcp-common";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { GoogleGmailBackend } from "./google.js";
import { SandboxGmailBackend } from "./sandbox.js";
import type { GmailBackend } from "./types.js";

const label = (b: GmailBackend) => (b.source === "sandbox" ? { label: SANDBOX_LABEL } : {});
const wrap = (b: GmailBackend, data: Record<string, unknown>) => ({ source: b.source, ...label(b), ...data });

export function createGmailServer(backend: GmailBackend): McpServer {
  const server = new McpServer({ name: "munshi-gmail", version: "0.1.0" });
  const reg = <S extends z.ZodRawShape>(
    name: ToolName, description: string, shape: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<Record<string, unknown>>,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema: shape, _meta: { [META_KEY]: metaFor(name) } },
      (async (args: z.infer<z.ZodObject<S>>) => guarded(async () => wrap(backend, await handler(args)))) as never,
    );

  reg("list_recent_emails", "List recent emails (summaries only: sender, subject, date, snippet, labels).",
    ARG_SHAPES.list_recent_emails,
    async (a) => ({ emails: await backend.listRecentEmails(a) }));

  reg("get_email", "Get one full email by id, including body.", ARG_SHAPES.get_email,
    async ({ id }) => ({ email: await backend.getEmail(id) }));

  reg("create_draft", "Create an email draft (does not send).",
    ARG_SHAPES.create_draft,
    async (a) => ({ draft: await backend.createDraft(a as never) }));

  reg("get_draft", "Get a draft by id.", ARG_SHAPES.get_draft,
    async ({ id }) => ({ draft: await backend.getDraft(id) }));

  reg("delete_draft", "Delete a draft by id (Guard-internal undo for create_draft).", ARG_SHAPES.delete_draft,
    async ({ id }) => ({ result: await backend.deleteDraft(id) }));

  reg("send_email", "Send an email immediately. Externally visible and irreversible.",
    ARG_SHAPES.send_email,
    async (a) => ({ email: await backend.sendEmail(a as never) }));

  reg("add_label", "Add a label to an email.", ARG_SHAPES.add_label,
    async ({ id, label }) => ({ email: await backend.addLabel(id, label) }));

  reg("remove_label", "Remove a label from an email (Guard-internal undo for add_label).",
    ARG_SHAPES.remove_label,
    async ({ id, label }) => ({ email: await backend.removeLabel(id, label) }));

  return server;
}

export function backendFromEnv(): GmailBackend {
  return backendMode() === "google" ? new GoogleGmailBackend() : new SandboxGmailBackend(sandboxDir());
}

/** Entry point when spawned as a stdio child process. */
export async function main() {
  const server = createGmailServer(backendFromEnv());
  await server.connect(new StdioServerTransport());
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
