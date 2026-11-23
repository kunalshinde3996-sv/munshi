/**
 * Live extraction check: runs the REAL configured LLM (from .env) over all sandbox emails and prints the
 * obligations as a table. Uses an in-memory DB, so it never touches your app data.
 *   npm run extract:live
 */
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { createLlm } from "../src/llm/index.js";
import { McpHub } from "../src/mcp/hub.js";
import { listEmails, listObligations, scanInbox } from "../src/scan.js";

const config = loadConfig();
const made = createLlm(config);
if ("error" in made) {
  console.error(`Cannot run live extraction: ${made.error}\nSet LLM_PROVIDER, LLM_MODEL and the matching API key in .env.`);
  process.exit(1);
}

const { db } = openDb(":memory:");
const mcp = new McpHub({ sandboxDir: config.SANDBOX_STORE_DIR });
await mcp.connect();
console.log(`SANDBOX DATA | provider=${made.llm.provider} model=${made.llm.model}\n`);

try {
  const summary = await scanInbox({ db, mcp, llm: made.llm, force: true, onProgress: (m) => console.log(`  ${m}`) });

  console.log("\nOBLIGATIONS (SANDBOX DATA)");
  console.table(
    listObligations(db).map((o) => ({
      email: o.emailId.replace("sbx-", ""),
      type: o.type,
      title: o.title,
      due: o.dueDate ?? "-",
      amount: o.amount != null ? `${o.currency ?? ""} ${o.amount}`.trim() : "-",
      counterparty: o.counterparty ?? "-",
      conf: o.confidence.toFixed(2),
    })),
  );

  console.log("\nEMAILS WITH NO OBLIGATIONS / FLAGS");
  console.table(
    listEmails(db)
      .filter((e) => e.obligationCount === 0 || e.status !== "done" || e.flags?.hiddenContent.length || e.flags?.injectionSuspected.length || e.flags?.rejectedObligations.length)
      .map((e) => ({
        email: e.id.replace("sbx-", ""),
        status: e.status,
        obligations: e.obligationCount,
        hidden: e.flags?.hiddenContent.length ?? 0,
        injection: e.flags?.injectionSuspected.length ?? 0,
        rejected: e.flags?.rejectedObligations.length ?? 0,
        error: e.error ?? "",
      })),
  );
  console.log("\nSummary:", summary);
} catch (e) {
  console.error(`\nScan aborted: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
} finally {
  await mcp.close();
}
