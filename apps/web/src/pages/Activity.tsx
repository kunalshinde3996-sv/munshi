import { useState } from "react";
import { api2, type Action } from "../api";
import { Banner, DecisionChip, fmtTime, StatusBadge, useNow } from "../components";

export default function Activity({ actions, refresh }: { actions: Action[]; refresh: () => void }) {
  const now = useNow();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
      <div>
        <h1 className="text-2xl font-semibold">Activity</h1>
        <p className="text-sm text-stone-600">Every action the agent proposed, what the Guard decided, and whether the result was read back and verified.</p>
      </div>
      {err && <Banner tone="red">{err}</Banner>}
      {actions.length === 0 ? (
        <p className="rounded-xl border border-dashed border-stone-300 p-8 text-center text-sm text-stone-500">No activity yet. Scan your inbox, then “Handle these”.</p>
      ) : (
        <ul className="divide-y divide-stone-200 rounded-xl border border-stone-200 bg-white">
          {actions.map((a) => (
            <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge a={a} now={now} />
                  <DecisionChip a={a} />
                  <span className="text-xs text-stone-400">{fmtTime(a.createdAt)} · {a.tool} · {a.tier}</span>
                </div>
                <p className="text-sm font-medium">{a.preview}</p>
                {a.status === "verification_failed" && <p className="text-sm font-semibold text-red-700">Read-back did not match: {a.verify?.detail}</p>}
                {a.status === "verified" && a.verify && <p className="text-xs text-emerald-700">{a.verify.detail}</p>}
                {(a.status === "blocked" || a.status === "failed") && <p className="text-xs text-red-700">{a.reason}</p>}
              </div>
              {a.canUndo ? (
                <button disabled={busy === a.id} onClick={() => void undo(a)} className="rounded-lg border border-stone-300 px-3 py-1 text-sm font-medium hover:bg-stone-50 disabled:opacity-40">
                  {a.undoHint}
                </button>
              ) : (
                a.undoHint && <span className="text-xs text-stone-400">{a.undoHint}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
