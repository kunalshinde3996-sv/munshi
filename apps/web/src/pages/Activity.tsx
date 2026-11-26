import { useState } from "react";
import { api, api2, type Action, type EmailRow, type RunDetail } from "../api";
import { ActionCard, FinalStatus } from "../ActionRecord";
import { Banner, fmtTime, usePoll, useNow } from "../components";
import { plural, shortTitle } from "../plain";

function Timeline({ d }: { d: RunDetail }) {
  const now = useNow();
  const byId = new Map<string, Action>(d.actions.map((a) => [a.id, a]));
  return (
    <ol className="space-y-3 border-l-2 border-line pl-4">
      {d.trace.map((t, i) => {
        if (t.kind === "proposed") {
          // Title and outcome only: the reason for any flag is on the action's card below.
          const a = byId.get(String(t.actionId));
          return (
            <li key={i} className="space-y-1">
              <p className="break-words text-sm font-medium">
                <span className="mr-2 text-xs font-normal text-soft">{fmtTime(t.ts)}</span>
                {a ? shortTitle(a) : String(t.preview)}
              </p>
              {a && <FinalStatus a={a} now={now} />}
            </li>
          );
        }
        const label: Record<string, string> = { goal: "Goal", assistant: "Agent", paused: "Paused", resumed: "Resumed", finished: "Finished", error: "Error" };
        const text =
          t.kind === "goal" ? `${String(t.goal)} (${String(t.obligationCount)} obligations)`
          : t.kind === "assistant" || t.kind === "finished" || t.kind === "error" ? String(t.kind === "assistant" ? t.text : t.summary)
          : t.kind === "paused" ? String(t.reason) : "Approval received; the agent continues.";
        return (
          <li key={i} className="break-words text-sm">
            <span className="mr-2 text-xs text-soft">{fmtTime(t.ts)}</span>
            <b className={t.kind === "error" ? "text-danger" : ""}>{label[t.kind] ?? t.kind}:</b> {text}
          </li>
        );
      })}
    </ol>
  );
}

function LatestRun() {
  const [d, setD] = useState<RunDetail | null>(null);
  usePoll(async () => {
    const [latest] = await api2.runs();
    setD(latest ? await api2.run(latest.id) : null);
  }, 3000);
  if (!d) return null;
  return (
    <details className="panel">
      <summary className="p-4 font-semibold">Latest run, step by step ({d.run.status.replace("_", " ")})</summary>
      <div className="reveal border-t border-line p-4"><Timeline d={d} /></div>
    </details>
  );
}

export default function Activity({ actions, refresh, onOpenEmail }: { actions: Action[]; refresh: () => void; onOpenEmail: (id: string) => void }) {
  const now = useNow();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [emails, setEmails] = useState<EmailRow[]>([]);
  usePoll(async () => setEmails(await api.emails()), 10000);
  const skipped = actions.filter((a) => a.decision === "skipped").length;
  const rows = showSkipped ? actions : actions.filter((a) => a.decision !== "skipped");

  const undo = async (a: Action) => {
    setBusy(a.id);
    setErr(null);
    try {
      await api2.undo(a.id);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-soft">Everything Munshi proposed, and how it ended.</p>
      {err && <Banner tone="red">{err}</Banner>}
      <LatestRun />
      {skipped > 0 && (
        <label className="flex items-center gap-2 text-sm text-soft">
          <input type="checkbox" checked={showSkipped} onChange={(e) => setShowSkipped(e.target.checked)} className="accent-accent" />
          Show {plural(skipped, "skipped duplicate")}
        </label>
      )}
      {rows.length === 0 && <p className="panel p-8 text-center text-sm text-soft">No activity yet. On Today, scan your inbox, then let Munshi handle it.</p>}
      <div className="space-y-2">
        {rows.map((a) => (
          <ActionCard key={a.id} a={a} now={now} emails={emails} time={fmtTime(a.createdAt)} onOpenEmail={onOpenEmail}>
            {a.canUndo ? (
              <button disabled={busy === a.id} onClick={() => void undo(a)} className="btn-quiet">{a.undoHint}</button>
            ) : a.undoHint ? (
              <span className="text-xs text-soft">{a.undoHint}</span>
            ) : null}
          </ActionCard>
        ))}
      </div>
    </div>
  );
}
