import { useState } from "react";
import { api2, type Action, type Health, type RunDetail } from "../api";
import { Banner, Chip, DecisionChip, fmtTime, StatusBadge, usePoll, useNow, Warnings } from "../components";

export const DEFAULT_GOAL = "Set reminders for my bills and deadlines and draft follow-ups where needed";

function Timeline({ d }: { d: RunDetail }) {
  const now = useNow();
  const byId = new Map<string, Action>(d.actions.map((a) => [a.id, a]));
  return (
    <ol className="space-y-3 border-l-2 border-stone-200 pl-4">
      {d.trace.map((t, i) => {
        if (t.kind === "proposed") {
          const a = byId.get(String(t.actionId));
          return (
            <li key={i} className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-stone-400">{fmtTime(t.ts)}</span>
                {a ? <DecisionChip a={a} /> : <Chip tone="stone">{String(t.decision)}</Chip>}
                {a && <StatusBadge a={a} now={now} />}
                <span className="font-mono text-xs text-stone-500">{String(t.tool)}</span>
              </div>
              <p className="text-sm font-medium">{String(t.preview)}</p>
              <p className="text-xs text-stone-600">
                <span className="text-stone-400">{String(t.rule)}:</span> {String(t.reason)}
              </p>
              {a && a.tainted && <Warnings a={a} />}
            </li>
          );
        }
        const label: Record<string, string> = { goal: "Goal", assistant: "Agent", paused: "Paused", resumed: "Resumed", finished: "Finished", error: "Error" };
        const text =
          t.kind === "goal" ? `${String(t.goal)} (${String(t.obligationCount)} obligations)`
          : t.kind === "assistant" || t.kind === "finished" || t.kind === "error" ? String(t.kind === "assistant" ? t.text : t.summary)
          : t.kind === "paused" ? String(t.reason) : "Approval received; the agent continues.";
        return (
          <li key={i} className="text-sm">
            <span className="mr-2 text-xs text-stone-400">{fmtTime(t.ts)}</span>
            <b className={t.kind === "error" ? "text-red-700" : ""}>{label[t.kind] ?? t.kind}:</b> {text}
          </li>
        );
      })}
    </ol>
  );
}

export default function RunPanel({ health, obligationCount, onChange, goToApprovals }: { health: Health | null; obligationCount: number; onChange: () => void; goToApprovals: () => void }) {
  const [goal, setGoal] = useState(DEFAULT_GOAL);
  const [runId, setRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  usePoll(
    async () => {
      if (!runId) return;
      const d = await api2.run(runId);
      setDetail(d);
      onChange();
    },
    1000,
    [runId],
  );

  const start = async () => {
    setStarting(true);
    setErr(null);
    setDetail(null);
    try {
      setRunId((await api2.startRun(goal)).runId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const live = detail && (detail.run.status === "running" || detail.run.status === "awaiting_approval");
  const disabled = starting || Boolean(live) || !health?.agentAvailable || obligationCount === 0;
  const pending = detail?.actions.filter((a) => a.status === "pending_approval").length ?? 0;

  return (
    <section className="space-y-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <h2 className="text-lg font-semibold">Handle these</h2>
      <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} className="w-full rounded-lg border border-stone-300 p-2 text-sm" aria-label="Goal for the agent" />
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => void start()} disabled={disabled} className="rounded-lg bg-saffron px-4 py-2 text-sm font-semibold text-white hover:bg-saffron/90 disabled:cursor-not-allowed disabled:opacity-40">
          {live ? "Run in progress…" : "Handle these"}
        </button>
        {health && !health.agentAvailable && <span className="text-xs text-amber-800">Disabled: {health.agentError}</span>}
        {health?.agentAvailable && obligationCount === 0 && <span className="text-xs text-stone-500">Scan your inbox first.</span>}
      </div>
      {err && <Banner tone="red">{err}</Banner>}
      {detail && (
        <div className="space-y-3 pt-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Chip tone={detail.run.status === "failed" ? "darkred" : detail.run.status === "completed" ? "green" : "blue"}>{detail.run.status.replace("_", " ")}</Chip>
            {pending > 0 && (
              <button onClick={goToApprovals} className="font-medium text-amber-800 underline">{pending} action{pending > 1 ? "s" : ""} need your approval →</button>
            )}
          </div>
          <Timeline d={detail} />
        </div>
      )}
    </section>
  );
}
