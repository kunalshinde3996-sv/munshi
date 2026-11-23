import { describe, it } from "vitest";
import { runE2E } from "../scripts/e2e-lib.js";

describe("end-to-end (sandbox, scripted LLMs)", () => {
  it("scan → handle → approve → verify → undo, injection blocked, hold-window cancel, audit append-only", async () => {
    await runE2E();
  }, 120_000);
});
