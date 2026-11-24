import { readFileSync } from "node:fs";
import { istDate } from "@munshi/mcp-common";
import { REPLAY_RECORDING_PATH } from "../config.js";
import type { AgentLlm, AgentMessage, AgentStep, ToolCall } from "./agent.js";
import { LlmError, type LlmAdapter, type LlmRequest } from "./types.js";

/**
 * LLM_PROVIDER=replay: recorded extractor + agent outputs from fixtures/replay/recording.json, so the whole sandbox flow
 * works with no API key. These are NOT live AI. The UI shows a DEMO MODE banner whenever this provider is active.
 * The recorded outputs go through exactly the same validation, vetting and Guard as live model output.
 */
export const REPLAY_BANNER = "DEMO MODE — scripted sample outputs, not live AI";

interface Recording {
  extractor: { fromAddress: string; response: unknown }[];
  agent: {
    plan: { titleContains: string; calls: { name: string; args: Record<string, unknown> }[] }[];
    finalText: string;
  };
}

export function loadRecording(path = REPLAY_RECORDING_PATH): Recording {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Recording;
  } catch (e) {
    throw new LlmError(`Replay recording could not be read (${path}): ${(e as Error).message}`, true);
  }
}

/** {{date:N}} -> the IST calendar date N days from `now` (sandbox fixture dates are relative to today too). */
const fillDates = <T>(v: T, now: Date): T =>
  JSON.parse(JSON.stringify(v).replace(/\{\{date:(-?\d+)\}\}/g, (_m, n: string) => istDate(Number(n), 0, 0, now).slice(0, 10))) as T;

export class ReplayLlm implements LlmAdapter {
  readonly provider = "replay";
  readonly model = "recorded";
  constructor(private readonly rec: Recording = loadRecording(), private readonly now: () => Date = () => new Date()) {}

  async complete(req: LlmRequest): Promise<string> {
    const from = /^From: .*<([^>\n]+)>/m.exec(req.user)?.[1]?.trim().toLowerCase();
    const hit = this.rec.extractor.find((e) => e.fromAddress.toLowerCase() === from);
    return JSON.stringify(hit ? fillDates(hit.response, this.now()) : { obligations: [] });
  }
}

export class ReplayAgent implements AgentLlm {
  readonly provider = "replay";
  readonly model = "recorded";
  constructor(private readonly rec: Recording = loadRecording(), private readonly now: () => Date = () => new Date()) {}

  async step({ messages }: { messages: AgentMessage[] }): Promise<AgentStep> {
    // Only the first step proposes calls; after tool results come back the recording just summarises.
    if (messages.length > 1) return { text: this.rec.agent.finalText, toolCalls: [], raw: undefined };
    const first = messages[0] as { text: string };
    const m = /<untrusted_obligations>\n([\s\S]*?)\n<\/untrusted_obligations>/.exec(first.text);
    const obligations = (m ? JSON.parse(m[1]!) : []) as { id: string; title: string; senderAddress: string }[];
    const toolCalls: ToolCall[] = [];
    for (const o of obligations) {
      const plan = this.rec.agent.plan.find((p) => o.title.includes(p.titleContains));
      for (const c of plan?.calls ?? []) {
        const args = JSON.parse(JSON.stringify(c.args).replace(/\$id/g, o.id).replace(/\$senderAddress/g, o.senderAddress)) as Record<string, unknown>;
        toolCalls.push({ id: `replay-${toolCalls.length}`, name: c.name, args: fillDates(args, this.now()) });
      }
    }
    return { text: toolCalls.length ? "" : "No recorded plan matches these obligations.", toolCalls, raw: undefined };
  }
}
