/** npm run e2e: offline end-to-end scenario (sandbox data, scripted LLMs, real Guard/MCP/DB). */
import { runE2E } from "./e2e-lib.js";

process.env.NODE_ENV = "test"; // silence the request logger
console.log("Munshi E2E (SANDBOX DATA; LLM calls are scripted mocks, everything else is the real stack)\n");
try {
  await runE2E((l) => console.log(l));
  console.log("\nAll E2E steps passed.");
} catch (e) {
  console.error(`\nE2E FAILED: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
process.exit(0);
