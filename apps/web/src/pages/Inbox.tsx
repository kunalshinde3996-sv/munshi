import { useCallback, useEffect, useState } from "react";
import RunPanel from "./RunPanel";
import { api, type EmailDetail, type EmailRow, type Health, type Obligation, type ScanSummary } from "../api";

const TYPE_STYLE: Record<string, string> = {
  bill: "bg-rose-100 text-rose-800",
  deadline: "bg-orange-100 text-orange-800",
  renewal: "bg-violet-100 text-violet-800",
  refund: "bg-emerald-100 text-emerald-800",
  appointment: "bg-sky-100 text-sky-800",
  travel: "bg-indigo-100 text-indigo-800",
  other: "bg-stone-200 text-stone-700",
};

function formatDue(due: string | null): string {
  if (!due) return "No date";
  const d = new Date(due.length === 10 ? `${due}T00:00:00+05:30` : due);
  const date = d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  if (due.length === 10) return date;
  return `${date}, ${d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}`;
}

function daysUntil(due: string | null): string | null {
  if (!due) return null;
  const ms = new Date(due.length === 10 ? `${due}T23:59:59+05:30` : due).getTime() - Date.now();
  const days = Math.ceil(ms / 86_400_000);
  if (days < 0) return `${-days}d overdue`;
  return days === 0 ? "today" : `in ${days}d`;
}

const money = (o: Obligation) =>
  o.amount == null ? null : `${o.currency === "INR" || !o.currency ? "₹" : `${o.currency} `}${o.amount.toLocaleString("en-IN")}`;

function Chip({ children, tone }: { children: React.ReactNode; tone: "red" | "amber" | "green" | "stone" }) {
  const t = { red: "bg-red-100 text-red-800", amber: "bg-amber-100 text-amber-900", green: "bg-emerald-100 text-emerald-800", stone: "bg-stone-100 text-stone-600" }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t}`}>{children}</span>;
}

function ObligationCard({ o, onOpen }: { o: Obligation; onOpen: (id: string) => void }) {
  const due = daysUntil(o.dueDate);
  return (
    <article className="flex flex-col gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <span className={`rounded-md px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${TYPE_STYLE[o.type]}`}>{o.type}</span>
        <div className="text-right text-xs text-stone-500" title="Extractor confidence">
          <div className="mb-1">{Math.round(o.confidence * 100)}% confident</div>
          <div className="h-1.5 w-20 rounded-full bg-stone-200">
            <div className={`h-1.5 rounded-full ${o.confidence >= 0.8 ? "bg-emerald-500" : "bg-amber-500"}`} style={{ width: `${o.confidence * 100}%` }} />
          </div>
        </div>
      </div>
      <h3 className="text-base font-semibold leading-snug">{o.title}</h3>
      <dl className="grid grid-cols-2 gap-y-1 text-sm">
        <dt className="text-stone-500">Due</dt>
        <dd className="text-right font-medium">
          {formatDue(o.dueDate)} {due && <span className="text-xs font-normal text-stone-500">({due})</span>}
        </dd>
        {money(o) && (<><dt className="text-stone-500">Amount</dt><dd className="text-right font-medium">{money(o)}</dd></>)}
        {o.counterparty && (<><dt className="text-stone-500">With</dt><dd className="text-right">{o.counterparty}</dd></>)}
      </dl>
      <blockquote className="border-l-2 border-saffron/60 pl-3 text-xs italic text-stone-600">“{o.evidenceQuote}”</blockquote>
      <button onClick={() => onOpen(o.emailId)} className="mt-auto text-left text-xs font-medium text-sky-700 hover:underline">
        Source: {o.emailSubject} ↗
      </button>
    </article>
  );
}

export function EmailDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<EmailDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.email(id).then(setD).catch((e: Error) => setErr(e.message));
  }, [id]);
  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/30" onClick={onClose}>
      <aside className="h-full w-full max-w-xl overflow-y-auto bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">SANDBOX DATA</span>
          <button onClick={onClose} className="text-sm text-stone-500 hover:text-ink">Close ✕</button>
        </div>
        {err && <p className="text-red-600">{err}</p>}
        {!d && !err && <p className="text-stone-500">Loading…</p>}
        {d && (
          <>
            <h2 className="text-lg font-semibold">{d.email.subject}</h2>
            <p className="text-sm text-stone-600">From {d.email.from.name} &lt;{d.email.from.address}&gt;</p>
            <p className="mb-3 text-xs text-stone-500">{new Date(d.email.date).toLocaleString("en-IN")}</p>
            <FlagList flags={d.flags} />
            {d.status === "extraction_failed" && <p className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">Extraction failed: {d.error}</p>}
            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-stone-500">Original email (untrusted)</h3>
            <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-xs">{d.email.body}</pre>
            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-stone-500">What the extractor was shown (hidden content removed)</h3>
            <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-emerald-50 p-3 text-xs">{d.extractorInput}</pre>
          </>
        )}
      </aside>
    </div>
  );
}

function FlagList({ flags }: { flags: EmailDetail["flags"] }) {
  if (!flags) return null;
  const items: React.ReactNode[] = [];
  flags.hiddenContent.forEach((h, i) =>
    items.push(<li key={`h${i}`}><b>Hidden content detected</b> ({h.kind.replace(/_/g, " ")}) and removed before extraction: <i>“{h.text}”</i></li>));
  flags.injectionSuspected.forEach((x, i) =>
    items.push(<li key={`i${i}`}><b>Possible prompt injection</b> ({x.pattern.replace(/_/g, " ")}, {x.where} text): <i>“{x.text}”</i></li>));
  flags.rejectedObligations.forEach((r, i) =>
    items.push(<li key={`r${i}`}><b>Extractor output rejected</b>: {r.reason}</li>));
  if (!items.length) return null;
  return <ul className="mb-3 list-disc space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 pl-7 text-xs text-amber-950">{items}</ul>;
}

export default function Inbox({ health, onActionsChange, goToApprovals }: { health: Health | null; onActionsChange: () => void; goToApprovals: () => void }) {
  const [obligations, setObligations] = useState<Obligation[]>([]);
  const [emails, setEmails] = useState<EmailRow[]>([]);
  const [scanning, setScanning] = useState(false);
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [o, e] = await Promise.all([api.obligations(), api.emails()]);
    setObligations(o);
    setEmails(e);
  }, []);

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);

  const scan = async (force: boolean) => {
    setScanning(true);
    setError(null);
    try {
      setSummary(await api.scan(force));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const failed = emails.filter((e) => e.status === "extraction_failed");
  const flagged = emails.filter((e) => e.flags && (e.flags.hiddenContent.length || e.flags.injectionSuspected.length || e.flags.rejectedObligations.length));
  const quiet = emails.filter((e) => e.status === "done" && e.obligationCount === 0 && !flagged.includes(e));
  const llmReady = health?.llmConfigured ?? false;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Your inbox, as obligations</h1>
          <p className="text-sm text-stone-600">Munshi reads each email in quarantine and extracts only what you owe, or what is scheduled.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void scan(false)}
            disabled={scanning || !llmReady}
            className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {scanning ? "Scanning…" : "Scan inbox"}
          </button>
          <button
            onClick={() => void scan(true)}
            disabled={scanning || !llmReady}
            className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
            title="Re-extract every email, including ones already done"
          >
            Re-scan all
          </button>
        </div>
      </div>

      {health && !llmReady && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Scanning is disabled: {health.llmError}. Set it in <code>.env</code> and restart the server.
        </p>
      )}
      {error && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      {summary && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          Scanned {summary.listed} emails: {summary.extracted} extracted, {summary.skipped} already done, {summary.failed} failed →{" "}
          {summary.obligations} new obligations. {summary.hiddenContentEmails > 0 && `${summary.hiddenContentEmails} had hidden content. `}
          {summary.injectionEmails > 0 && `${summary.injectionEmails} look like prompt-injection attempts.`}
        </p>
      )}

      <RunPanel health={health} obligationCount={obligations.length} onChange={onActionsChange} goToApprovals={goToApprovals} />

      {failed.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-red-700">Extraction failed ({failed.length})</h2>
          <ul className="space-y-2">
            {failed.map((e) => (
              <li key={e.id} className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
                <button onClick={() => setOpen(e.id)} className="font-medium text-red-900 hover:underline">{e.subject}</button>
                <p className="text-xs text-red-800">{e.error}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-stone-500">Obligations ({obligations.length})</h2>
        {obligations.length === 0 ? (
          <p className="rounded-xl border border-dashed border-stone-300 p-8 text-center text-sm text-stone-500">
            {emails.length === 0 ? "No scan yet. Press “Scan inbox” to extract obligations." : "No obligations found."}
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {obligations.map((o) => <ObligationCard key={o.id} o={o} onOpen={setOpen} />)}
          </div>
        )}
      </section>

      {flagged.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-amber-700">Security notes ({flagged.length})</h2>
          <ul className="space-y-2">
            {flagged.map((e) => (
              <li key={e.id} className="rounded-lg border border-amber-200 bg-white p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => setOpen(e.id)} className="font-medium hover:underline">{e.subject}</button>
                  <span className="text-xs text-stone-500">{e.from}</span>
                  {e.flags!.hiddenContent.length > 0 && <Chip tone="amber">hidden content removed</Chip>}
                  {e.flags!.injectionSuspected.length > 0 && <Chip tone="red">prompt injection suspected</Chip>}
                  {e.flags!.rejectedObligations.length > 0 && <Chip tone="red">{e.flags!.rejectedObligations.length} output rejected</Chip>}
                  {e.obligationCount === 0 && <Chip tone="stone">no obligations taken</Chip>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {quiet.length > 0 && (
        <details className="text-sm text-stone-600">
          <summary className="cursor-pointer font-medium">{quiet.length} emails with no obligations (newsletters, OTPs, promos)</summary>
          <ul className="mt-2 space-y-1 pl-4">
            {quiet.map((e) => (
              <li key={e.id}><button onClick={() => setOpen(e.id)} className="hover:underline">{e.subject}</button> <span className="text-xs text-stone-400">— {e.from}</span></li>
            ))}
          </ul>
        </details>
      )}

      {open && <EmailDrawer id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
