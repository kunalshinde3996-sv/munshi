import { useEffect, useRef, useState } from "react";
import { api, api2, channelsApi, type Action, type EmailRow, type Health, type Nudge, type Obligation, type ScanSummary, type SchedulerStatus } from "../api";
import ApprovalCard from "../ApprovalCard";
import { Banner, Spinner, usePoll, useNow } from "../components";
import { ActionDrawer, EmailDrawer, ObligationDrawer } from "../drawers";
import { CaughtUpArt, Icon } from "../icons";
import { brief, doneTitle, groupByDue, handledLabel, money, plural, relativeDue, shieldLabel, suspiciousEmails } from "../plain";
import type { RunState } from "../useRun";

const VISIBLE_ASKS = 3;
const VISIBLE_LATER = 3;
const DONE = ["verified", "executed"];

type Sheet = { kind: "obligation"; id: string } | { kind: "action"; id: string } | { kind: "email"; id: string } | null;

function Heading({ children, innerRef }: { children: React.ReactNode; innerRef?: React.Ref<HTMLHeadingElement> }) {
  return <h2 ref={innerRef} tabIndex={-1} className="font-display text-xl font-semibold">{children}</h2>;
}

/** The home screen: a short brief. What needs me, what is coming, what is already handled. */
export default function Today({ health, actions, refreshActions, run, snoozed, setSnoozed, goToTrust }: {
  health: Health | null;
  actions: Action[] | null;
  refreshActions: () => void;
  run: RunState;
  snoozed: string[];
  setSnoozed: (ids: string[]) => void;
  goToTrust: () => void;
}) {
  const [data, setData] = useState<{ obligations: Obligation[]; emails: EmailRow[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [fresh, setFresh] = useState(false); // the last scan here found something new
  const [error, setError] = useState<string | null>(null);
  const [nudges, setNudges] = useState<Nudge[]>([]);
  const [sched, setSched] = useState<SchedulerStatus | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [showAllAsks, setShowAllAsks] = useState(false);
  const [showAllLater, setShowAllLater] = useState(false);
  const [busyUndo, setBusyUndo] = useState<string | null>(null);
  const needsRef = useRef<HTMLHeadingElement>(null);
  const now = useNow();

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
  useEffect(() => { if (run.waiting) refreshActions(); }, [run.waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data || !actions) return loadError ? <Banner tone="red">{loadError}</Banner> : <Spinner label="Getting today ready…" />;
  const { obligations, emails } = data;
  const byId = new Map(obligations.map((o) => [o.id, o]));

  // Anything waiting on the user is always shown. History is limited to the mailbox currently on screen.
  const mine = actions.filter((a) => !a.obligationId || byId.has(a.obligationId));
  const pending = actions.filter((a) => a.status === "pending_approval").reverse();
  const asks = pending.filter((a) => !snoozed.includes(a.id));
  const setAside = pending.length - asks.length;
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
  const caughtUp = scanned && !live && !readyToHandle && pending.length === 0 && held.length === 0 && problems.length === 0;

  const headline = brief({
    scanned, readyToHandle,
    needs: pending.length, handled: done.length, problems: problems.length, comingUp: obligations.length, stopped: blocked.length,
  });

  const scan = async () => {
    setScanning(true);
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
      refreshActions();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyUndo(null);
    }
  };
  const answered = () => { refreshActions(); needsRef.current?.focus(); };

  // While something waits for the user, the approval cards are the primary action, so the big button steps aside.
  const showPrimary = pending.length === 0;
  const primary = live
    ? { label: "Munshi is working…", onClick: () => undefined, disabled: true }
    : readyToHandle
      ? { label: "Let Munshi handle it", onClick: () => void handle(), disabled: !health?.agentAvailable }
      : { label: scanning ? "Scanning…" : "Scan inbox", onClick: () => void scan(), disabled: scanning || !health?.llmConfigured };

  const sheetAction = sheet?.kind === "action" ? actions.find((a) => a.id === sheet.id) : undefined;
  const sheetObligation = sheet?.kind === "obligation" ? byId.get(sheet.id) : undefined;
  const close = () => setSheet(null);

  const undoButton = (a: Action) =>
    a.canUndo ? (
      <button disabled={busyUndo === a.id} onClick={() => void undo(a)} className="btn-quiet" aria-label={`${a.undoHint}: ${doneTitle(a, emails)}`}>{a.undoHint}</button>
    ) : null;

  return (
    <div className="space-y-12">
      <section className="space-y-6" aria-label="Today's brief">
        <h1 className="font-display text-[1.75rem] font-semibold leading-tight sm:text-4xl" aria-live="polite">{headline}</h1>
        {!scanned && <p className="text-soft">Munshi reads your mail and picks out what you owe.</p>}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          {showPrimary && <button onClick={primary.onClick} disabled={primary.disabled} className="btn-primary min-h-12 px-8 text-base">{primary.label}</button>}
          {scanned && (readyToHandle || live || !showPrimary) && (
            <button onClick={() => void scan()} disabled={scanning || !health?.llmConfigured} className="btn-text">{scanning ? "Checking…" : "Check for new mail"}</button>
          )}
          {shield && (
            <button onClick={goToTrust} className="inline-flex items-center gap-2 rounded-full bg-wash px-3 py-1.5 text-sm font-semibold text-accent-deep hover:underline">
              <Icon name="shield" size={16} />{shield}
            </button>
          )}
        </div>
        {readyToHandle && (
          <details className="text-sm">
            <summary className="w-fit text-soft">Change instructions</summary>
            <textarea value={run.goal} onChange={(e) => run.setGoal(e.target.value)} rows={2} className="field reveal mt-2 w-full" aria-label="Instructions for Munshi" />
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
      </section>

      {pending.length > 0 && (
        <section className="space-y-4" aria-label="Needs you">
          <Heading innerRef={needsRef}>Needs you</Heading>
          {(showAllAsks ? asks : asks.slice(0, VISIBLE_ASKS)).map((a) => (
            <ApprovalCard
              key={a.id} a={a} obligation={a.obligationId ? byId.get(a.obligationId) : undefined} emails={emails} holdSeconds={health?.holdSeconds}
              onDone={answered} onNotNow={() => { setSnoozed([...snoozed, a.id]); needsRef.current?.focus(); }} onDetails={() => setSheet({ kind: "action", id: a.id })}
            />
          ))}
          {asks.length > VISIBLE_ASKS && (
            <button onClick={() => setShowAllAsks(!showAllAsks)} className="btn-text" aria-expanded={showAllAsks}>{showAllAsks ? "Show fewer" : `Show all ${asks.length}`}</button>
          )}
          {setAside > 0 && (
            <p className="text-sm text-soft">{setAside} set aside, still waiting. <button onClick={() => setSnoozed([])} className="btn-text">Show again</button></p>
          )}
          {asks.length > 0 && <p className="hidden text-xs text-soft sm:block">With a card selected: <kbd className="font-semibold">A</kbd> approves, <kbd className="font-semibold">R</kbd> rejects.</p>}
        </section>
      )}

      {held.length > 0 && (
        <section className="space-y-3" aria-label="Sending soon">
          <Heading>Sending soon</Heading>
          <ul className="panel divide-y divide-line">
            {held.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="break-words font-medium">{doneTitle(a, emails)}</p>
                  <p className="text-sm text-soft">Sends in {Math.max(0, Math.ceil(((a.holdUntil ?? now) - now) / 1000))}s</p>
                </div>
                <button onClick={() => setSheet({ kind: "action", id: a.id })} className="btn-text">Details</button>
                {undoButton(a)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {problems.length > 0 && (
        <section className="space-y-3" aria-label="Check these">
          <Heading>Check these</Heading>
          <ul className="panel divide-y divide-line border-danger/40">
            {problems.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="break-words font-medium">{doneTitle(a, emails)}</p>
                  <p className="text-sm text-danger">{a.status === "failed" ? "This didn't work." : "Couldn't confirm this worked."}</p>
                </div>
                <button onClick={() => setSheet({ kind: "action", id: a.id })} className="btn-text">Details</button>
                {undoButton(a)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {caughtUp && (
        <section className="flex flex-col items-center gap-3 py-2 text-center" aria-label="All caught up">
          <CaughtUpArt />
          <p className="font-display text-xl font-semibold">You're all caught up.</p>
        </section>
      )}

      {obligations.length > 0 && (
        <section className="space-y-5" aria-label="Coming up">
          <Heading>Coming up</Heading>
          {groupByDue(obligations).map((g) => {
            const items = g.id === "later" && !showAllLater ? g.items.slice(0, VISIBLE_LATER) : g.items;
            return (
              <div key={g.id} className="space-y-1">
                <h3 className={`text-sm font-semibold ${g.id === "past" ? "text-danger" : "text-soft"}`}>{g.label}</h3>
                <ul className="ml-4 border-l-2 border-line">
                  {items.map((o) => (
                    <li key={o.id}>
                      <button onClick={() => setSheet({ kind: "obligation", id: o.id })} className="reveal -ml-[19px] grid w-[calc(100%+19px)] grid-cols-[36px_1fr_auto] items-center gap-3 rounded-2xl py-2 pr-3 text-left hover:bg-white">
                        <span className="grid h-9 w-9 place-items-center rounded-full border border-line bg-white text-accent-deep"><Icon name={o.type} size={18} /></span>
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
                  <button onClick={() => setShowAllLater(!showAllLater)} className="btn-text ml-9" aria-expanded={showAllLater}>
                    {showAllLater ? "Show fewer" : `Show ${g.items.length - VISIBLE_LATER} more`}
                  </button>
                )}
              </div>
            );
          })}
        </section>
      )}

      {done.length + undone.length > 0 && (
        <section aria-label="Handled">
          <details className="panel" data-testid="handled">
            <summary className="flex items-center justify-between gap-3 p-4">
              <h2 className="font-display text-lg font-semibold">Handled</h2>
              <span className="text-right text-sm text-accent-deep">{done.length ? `${handledLabel(done)} ✓` : `${undone.length} undone`}</span>
            </summary>
            <ul className="reveal divide-y divide-line border-t border-line">
              {[...done, ...undone].map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
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
