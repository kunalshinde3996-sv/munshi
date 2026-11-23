import { z } from "zod";

export const RiskTier = z.enum(["R0", "R1", "R2", "R3"]);
export type RiskTier = z.infer<typeof RiskTier>;

/**
 * Per-tool safety metadata. This is the SINGLE source of truth: MCP servers advertise it in
 * `_meta.munshi` on tools/list, and the Guard / debug route read it from here.
 */
export const ToolMeta = z.object({
  server: z.enum(["gmail", "calendar"]),
  riskTier: RiskTier,
  /** Can the effect be reversed via undoTool (or, for R2, only inside the hold window)? */
  reversible: z.boolean(),
  undoTool: z.string().optional(),
  verifyTool: z.string().optional(),
  /** Args whose values must be traceable to a TRUSTED provenance source. */
  sensitiveArgs: z.array(z.string()),
  /**
   * false = never offered to / callable by the agent; only the Guard may invoke it
   * (e.g. as an undo step on an action the Guard itself executed).
   */
  agentCallable: z.boolean(),
  /** Output may contain text written by outside parties (email bodies, event descriptions). Never offered to the agent. */
  returnsUntrusted: z.boolean().optional(),
});
export type ToolMeta = z.infer<typeof ToolMeta>;

export const META_KEY = "munshi";

export const TOOL_META = {
  // ---- mcp-gmail ----
  list_recent_emails: { server: "gmail", riskTier: "R0", reversible: true, sensitiveArgs: [], agentCallable: true, returnsUntrusted: true },
  get_email: { server: "gmail", riskTier: "R0", reversible: true, sensitiveArgs: [], agentCallable: true, returnsUntrusted: true },
  get_draft: { server: "gmail", riskTier: "R0", reversible: true, sensitiveArgs: [], agentCallable: true },
  create_draft: {
    server: "gmail", riskTier: "R1", reversible: true, undoTool: "delete_draft", verifyTool: "get_draft",
    sensitiveArgs: ["to", "cc", "bcc"], agentCallable: true,
  },
  add_label: {
    server: "gmail", riskTier: "R1", reversible: true, undoTool: "remove_label", verifyTool: "get_email",
    sensitiveArgs: [], agentCallable: true,
  },
  send_email: {
    server: "gmail", riskTier: "R2", reversible: false, verifyTool: "get_email",
    sensitiveArgs: ["to", "cc", "bcc"], agentCallable: true,
  },
  // Undo-only helpers: Guard-internal, scoped to artifacts the Guard created.
  delete_draft: { server: "gmail", riskTier: "R3", reversible: false, sensitiveArgs: [], agentCallable: false },
  remove_label: { server: "gmail", riskTier: "R1", reversible: true, sensitiveArgs: [], agentCallable: false },

  // ---- mcp-calendar ----
  list_events: { server: "calendar", riskTier: "R0", reversible: true, sensitiveArgs: [], agentCallable: true, returnsUntrusted: true },
  get_event: { server: "calendar", riskTier: "R0", reversible: true, sensitiveArgs: [], agentCallable: true, returnsUntrusted: true },
  create_event: {
    server: "calendar", riskTier: "R1", reversible: true, undoTool: "delete_event", verifyTool: "get_event",
    sensitiveArgs: ["attendees"], agentCallable: true,
  },
  delete_event: { server: "calendar", riskTier: "R3", reversible: false, sensitiveArgs: [], agentCallable: false },
} as const satisfies Record<string, ToolMeta>;

export type ToolName = keyof typeof TOOL_META;

export const toolMeta = (name: string): ToolMeta | undefined =>
  (TOOL_META as Record<string, ToolMeta>)[name];

export const metaFor = (name: ToolName): ToolMeta => ToolMeta.parse(TOOL_META[name]);
