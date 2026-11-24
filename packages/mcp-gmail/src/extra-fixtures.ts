import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { humanDate, istDate, SANDBOX_USER_EMAIL } from "@munshi/mcp-common";
import type { Email } from "./types.js";

/**
 * SANDBOX DATA: extra fictional emails loaded from `*.json` files in a directory (used for the attack-evaluation
 * mailbox in fixtures/attacks). Each entry may carry extra evaluation metadata (attack, obligation, obeyQuote, style);
 * ONLY the email fields below are ever served by the MCP server, so evaluation answers never leak into the mailbox.
 * `{{date:N}}` is replaced by the date N days from now, so due dates are always upcoming.
 */
interface Entry {
  id: string;
  daysAgo: number;
  from: { name?: string; address: string };
  subject: string;
  body: string;
}

export function loadExtraFixtures(dir: string, now = new Date()): Email[] {
  if (!existsSync(dir)) throw new Error(`SANDBOX_EXTRA_FIXTURES directory not found: ${dir}`);
  const fill = (s: string) => s.replace(/\{\{date:(-?\d+)\}\}/g, (_m, n: string) => humanDate(Number(n), now));
  const out: Email[] = [];
  let i = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const entries = JSON.parse(readFileSync(join(dir, file), "utf8")) as Entry[];
    for (const e of entries) {
      const body = fill(e.body);
      out.push({
        id: e.id,
        threadId: `thread-${e.id}`,
        from: e.from,
        to: [SANDBOX_USER_EMAIL],
        cc: [],
        subject: fill(e.subject),
        date: istDate(-e.daysAgo, 8 + (i++ % 12), 7 * (i % 8), now),
        body,
        labels: ["INBOX"],
        snippet: body.replace(/\s+/g, " ").slice(0, 110),
      });
    }
  }
  return out;
}
