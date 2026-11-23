import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { META_KEY, ToolMeta, toolMeta } from "@munshi/mcp-common";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

export type ServerName = "gmail" | "calendar";

const ENTRYPOINTS: Record<ServerName, string> = {
  gmail: "@munshi/mcp-gmail/server",
  calendar: "@munshi/mcp-calendar/server",
};

export interface HubOptions {
  /** Directory for sandbox JSON stores (shared by the child processes). */
  sandboxDir: string;
  backend?: "sandbox" | "google";
}

export interface ToolInfo {
  server: ServerName;
  name: string;
  description?: string;
  inputSchema: unknown;
  /** Metadata advertised by the MCP server itself (from tools/list `_meta`). */
  advertisedMeta: ToolMeta | null;
  /** Metadata from the shared registry (what the Guard trusts). */
  meta: ToolMeta | null;
  /** True iff the server's advertised metadata equals the shared registry entry. */
  metaConsistent: boolean;
}

export class McpToolError extends Error {}

/**
 * Cross-platform stdio spawn: always `process.execPath --import <tsx loader> <entry.ts>`.
 * No shell, no bash scripts, no hardcoded path separators.
 */
export function stdioParams(server: ServerName, opts: HubOptions) {
  const entry = require.resolve(ENTRYPOINTS[server]);
  const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
  return {
    command: process.execPath,
    args: ["--import", tsxLoader, entry],
    env: {
      ...getDefaultEnvironment(),
      MUNSHI_BACKEND: opts.backend ?? "sandbox",
      SANDBOX_STORE_DIR: resolve(opts.sandboxDir),
    },
    stderr: "inherit" as const,
  };
}

/** MCP client that owns one stdio child process per MCP server and routes tool calls. */
export class McpHub {
  private clients = new Map<ServerName, Client>();
  private toolOwner = new Map<string, ServerName>();

  constructor(private readonly opts: HubOptions) {}

  async connect(): Promise<void> {
    for (const name of Object.keys(ENTRYPOINTS) as ServerName[]) {
      const client = new Client({ name: "munshi-server", version: "0.1.0" });
      await client.connect(new StdioClientTransport(stdioParams(name, this.opts)));
      this.clients.set(name, client);
    }
    await this.listTools(); // populate routing table
  }

  async listTools(): Promise<ToolInfo[]> {
    const out: ToolInfo[] = [];
    for (const [server, client] of this.clients) {
      const { tools } = await client.listTools();
      for (const t of tools) {
        this.toolOwner.set(t.name, server);
        const raw = (t._meta as Record<string, unknown> | undefined)?.[META_KEY];
        const parsed = ToolMeta.safeParse(raw);
        const advertisedMeta = parsed.success ? parsed.data : null;
        const meta = toolMeta(t.name) ?? null;
        out.push({
          server, name: t.name, description: t.description, inputSchema: t.inputSchema,
          advertisedMeta, meta,
          metaConsistent:
            meta !== null && advertisedMeta !== null &&
            JSON.stringify(sortKeys(meta)) === JSON.stringify(sortKeys(advertisedMeta)),
        });
      }
    }
    return out;
  }

  /** Call a tool; returns the parsed JSON payload. Throws McpToolError on tool errors. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const server = this.toolOwner.get(name);
    if (!server) throw new McpToolError(`Unknown tool: ${name}`);
    const res = await this.clients.get(server)!.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text?: string }[] | undefined)
      ?.find((c) => c.type === "text")?.text ?? "";
    if (res.isError) throw new McpToolError(text || `Tool ${name} failed`);
    try {
      return JSON.parse(text);
    } catch {
      throw new McpToolError(`Tool ${name} returned non-JSON output`);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();
    this.toolOwner.clear();
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}
