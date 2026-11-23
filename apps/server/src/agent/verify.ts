import { normalizeAddress } from "../guard/provenance.js";
import type { McpHub } from "../mcp/hub.js";

export interface VerifyOutcome {
  ok: boolean;
  detail: string;
}

const sameSet = (a: string[], b: string[]) => {
  const x = [...new Set(a.map(normalizeAddress))].sort();
  const y = [...new Set(b.map(normalizeAddress))].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Read the effect back through the tool's verifyTool and compare with what we asked for. */
export async function verifyAction(
  mcp: McpHub, tool: string, args: Record<string, any>, result: any,
): Promise<VerifyOutcome> {
  try {
    switch (tool) {
      case "create_event": {
        const { event } = await mcp.callTool("get_event", { id: result.event.id });
        const problems: string[] = [];
        if (event.title !== args.title) problems.push(`title is “${event.title}”, expected “${args.title}”`);
        if (Date.parse(event.start) !== Date.parse(args.start)) problems.push(`start is ${event.start}, expected ${args.start}`);
        if (!sameSet(event.attendees ?? [], args.attendees ?? [])) problems.push("attendees differ");
        return problems.length ? { ok: false, detail: problems.join("; ") } : { ok: true, detail: `Event ${event.id} read back: title and start match.` };
      }
      case "create_draft": {
        const { draft } = await mcp.callTool("get_draft", { id: result.draft.id });
        const problems: string[] = [];
        if (draft.subject !== args.subject) problems.push("subject differs");
        if (!sameSet(draft.to, args.to)) problems.push("recipients differ");
        return problems.length ? { ok: false, detail: problems.join("; ") } : { ok: true, detail: `Draft ${draft.id} read back: subject and recipients match.` };
      }
      case "add_label": {
        const { email } = await mcp.callTool("get_email", { id: args.id });
        return email.labels.includes(args.label)
          ? { ok: true, detail: `Label “${args.label}” present on ${args.id}.` }
          : { ok: false, detail: `Label “${args.label}” not found on ${args.id}.` };
      }
      case "send_email": {
        const { email } = await mcp.callTool("get_email", { id: result.email.id });
        const sent = (email.labels as string[]).includes("SENT");
        const to = [...(email.to as string[]), ...(email.cc as string[])];
        const missing = (args.to as string[]).filter((r) => !to.map(normalizeAddress).includes(normalizeAddress(r)));
        if (!sent) return { ok: false, detail: "Message is not in Sent." };
        if (missing.length) return { ok: false, detail: `Recipients missing from sent message: ${missing.join(", ")}` };
        return { ok: true, detail: `Sent message ${email.id} found in Sent with the expected recipients.` };
      }
      default:
        return { ok: true, detail: "No verification defined for this tool." };
    }
  } catch (e) {
    return { ok: false, detail: `Could not read back: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** After an undo, confirm the artifact is really gone. */
export async function verifyUndo(mcp: McpHub, undoTool: string, undoArgs: Record<string, any>): Promise<VerifyOutcome> {
  try {
    if (undoTool === "delete_event") {
      try { await mcp.callTool("get_event", { id: undoArgs.id }); return { ok: false, detail: "Event still exists." }; }
      catch { return { ok: true, detail: "Event no longer exists." }; }
    }
    if (undoTool === "delete_draft") {
      try { await mcp.callTool("get_draft", { id: undoArgs.id }); return { ok: false, detail: "Draft still exists." }; }
      catch { return { ok: true, detail: "Draft no longer exists." }; }
    }
    if (undoTool === "remove_label") {
      const { email } = await mcp.callTool("get_email", { id: undoArgs.id });
      return email.labels.includes(undoArgs.label) ? { ok: false, detail: "Label still present." } : { ok: true, detail: "Label removed." };
    }
    return { ok: true, detail: "n/a" };
  } catch (e) {
    return { ok: false, detail: `Could not read back: ${e instanceof Error ? e.message : String(e)}` };
  }
}
