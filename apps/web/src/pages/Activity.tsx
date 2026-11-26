import { useState } from "react";
import { api2, type Action, type RunDetail } from "../api";
import { Banner, Chip, DecisionChip, fmtTime, StatusBadge, usePoll, useNow, Warnings } from "../components";
import { ActionDrawer } from "../drawers";
import { plural } from "../plain";

function Timeline({ d }: { d: RunDetail }) {
  const now = useNow();
  const byId = new Map<string, Action>(d.actions.map((a) => [a.id, a]));
  return (
    <ol className="space-y-3 border-l-2 border-line pl-4">
      {d.trace.map((t, i) => {
        if (t.kind === "proposed") {
          const a = byId.get(String(t.actionId));
          return (
            <li key={i} className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-soft">{fmtTime(t.ts)}</span>
                {a ? <DecisionChip a={a} /> : <Chip tone="stone">{String(t.decision)}</Chip>}
                {a && <StatusBadge a={a} now={now} />}
                <span className="font-mono text-xs text-soft">{String(t.tool)}</span>
              </div>
              <p className="break-words text-sm font-medium">{String(t.preview)}</p>
              <p className="break-words text-xs text-soft">
                <code>{String(t.rule)}</code>: {String(t.reason)}
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

export default function Activity({ actions, mode, refresh }: { actions: Action[]; mode: "sandbox" | "google" | undefined; refresh: () => void }) {
  const now = useNow();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const skipped = actions.filter((a) => a.decision === "skipped").length;
  const rows = showSkipped ? actions : actions.filter((a) => a.decision !== "skipped");
  const openAction = actions.find((a) => a.id === open);

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
      <p className="text-sm text-soft">Every proposed action, the Guard's decision, and the read-back result.</p>
      {err && <Banner tone="red">{err}</Banner>}
      <LatestRun />
      {skipped > 0 && (
        <label className="flex items-center gap-2 text-sm text-soft">
          <input type="checkbox" checked={showSkipped} onChange={(e) => setShowSkipped(e.target.checked)} className="accent-accent" />
          Show {plural(skipped, "skipped duplicate")}
        </label>
      )}
      {rows.length === 0 ? (
        <p className="panel p-8 text-center text-sm text-soft">No activity yet. On Today, scan your inbox, then let Munshi handle it.</p>
      ) : (
        <ul className="panel divide-y divide-line">
          {rows.map((a) => (
            <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
              <div className="min-w-0 flex-1 basis-60 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge a={a} now={now} />
                  <DecisionChip a={a} />
                  <span className="text-xs text-soft">{fmtTime(a.createdAt)}</span>
                </div>
                <p className="break-words text-sm font-medium">{a.preview}</p>
                {a.status === "verification_failed" && <p className="text-sm font-semibold text-danger">Read-back did not match: {a.verify?.detail}</p>}
                {(a.status === "blocked" || a.status === "failed") && <p className="break-words text-xs text-danger">{a.reason}</p>}
              </div>
              <div className="flex items-center gap-3">
                <button onClick={() => setOpen(a.id)} className="btn-text" aria-label={`Details: ${a.preview}`}>Details</button>
                {a.canUndo ? (
                  <button disabled={busy === a.id} onClick={() => void undo(a)} className="btn-quiet">{a.undoHint}</button>
                ) : (
                  a.undoHint && <span className="text-xs text-soft">{a.undoHint}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {openAction && <ActionDrawer a={openAction} mode={mode} onClose={() => setOpen(null)} />}
    </div>
  );
}
