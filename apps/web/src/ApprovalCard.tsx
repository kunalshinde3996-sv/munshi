import { useEffect, useId, useRef, useState } from "react";
import { api2, type Action, type EmailRow, type Obligation } from "./api";
import { Banner } from "./components";
import { Icon } from "./icons";
import { COLLAPSE_MS, HOLD_MS, motionOff } from "./motion";
import { askSentence, decisionOutcome, taintLine, type Outcome } from "./plain";

export type Choice = "approve" | "reject" | "snooze";

export default function ApprovalCard({ a, obligation, emails, holdSeconds, onPin, onDecided, onFailed, onGone, onDetails }: {
  a: Action;
  obligation: Obligation | undefined;
  emails: EmailRow[];
  holdSeconds: number | undefined;
  /** A choice was made: keep this card on screen even if polling already sees the action as decided. */
  onPin: (a: Action) => void;
  /** The server confirmed (or, for "Not now", the choice applied). `result` is the action as the server returned it. */
  onDecided: (choice: Choice, result: Action) => void;
  /** The request failed: release the card; it stays as it was and shows the error. */
  onFailed: (id: string) => void;
  /** The card has finished folding away. */
  onGone: (id: string) => void;
  onDetails: () => void;
}) {
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<Choice | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [nudged, setNudged] = useState(0); // times Approve was tried while locked
  const [shaking, setShaking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn: () => void, ms: number) => timers.current.push(setTimeout(fn, ms));
  const askId = useId();
  const hintId = useId();
  const locked = a.tainted && !ack;
  const settled = busy !== null || outcome !== null;

  const finish = (choice: Choice, result: Action) => {
    const o = decisionOutcome(choice, result);
    setOutcome(o);
    onDecided(choice, result);
    later(() => {
      setCollapsed(true);
      later(() => onGone(a.id), motionOff() ? 0 : COLLAPSE_MS);
    }, HOLD_MS);
  };

  const act = async (choice: "approve" | "reject") => {
    setBusy(choice);
    setErr(null);
    onPin(a);
    try {
      const { action } = choice === "approve" ? await api2.approve(a.id, ack) : await api2.reject(a.id);
      finish(choice, action);
    } catch (e) {
      setErr((e as Error).message);
      onFailed(a.id);
    } finally {
      setBusy(null);
    }
  };

  const approve = () => {
    if (settled) return;
    if (locked) {
      // Stays locked: no request is made. The shake and the hint say why.
      setNudged((n) => n + 1);
      setShaking(true);
      later(() => setShaking(false), 400);
      return;
    }
    void act("approve");
  };
  const reject = () => { if (!settled) void act("reject"); };
  const notNow = () => { if (!settled) { onPin(a); finish("snooze", a); } };

  // A / R act only on the card that has focus, never globally. Held keys and modifier combos are ignored.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "a") { e.preventDefault(); approve(); }
    if (key === "r") { e.preventDefault(); reject(); }
  };

  const draftSubject = a.tool === "create_draft" || a.tool === "send_email" ? String(a.args.subject ?? "") : "";
  const many = a.taint.filter((t) => !t.trusted).length > 1;
  return (
    <div className="collapsible" data-collapsed={collapsed}>
      <div>
        <div className="pb-3">
          <article tabIndex={0} onKeyDown={onKeyDown} aria-labelledby={askId} aria-keyshortcuts="A R" className="card lift space-y-4 p-4 sm:p-5">
            <div className="flex gap-3">
              <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-wash text-accent-deep"><Icon name={obligation?.type ?? "other"} /></span>
              <div className="min-w-0 space-y-1">
                <h3 id={askId} className="font-display break-words text-lg font-semibold leading-snug">{askSentence(a, obligation, emails)}</h3>
                {draftSubject && <p className="break-words text-sm text-soft">Subject: “{draftSubject}”</p>}
                {a.tool === "send_email" && holdSeconds !== undefined && <p className="text-sm text-soft">Waits {holdSeconds}s first, so you can cancel.</p>}
              </div>
            </div>

            {a.tainted && !outcome && (
              <div className="space-y-2 rounded-xl bg-warn-wash p-3 text-sm text-warn">
                <p>
                  <span aria-hidden>⚠ </span>{taintLine(a)}{" "}
                  <button onClick={onDetails} className="rounded font-semibold underline underline-offset-2">Why?</button>
                </p>
                <label className="flex min-h-8 cursor-pointer items-center gap-2 font-semibold">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} disabled={settled} className="h-5 w-5 accent-accent" />
                  {many ? "I checked these addresses" : "I checked this address"}
                </label>
              </div>
            )}
            {err && <Banner tone="red">{err}</Banner>}
            {locked && nudged > 0 && <p role="status" className="text-sm font-semibold text-warn">Tick the box first.</p>}

            {outcome ? (
              <p role="status" className={`fade-in inline-flex min-h-11 items-center rounded-full px-5 text-sm font-semibold ${outcome.ok ? "bg-wash text-accent-deep" : "bg-danger-wash text-danger"}`}>
                {outcome.button}
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={approve} disabled={busy !== null} aria-disabled={locked || undefined} aria-describedby={locked ? hintId : undefined}
                  className={`btn-primary btn-approve ${shaking ? "shake" : ""}`}>
                  {busy === "approve" && <span className="spinner" aria-hidden />}
                  {busy === "approve" ? "Approving…" : "Approve"}
                </button>
                <button disabled={settled} onClick={notNow} className="btn-quiet">Not now</button>
                <button disabled={settled} onClick={reject} className="btn-danger">
                  {busy === "reject" && <span className="spinner" aria-hidden />}
                  {busy === "reject" ? "Rejecting…" : "Reject"}
                </button>
                <button onClick={onDetails} className="btn-text ml-auto min-h-11 md:min-h-10" aria-label={`Details: ${askSentence(a, obligation, emails)}`}>Details</button>
              </div>
            )}
            {locked && <span id={hintId} className="sr-only">Approve unlocks after you tick the address check.</span>}
          </article>
        </div>
      </div>
    </div>
  );
}
