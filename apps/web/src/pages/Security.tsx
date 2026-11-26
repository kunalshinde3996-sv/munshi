import { useState } from "react";
import { api, api2, type AuditEntry, type EmailRow, type SecurityAction, type SecurityEmail } from "../api";
import { Chip, DecisionChip, fmtTime, StatusBadge, usePoll, useNow, Warnings } from "../components";

export default function Security({ onOpenEmail }: { onOpenEmail: (id: string) => void }) {
  const [actions, setActions] = useState<SecurityAction[]>([]);
  const [emails, setEmails] = useState<SecurityEmail[]>([]);
  const [mail, setMail] = useState<EmailRow[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const now = useNow();
  usePoll(async () => {
    const s = await api2.security();
    setActions(s.actions);
    setEmails(s.emails);
    setMail(await api.emails());
    setAudit(await api2.audit(60));
  }, 3000);
  const quiet = mail.filter((e) => e.status === "done" && e.obligationCount === 0 && !emails.some((s) => s.id === e.id));

  return (
    <div className="space-y-8">
      <p className="text-sm text-soft">What was blocked or flagged, and why. Fixed code decides this, never an AI model.</p>

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold">Suspicious emails ({emails.length})</h2>
        {emails.length === 0 && <p className="panel p-6 text-center text-sm text-soft">No suspicious emails found.</p>}
        <ul className="space-y-2">
          {emails.map((e) => (
            <li key={e.id} className="panel p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => onOpenEmail(e.id)} className="break-words text-left font-semibold hover:underline">{e.subject}</button>
                <span className="break-all text-xs text-soft">{e.from}</span>
                {e.flags.hiddenContent.some((h) => h.suspicious !== false) && <Chip tone="amber">hidden content removed</Chip>}
                {e.flags.injectionSuspected.length > 0 && <Chip tone="red">prompt injection suspected</Chip>}
                {e.flags.rejectedObligations.length > 0 && <Chip tone="red">extractor output rejected</Chip>}
                {mail.find((m) => m.id === e.id)?.obligationCount === 0 && <Chip tone="stone">nothing taken from it</Chip>}
              </div>
              {e.flags.injectionSuspected[0] && <p className="mt-1 break-words text-xs italic text-soft">“{e.flags.injectionSuspected[0].text}”</p>}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold">Blocked and tainted actions ({actions.length})</h2>
        {actions.length === 0 && <p className="panel p-6 text-center text-sm text-soft">Nothing blocked or tainted yet.</p>}
        {actions.map((a) => (
          <article key={a.id} className="panel space-y-2 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <DecisionChip a={a} />
              <StatusBadge a={a} now={now} />
              <Chip tone="stone">{a.tool} · {a.tier}</Chip>
              <span className="text-xs text-soft">{fmtTime(a.createdAt)}</span>
            </div>
            <p className="break-words text-sm font-medium">{a.preview}</p>
            <p className="break-words text-sm">
              <code className="rounded bg-mist px-1.5 py-0.5 text-xs">{a.rule}</code> <span>{a.reason}</span>
            </p>
            <Warnings a={a} />
            {a.sources.length > 0 && (
              <ul className="break-words text-xs text-soft">
                {a.sources.map((s, i) => (
                  <li key={i}>
                    <b>{s.value}</b> came from{" "}
                    {s.emailId ? <button className="text-left font-medium text-accent underline" onClick={() => onOpenEmail(s.emailId!)}>“{s.subject}” from {s.sender}</button> : "an unknown source"}
                    {s.hidden && <> <Chip tone="amber">hidden text</Chip></>}
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
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

      <section className="space-y-2">
        <h2 className="font-display text-lg font-semibold">Audit log</h2>
        <p className="text-sm text-soft">Append-only, enforced by the database.</p>
        <div className="panel overflow-x-auto" tabIndex={0} role="region" aria-label="Audit log table">
          <table className="w-full text-left text-xs">
            <thead className="bg-mist text-soft"><tr><th className="p-2">#</th><th className="p-2">Time</th><th className="p-2">Event</th><th className="p-2">Actor</th><th className="p-2">Detail</th></tr></thead>
            <tbody>
              {audit.map((e) => (
                <tr key={e.id} className="border-t border-line align-top">
                  <td className="p-2 text-soft">{e.id}</td>
                  <td className="whitespace-nowrap p-2">{fmtTime(e.ts)}</td>
                  <td className="p-2 font-medium">{e.event}</td>
                  <td className="p-2">{e.actor}</td>
                  <td className="max-w-xs truncate p-2 font-mono text-soft" title={JSON.stringify(e.detail)}>{JSON.stringify(e.detail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
