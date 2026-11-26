import { useId, useState } from "react";
import { api2, type Action, type EmailRow, type Obligation } from "./api";
import { Banner } from "./components";
import { Icon } from "./icons";
import { askSentence, taintLine } from "./plain";

export default function ApprovalCard({ a, obligation, emails, holdSeconds, onDone, onNotNow, onDetails }: {
  a: Action;
  obligation: Obligation | undefined;
  emails: EmailRow[];
  holdSeconds: number | undefined;
  onDone: () => void;
  onNotNow: () => void;
  onDetails: () => void;
}) {
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const askId = useId();
  const hintId = useId();
  const locked = a.tainted && !ack;

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
  const approve = () => { if (!busy && !locked) void act(() => api2.approve(a.id, ack)); };
  const reject = () => { if (!busy) void act(() => api2.reject(a.id)); };

  // A / R act only on the card that has focus, never globally. Held keys and modifier combos are ignored.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "a") { e.preventDefault(); approve(); }
    if (key === "r") { e.preventDefault(); reject(); }
  };

  const draftSubject = a.tool === "create_draft" || a.tool === "send_email" ? String(a.args.subject ?? "") : "";
  return (
    <article tabIndex={0} onKeyDown={onKeyDown} aria-labelledby={askId} aria-keyshortcuts="A R" className="panel space-y-4 p-5 shadow-[0_8px_24px_-16px_rgb(23_48_44/0.35)] sm:p-6">
      <div className="flex gap-3">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-wash text-accent-deep"><Icon name={obligation?.type ?? "other"} /></span>
        <div className="min-w-0 space-y-1">
          <h3 id={askId} className="font-display break-words text-lg font-semibold leading-snug">{askSentence(a, obligation, emails)}</h3>
          {draftSubject && <p className="break-words text-sm text-soft">Subject: “{draftSubject}”</p>}
          {a.tool === "send_email" && holdSeconds !== undefined && <p className="text-sm text-soft">Waits {holdSeconds}s first, so you can cancel.</p>}
        </div>
      </div>

      {a.tainted && (
        <div className="space-y-2 rounded-xl bg-warn-wash p-3 text-sm text-warn">
          <p>
            <span aria-hidden>⚠ </span>{taintLine(a)}{" "}
            <button onClick={onDetails} className="rounded font-semibold underline underline-offset-2">Why?</button>
          </p>
          <label className="flex cursor-pointer items-center gap-2 font-semibold">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="h-4 w-4 accent-accent" />
            {a.taint.filter((t) => !t.trusted).length > 1 ? "I checked these addresses" : "I checked this address"}
          </label>
        </div>
      )}
      {err && <Banner tone="red">{err}</Banner>}

      <div className="flex flex-wrap items-center gap-2">
        <button disabled={busy || locked} onClick={approve} aria-describedby={locked ? hintId : undefined} className="btn-primary">Approve</button>
        <button disabled={busy} onClick={onNotNow} className="btn-quiet">Not now</button>
        <button disabled={busy} onClick={reject} className="btn text-danger enabled:hover:bg-red-50">Reject</button>
        <button onClick={onDetails} className="btn-text ml-auto" aria-label={`Details: ${askSentence(a, obligation, emails)}`}>Details</button>
      </div>
      {locked && <span id={hintId} className="sr-only">Approve unlocks after you tick the address check.</span>}
    </article>
  );
}
