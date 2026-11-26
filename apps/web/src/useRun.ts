import { useState } from "react";
import { api2, type RunDetail } from "./api";
import { usePoll } from "./components";

export const DEFAULT_GOAL = "Set reminders for my bills and deadlines and draft follow-ups where needed";

/** The agent run started from this window. Lives in the app shell so switching screens does not lose it. */
export function useRun(onChange: () => void) {
  const [runId, setRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [starting, setStarting] = useState(false);
  const [goal, setGoal] = useState(DEFAULT_GOAL);
  const [error, setError] = useState<string | null>(null);

  const over = detail?.run.id === runId && (detail?.run.status === "completed" || detail?.run.status === "failed");
  usePoll(
    async () => {
      if (!runId || over) return;
      setDetail(await api2.run(runId));
      onChange();
    },
    1000,
    [runId, over],
  );

  const start = async () => {
    setStarting(true);
    setError(null);
    setDetail(null);
    try {
      setRunId((await api2.startRun(goal)).runId);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setStarting(false);
    }
  };

  const status = detail?.run.status;
  const working = starting || (runId !== null && !detail) || status === "running";
  const waiting = status === "awaiting_approval";
  const failure = status === "failed" ? String([...(detail?.trace ?? [])].reverse().find((t) => t.kind === "error")?.summary ?? "Unknown error") : null;
  return { goal, setGoal, start, working, waiting, failure, error };
}
export type RunState = ReturnType<typeof useRun>;
