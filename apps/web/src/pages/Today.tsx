import { useEffect, useRef, useState } from "react";
import { api, api2, channelsApi, type Action, type EmailRow, type Health, type Nudge, type Obligation, type ScanSummary, type SchedulerStatus } from "../api";
import ApprovalCard, { type Choice } from "../ApprovalCard";
import { Banner, Spinner, usePoll, useNow } from "../components";
import { ActionDrawer, EmailDrawer, ObligationDrawer } from "../drawers";
import { CaughtUpArt, Icon } from "../icons";
import { stagger, useCountUp, useEntrance } from "../motion";
import { brief, decisionOutcome, doneTitle, dueThisWeek, groupByDue, handledLabel, money, plural, relativeDue, shieldLabel, suspiciousEmails } from "../plain";
import { notify } from "../toasts";
import type { RunState } from "../useRun";

const VISIBLE_ASKS = 3;
const VISIBLE_LATER = 3;
const DONE = ["verified", "executed"];

type Sheet = { kind: "obligation"; id: string } | { kind: "action"; id: string } | { kind: "email"; id: string } | null;

function Heading({ children, innerRef }: { children: React.ReactNode; innerRef?: React.Ref<HTMLHeadingElement> }) {
  return <h2 ref={innerRef} tabIndex={-1} className="font-display text-xl font-semibold">{children}</h2>;
}

function Stat({ label, value }: { label: string; value: number }) {
  const shown = useCountUp(value);
  return (
    <div className="card flex flex-col-reverse justify-end gap-0.5 p-3 sm:p-4">
      <dt className="text-xs text-soft sm:text-sm">{label}</dt>
      <dd className="font-display text-2xl font-semibold tabular-nums sm:text-3xl">
        <span aria-hidden>{shown}</span><span className="sr-only">{value}</span>
      </dd>
    </div>
  );
}

const longDate = (t: number) => new Date(t).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" });

/** The home screen: a short brief. What needs me, what is coming, what is already handled. */
export default function Today({ health, actions, refreshActions, run, snoozed, setSnoozed, goToTrust }: {
  health: Health | null;
  actions: Action[] | null;
  refreshActions: () => void;
  run: RunState;
  snoozed: string[];
  setSnoozed: React.Dispatch<React.SetStateAction<string[]>>;
  goToTrust: () => void;
}) {
  const [data, setData] = useState<{ obligations: Obligation[]; emails: EmailRow[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [readSoFar, setReadSoFar] = useState<{ first: boolean; count: number } | null>(null);
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [fresh, setFresh] = useState(false); // the last scan here found something new
  const [error, setError] = useState<string | null>(null);
  const [nudges, setNudges] = useState<Nudge[]>([]);
  const [sched, setSched] = useState<SchedulerStatus | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [showAllAsks, setShowAllAsks] = useState(false);
  const [showAllLater, setShowAllLater] = useState(false);
  const [busyUndo, setBusyUndo] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<Record<string, Action>>({}); // decided cards still animating out
  const needsRef = useRef<HTMLHeadingElement>(null);
  const now = useNow();
  const entrance = useEntrance("today", Boolean(data && actions));

  const load = async () => {
    try {
      const [obligations, emails] = await Promise.all([api.obligations(), api.emails()]);
      setData({ obligations, emails });
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };
  usePoll(load, 5000);
  usePoll(async () => setSched(await channelsApi.scheduler().catch(() => null)), 15000);
  usePoll(async () => setNudges(await channelsApi.nudges().catch(() => [])), 15000);
  // While scanning, each email appears in the database as it is read, so the count shown is real progress.
  usePoll(async () => {
    if (!scanning || !readSoFar?.first) return;
    const emails = await api.emails();
    setReadSoFar((p) => p && { ...p, count: emails.length });
  }, 400, [scanning]);
  useEffect(() => { if (run.waiting) refreshActions(); }, [run.waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data || !actions) return loadError ? <Banner tone="red">{loadError}</Banner> : <div className="panel"><Spinner label="Getting today ready…" /></div>;
  const { obligations, emails } = data;
  const byId = new Map(obligations.map((o) => [o.id, o]));

  // Anything waiting on the user is always shown. History is limited to the mailbox currently on screen.
  const mine = actions.filter((a) => !a.obligationId || byId.has(a.obligationId));
  const oldestFirst = [...actions].reverse();
  const pending = oldestFirst.filter((a) => a.status === "pending_approval");
  const cards = oldestFirst.flatMap((a) => leaving[a.id] ?? (a.status === "pending_approval" && !snoozed.includes(a.id) ? a : []));
  const setAside = pending.filter((a) => snoozed.includes(a.id) && !leaving[a.id]).length;
  const held = actions.filter((a) => a.status === "held");
  const done = mine.filter((a) => DONE.includes(a.status));
  const undone = mine.filter((a) => a.status === "undone");
  const problems = mine.filter((a) => a.status === "failed" || a.status === "verification_failed");

  const scanned = emails.length > 0;
  const live = run.working || run.waiting;
  const handledIds = new Set(actions.map((a) => a.obligationId));
  const readyToHandle = obligations.length > 0 && !live && pending.length === 0 && (fresh || !obligations.some((o) => handledIds.has(o.id)));
  const remindedFor = new Set(done.filter((a) => a.tool === "create_event").map((a) => a.obligationId));
  const dueSoon = new Set(nudges.map((n) => n.obligationId));
  const failedEmails = emails.filter((e) => e.status === "extraction_failed");
  const { blocked } = suspiciousEmails(emails);
  const shield = shieldLabel(emails, mine.filter((a) => a.decision === "block").length);
  const caughtUp = scanned && !live && !readyToHandle && pending.length === 0 && cards.length === 0 && held.length === 0 && problems.length === 0;

  const headline = brief({
    scanned, readyToHandle,
    needs: pending.length, handled: done.length, problems: problems.length, comingUp: obligations.length, stopped: blocked.length,
  });

  const scan = async () => {
    setScanning(true);
    setReadSoFar({ first: !scanned, count: 0 });
    setError(null);
    try {
      const s = await api.scan(false);
      setSummary(s);
      if (s.obligations > 0) setFresh(true);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  };
  const handle = async () => { if (await run.start()) setFresh(false); };

  const undo = async (a: Action) => {
    setBusyUndo(a.id);
    setError(null);
    try {
      await api2.undo(a.id);
      notify({ text: `${a.status === "held" ? "Send cancelled" : "Undone"}: ${doneTitle(a, emails)}` });
      refreshActions();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyUndo(null);
    }
  };

  const unpin = (id: string) => setLeaving((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== id)));
  const decided = (choice: Choice, result: Action) => {
    const o = decisionOutcome(choice, result, emails);
    if (choice === "snooze") setSnoozed((x) => [...x, result.id]);
    notify({
      text: o.toast,
      tone: o.ok ? "ok" : "error",
      action: o.undo
        ? {
            label: o.undo.label,
            run: o.undo.kind === "unsnooze"
              ? () => setSnoozed((x) => x.filter((id) => id !== result.id))
              // A failed undo raises its own error toast from the API layer.
              : () => void api2.undo(result.id).then(() => { notify({ text: result.status === "held" ? "Send cancelled" : "Undone" }); refreshActions(); }).catch(() => undefined),
          }
        : undefined,
    });
    if (choice !== "snooze") refreshActions();
  };

  // While something waits for the user, the approval cards are the primary action, so the big button steps aside.
  const showPrimary = pending.length === 0;
  const scanningText = readSoFar?.first
    ? readSoFar.count ? `Reading your mail… ${readSoFar.count} read` : "Reading your mail…"
    : "Checking your mail…";
  const workingText = run.steps ? `Munshi is working… ${plural(run.steps, "action")} so far` : "Munshi is working…";
  const primary = live
    ? { label: workingText, busy: true, onClick: () => undefined, disabled: true }
    : readyToHandle
      ? { label: "Let Munshi handle it", busy: false, onClick: () => void handle(), disabled: !health?.agentAvailable }
      : { label: scanning ? scanningText : "Scan inbox", busy: scanning, onClick: () => void scan(), disabled: scanning || !health?.llmConfigured };

  const sheetAction = sheet?.kind === "action" ? actions.find((a) => a.id === sheet.id) : undefined;
  const sheetObligation = sheet?.kind === "obligation" ? byId.get(sheet.id) : undefined;
  const close = () => setSheet(null);

  const undoButton = (a: Action) =>
    a.canUndo ? (
      <button disabled={busyUndo === a.id} onClick={() => void undo(a)} className="btn-quiet" aria-label={`${a.undoHint}: ${doneTitle(a, emails)}`}>
        {busyUndo === a.id && <span className="spinner" aria-hidden />}{a.undoHint}
      </button>
    ) : null;

  const attention = (label: string, rows: Action[], line: (a: Action) => React.ReactNode, danger = false) => (
    <section className={`panel enter space-y-3 p-4 sm:p-5 ${danger ? "border-danger" : ""}`} style={stagger(2)} aria-label={label}>
      <Heading>{label}</Heading>
      <ul className="space-y-2">
        {rows.map((a) => (
          <li key={a.id} className="card flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0 flex-1">
              <p className="break-words font-medium">{doneTitle(a, emails)}</p>
              {line(a)}
            </div>
            <button onClick={() => setSheet({ kind: "action", id: a.id })} className="btn-text">Details</button>
            {undoButton(a)}
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <div className="space-y-4" data-entrance={entrance}>
      <section className="enter space-y-5 rounded-2xl border border-line bg-hero p-5 sm:p-8" style={stagger(0)} aria-label="Today's brief">
        <div className="space-y-2">
          <p className="text-sm font-medium text-soft">{longDate(now)}</p>
          <h1 className="font-display max-w-3xl text-[1.75rem] font-semibold leading-tight sm:text-4xl" aria-live="polite">{headline}</h1>
          {!scanned && <p className="text-soft">Munshi reads your mail and picks out what you owe.</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {showPrimary && (
            <button onClick={primary.onClick} disabled={primary.disabled} className="btn-primary min-h-12 w-full px-8 text-base sm:w-auto md:min-h-12">
              {primary.busy && <span className="spinner" aria-hidden />}
              <span aria-live="polite">{primary.label}</span>
            </button>
          )}
          {scanned && (readyToHandle || live || !showPrimary) && (
            <button onClick={() => void scan()} disabled={scanning || !health?.llmConfigured} className="btn-quiet">
              {scanning && <span className="spinner" aria-hidden />}{scanning ? scanningText : "Check for new mail"}
            </button>
          )}
          {shield && (
            <button onClick={goToTrust} className="lift inline-flex min-h-11 items-center gap-2 rounded-full bg-panel px-4 text-sm font-semibold text-accent-deep md:min-h-10">
              <Icon name="shield" size={16} />{shield}
            </button>
          )}
        </div>
        {readyToHandle && (
          <details className="text-sm">
            <summary className="w-fit text-soft">Change instructions</summary>
            <textarea value={run.goal} onChange={(e) => run.setGoal(e.target.value)} rows={2} className="field reveal mt-2 w-full max-w-2xl" aria-label="Instructions for Munshi" />
          </details>
        )}
        {health && !health.llmConfigured && <Banner tone="amber">Scanning is off: {health.llmError}. Set it in <code>.env</code> and restart.</Banner>}
        {health && readyToHandle && !health.agentAvailable && <Banner tone="amber">Munshi can't act yet: {health.agentError}</Banner>}
        {summary && showPrimary && <p className="text-sm text-soft" role="status">Checked {plural(summary.listed, "email")}.{summary.failed > 0 && ` ${summary.failed} couldn't be read.`}</p>}
        {error && <Banner tone="red">{error}</Banner>}
        {loadError && <Banner tone="red">{loadError}</Banner>}
        {run.error && <Banner tone="red">{run.error}</Banner>}
        {run.failure && <Banner tone="red">Munshi couldn't finish: {run.failure}</Banner>}
        {sched?.lastError && <Banner tone="red">Background check failed: {sched.lastError}</Banner>}
        {failedEmails.length > 0 && (
          <details className="text-sm text-danger">
            <summary className="w-fit font-medium">{plural(failedEmails.length, "email")} couldn't be read</summary>
            <ul className="reveal mt-2 space-y-1 pl-4">
              {failedEmails.map((e) => <li key={e.id}><button onClick={() => setSheet({ kind: "email", id: e.id })} className="break-words text-left underline">{e.subject}</button></li>)}
            </ul>
          </details>
        )}
        {scanned && (
          <dl className="grid max-w-xl grid-cols-3 gap-2 sm:gap-3" aria-label="At a glance">
            <Stat label="Due this week" value={dueThisWeek(obligations, now)} />
            <Stat label="Handled" value={done.length} />
            <Stat label="Stopped" value={blocked.length} />
          </dl>
        )}
      </section>

      {(scanned || pending.length > 0 || held.length > 0) && (
        <div className="grid items-start gap-4 md:grid-cols-2">
          <div className="min-w-0 space-y-4">
            <section className="panel enter p-4 sm:p-5" style={stagger(1)} aria-label="Needs you">
              <div className="pb-3"><Heading innerRef={needsRef}>Needs you</Heading></div>
              {(showAllAsks ? cards : cards.slice(0, VISIBLE_ASKS)).map((a) => (
                <ApprovalCard
                  key={a.id} a={a} obligation={a.obligationId ? byId.get(a.obligationId) : undefined} emails={emails} holdSeconds={health?.holdSeconds}
                  onPin={(x) => setLeaving((l) => ({ ...l, [x.id]: x }))}
                  onDecided={decided}
                  onFailed={unpin}
                  onGone={(id) => { unpin(id); needsRef.current?.focus({ preventScroll: true }); }}
                  onDetails={() => setSheet({ kind: "action", id: a.id })}
                />
              ))}
              {cards.length > VISIBLE_ASKS && (
                <button onClick={() => setShowAllAsks(!showAllAsks)} className="btn-text mb-3" aria-expanded={showAllAsks}>{showAllAsks ? "Show fewer" : `Show all ${cards.length}`}</button>
              )}
              {setAside > 0 && (
                <p className="text-sm text-soft">{setAside} set aside, still waiting. <button onClick={() => setSnoozed([])} className="btn-text">Show again</button></p>
              )}
              {cards.length > 0 && <p className="hidden text-xs text-soft md:block">With a card selected: <kbd className="font-semibold">A</kbd> approves, <kbd className="font-semibold">R</kbd> rejects.</p>}
              {cards.length === 0 && setAside === 0 && (
                caughtUp ? (
                  <div className="fade-in flex flex-col items-center gap-3 py-6 text-center">
                    <CaughtUpArt />
                    <p className="font-display text-xl font-semibold">You're all caught up.</p>
                  </div>
                ) : (
                  <p className="inset p-4 text-sm text-soft">
                    {run.working ? "Munshi is working. Anything it needs from you appears here."
                      : readyToHandle ? "Nothing yet. When Munshi needs your yes, it appears here."
                      : "Nothing to approve."}
                  </p>
                )
              )}
            </section>

            {held.length > 0 && attention("Sending soon", held, (a) => <p className="text-sm text-soft">Sends in {Math.max(0, Math.ceil(((a.holdUntil ?? now) - now) / 1000))}s</p>)}
            {problems.length > 0 && attention("Check these", problems, (a) => <p className="text-sm text-danger">{a.status === "failed" ? "This didn't work." : "Couldn't confirm this worked."}</p>, true)}
          </div>

          <section className="panel enter space-y-4 p-4 sm:p-5" style={stagger(2)} aria-label="Coming up">
            <Heading>Coming up</Heading>
            {obligations.length === 0 && <p className="inset p-4 text-sm text-soft">Nothing coming up.</p>}
            {groupByDue(obligations).map((g) => {
              const items = g.id === "later" && !showAllLater ? g.items.slice(0, VISIBLE_LATER) : g.items;
              return (
                <div key={g.id} className="space-y-1">
                  <h3 className={`text-sm font-semibold ${g.id === "past" ? "text-danger" : "text-soft"}`}>{g.label}</h3>
                  <ul>
                    {items.map((o, i) => (
                      <li key={o.id} className="enter" style={stagger(i + 3)}>
                        <button onClick={() => setSheet({ kind: "obligation", id: o.id })} className="row grid w-full grid-cols-[36px_1fr_auto] items-center gap-3 rounded-xl py-2 pl-1 pr-2 text-left">
                          <span className="grid h-9 w-9 place-items-center rounded-full bg-wash text-accent-deep"><Icon name={o.type} size={18} /></span>
                          <span className="min-w-0">
                            <span className="block break-words font-medium">{o.title}</span>
                            {dueSoon.has(o.id) && <span className="text-xs font-semibold text-warn">Not handled yet</span>}
                            {remindedFor.has(o.id) && <span className="text-xs text-accent-deep">Reminder set ✓</span>}
                          </span>
                          <span className="text-right">
                            {money(o.amount, o.currency) && <span className="block font-semibold tabular-nums">{money(o.amount, o.currency)}</span>}
                            <span className="block text-sm text-soft">{relativeDue(o.dueDate)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {g.id === "later" && g.items.length > VISIBLE_LATER && (
                    <button onClick={() => setShowAllLater(!showAllLater)} className="btn-text ml-1 min-h-9" aria-expanded={showAllLater}>
                      {showAllLater ? "Show fewer" : `Show ${g.items.length - VISIBLE_LATER} more`}
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        </div>
      )}

      {done.length + undone.length > 0 && (
        <section className="enter" style={stagger(3)} aria-label="Handled">
          <details className="panel" data-testid="handled">
            <summary className="flex min-h-11 items-center justify-between gap-3 p-4 sm:px-5">
              <h2 className="font-display text-lg font-semibold">Handled</h2>
              <span className="text-right text-sm text-accent-deep">{done.length ? `${handledLabel(done)} ✓` : `${undone.length} undone`}</span>
            </summary>
            <ul className="reveal divide-y divide-line border-t border-line">
              {[...done, ...undone].map((a) => (
                <li key={a.id} className="row flex flex-wrap items-center justify-between gap-3 p-4 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium">{doneTitle(a, emails)}</p>
                    <p className={`text-sm ${a.status === "verified" ? "text-accent-deep" : "text-soft"}`}>
                      {a.status === "verified" ? "Done ✓" : a.status === "undone" ? "Undone" : "Finishing…"}
                      {a.status !== "undone" && !a.canUndo && a.undoHint ? `. ${a.undoHint}` : ""}
                    </p>
                  </div>
                  <button onClick={() => setSheet({ kind: "action", id: a.id })} className="btn-text" aria-label={`Details: ${doneTitle(a, emails)}`}>Details</button>
                  {undoButton(a)}
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}

      {sheetAction && <ActionDrawer a={sheetAction} mode={health?.mode} onClose={close} />}
      {sheetObligation && <ObligationDrawer o={sheetObligation} related={mine.filter((a) => a.obligationId === sheetObligation.id && a.decision !== "skipped")} mode={health?.mode} onClose={close} />}
      {sheet?.kind === "email" && <EmailDrawer id={sheet.id} mode={health?.mode} onClose={close} />}
    </div>
  );
}
