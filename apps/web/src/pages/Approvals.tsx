import { useState } from "react";
import { api2, type Action } from "../api";
import { Banner, Chip, DecisionChip, Warnings } from "../components";

export function ApprovalCard({ a, onDone }: { a: Action; onDone: () => void }) {
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const isSend = a.tool === "send_email";
  return (
    <article className={`space-y-3 rounded-xl border bg-white p-4 shadow-sm ${a.tainted ? "border-red-300" : "border-amber-300"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <DecisionChip a={a} />
        <Chip tone="stone">{a.tool} · {a.tier}</Chip>
        {a.rule && <span className="text-xs text-stone-400">rule: {a.rule}</span>}
      </div>
      <p className="font-medium">{a.preview}</p>
      <Warnings a={a} />
      <details className="text-xs text-stone-600">
        <summary className="cursor-pointer">Why the Guard asked, and where each recipient came from</summary>
        <p className="mt-1">{a.reason}</p>
        {a.taint.length > 0 && (
          <ul className="mt-1 space-y-1">
            {a.taint.map((t, i) => (
              <li key={i}>
                <b>{t.value}</b> ({t.arg}) — {t.trusted ? <span className="text-emerald-700">trusted</span> : <span className="text-red-700">untrusted</span>}
                {t.allowlisted && " · in your contacts / your own address"}. {t.explanation}
              </li>
            ))}
          </ul>
        )}
        <pre className="mt-2 overflow-x-auto rounded bg-stone-50 p-2">{JSON.stringify(a.args, null, 2)}</pre>
      </details>
      {a.tainted && (
        <label className="flex items-start gap-2 text-sm text-red-900">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1" />
          I understand this value came from an email, not from me, and I still want to approve.
        </label>
      )}
      {err && <Banner tone="red">{err}</Banner>}
      <div className="flex gap-2">
        <button
          disabled={busy || (a.tainted && !ack)}
          onClick={() => void act(() => api2.approve(a.id, ack))}
          className="rounded-lg bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isSend ? "Approve (send after hold)" : "Approve"}
        </button>
        <button disabled={busy} onClick={() => void act(() => api2.reject(a.id))} className="rounded-lg border border-stone-300 px-4 py-1.5 text-sm font-medium hover:bg-stone-50 disabled:opacity-40">
          Reject
        </button>
      </div>
    </article>
  );
}

export default function Approvals({ pending, refresh }: { pending: Action[]; refresh: () => void }) {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <p className="text-sm text-stone-600">Actions the Guard will not run on its own. Nothing here has happened yet.</p>
      </div>
      {pending.length === 0 ? (
        <p className="rounded-xl border border-dashed border-stone-300 p-8 text-center text-sm text-stone-500">Nothing is waiting for your approval.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">{pending.map((a) => <ApprovalCard key={a.id} a={a} onDone={refresh} />)}</div>
      )}
    </div>
  );
}
