import { useState } from "react";
import { api, api2, type Action, type AuditEntry, type EmailRow, type SecurityAction, type SecurityEmail } from "../api";
import { ActionCard } from "../ActionRecord";
import { Chip, fmtTime, usePoll, useNow } from "../components";
import { auditRefs, auditSentence, plural } from "../plain";

const AUDIT_LIMIT = 500; // the API's maximum

export function SuspiciousEmail({ e, nothingTaken, onOpen }: { e: SecurityEmail; nothingTaken: boolean; onOpen: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const injected = e.flags.injectionSuspected.map((x) => x.text);
  const quotes = injected.length ? injected : e.flags.hiddenContent.filter((h) => h.suspicious !== false).map((h) => h.text);
  return (
    <li className="panel space-y-2 p-4 text-sm">
      <div>
        <button onClick={onOpen} className="break-words text-left font-semibold hover:underline">{e.subject}</button>
        <p className="break-all text-xs text-soft">{e.from}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {e.flags.hiddenContent.some((h) => h.suspicious !== false) && <Chip tone="amber">hidden content removed</Chip>}
        {e.flags.injectionSuspected.length > 0 && <Chip tone="red">prompt injection suspected</Chip>}
        {e.flags.rejectedObligations.length > 0 && <Chip tone="red">extractor output rejected</Chip>}
        {nothingTaken && <Chip tone="stone">nothing taken from it</Chip>}
      </div>
      {quotes.length > 0 && (
        <div className="space-y-1">
          {(expanded ? quotes : quotes.slice(0, 1)).map((q, i) => (
            <p key={i} className={`text-xs italic text-soft ${expanded ? "reveal break-words" : "truncate"}`}>“{q}”</p>
          ))}
          <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="btn-text text-xs">
            {expanded ? "Show less" : "Show what it tried"}
          </button>
        </div>
      )}
    </li>
  );
}

/** Collapsed until asked for. One plain sentence per entry, with the raw record one tap further. */
export function AuditLog({ entries, actions, emails }: { entries: AuditEntry[]; actions: Action[]; emails: EmailRow[] }) {
  const [open, setOpen] = useState(false);
  const refs = auditRefs(entries, actions);
  const count = entries.length >= AUDIT_LIMIT ? `latest ${AUDIT_LIMIT} entries` : plural(entries.length, "entry", "entries");
  return (
    <section className="space-y-2" aria-label="Audit log">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="panel flex w-full flex-wrap items-center justify-between gap-2 p-4 text-left">
        <span className="font-display text-lg font-semibold">Audit log · {count}</span>
        <span className="text-sm font-semibold text-accent">{open ? "Hide" : "Show"}</span>
      </button>
      <p className="text-sm text-soft">Append-only, enforced by the database.</p>
      {open && (
        <ol className="panel reveal divide-y divide-line">
          {entries.map((e) => (
            <li key={e.id} className="space-y-1 p-3 text-sm">
              <p className="break-words"><span className="mr-2 text-xs tabular-nums text-soft">{fmtTime(e.ts)}</span>{auditSentence(e, refs, emails)}</p>
              <details>
                <summary className="w-fit text-xs text-soft" aria-label={`Raw record ${e.id}`}>Raw</summary>
                <pre className="reveal mt-1 whitespace-pre-wrap break-all rounded-xl bg-mist p-2 text-xs">{JSON.stringify(e, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function Security({ actions: allActions, onOpenEmail }: { actions: Action[]; onOpenEmail: (id: string) => void }) {
  const [flagged, setFlagged] = useState<SecurityAction[]>([]);
  const [emails, setEmails] = useState<SecurityEmail[]>([]);
  const [mail, setMail] = useState<EmailRow[]>([]);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const now = useNow();
  usePoll(async () => {
    const s = await api2.security();
    setFlagged(s.actions);
    setEmails(s.emails);
    setMail(await api.emails());
    setAudit(await api2.audit(AUDIT_LIMIT));
  }, 3000);
  const quiet = mail.filter((e) => e.status === "done" && e.obligationCount === 0 && !emails.some((s) => s.id === e.id));

  return (
    <div className="space-y-8">
      <p className="text-sm text-soft">What was blocked or flagged. Fixed code decides, never an AI model.</p>

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold">Suspicious emails ({emails.length})</h2>
        {emails.length === 0 && <p className="panel p-6 text-center text-sm text-soft">No suspicious emails found.</p>}
        <ul className="space-y-2">
          {emails.map((e) => (
            <SuspiciousEmail key={e.id} e={e} nothingTaken={mail.find((m) => m.id === e.id)?.obligationCount === 0} onOpen={() => onOpenEmail(e.id)} />
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold">Blocked and tainted actions ({flagged.length})</h2>
        {flagged.length === 0 && <p className="panel p-6 text-center text-sm text-soft">Nothing blocked or tainted yet.</p>}
        {flagged.map((a) => <ActionCard key={a.id} a={a} now={now} emails={mail} time={fmtTime(a.createdAt)} onOpenEmail={onOpenEmail} />)}
      </section>

      {quiet.length > 0 && (
        <details className="text-sm">
          <summary className="w-fit font-medium">{quiet.length} other emails had nothing to do</summary>
          <ul className="reveal mt-2 space-y-1 pl-4">
            {quiet.map((e) => (
              <li key={e.id} className="break-words"><button onClick={() => onOpenEmail(e.id)} className="text-left hover:underline">{e.subject}</button> <span className="text-xs text-soft">from {e.from}</span></li>
            ))}
          </ul>
        </details>
      )}

      {audit && <AuditLog entries={audit} actions={allActions} emails={mail} />}
    </div>
  );
}
