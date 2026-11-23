import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { ActionExecutor } from "./agent/executor.js";
import { AgentRuntime } from "./agent/runtime.js";
import { Guard } from "./guard/guard.js";
import type { AgentLlm } from "./llm/agent.js";
import type { McpHub } from "./mcp/hub.js";
import { USER_ID } from "./scan.js";

export interface Services {
  guard: Guard;
  executor: ActionExecutor;
  /** Absent when no tool-calling LLM is configured; `agentError` says why. */
  runtime?: AgentRuntime;
  agentError?: string;
}

export function createServices(opts: {
  config: Pick<Config, "SEND_HOLD_SECONDS">;
  db: Db;
  mcp: McpHub;
  agent?: AgentLlm;
  agentError?: string;
  clock?: () => number;
}): Services {
  const { config, db, mcp, agent } = opts;
  const guard = new Guard(db, USER_ID, { holdSeconds: config.SEND_HOLD_SECONDS });
  guard.seedPolicies();
  let runtime: AgentRuntime | undefined;
  const executor = new ActionExecutor(db, mcp, guard, {
    holdSeconds: config.SEND_HOLD_SECONDS,
    clock: opts.clock,
    onSettled: (a) => runtime?.onActionSettled(a),
  });
  if (agent) runtime = new AgentRuntime({ db, mcp, guard, executor, agent, userId: USER_ID });
  return { guard, executor, runtime, agentError: agent ? undefined : opts.agentError };
}
