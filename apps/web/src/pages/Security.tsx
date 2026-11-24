import { useState } from "react";
import { api2, type AuditEntry, type SecurityAction, type SecurityEmail } from "../api";
import { Chip, DecisionChip, fmtTime, StatusBadge, usePoll, useNow, Warnings } from "../components";

export default function Security({ onOpenEmail }: { onOpenEmail: (id: string) => void }) {
  const [actions, setActions] = useState<SecurityAction[]>([]);
  const [emails, setEmails] = useState<SecurityEmail[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const now = useNow();
  usePoll(async () => {
    const s = await api2.security();
    setActions(s.actions);
    setEmails(s.emails);
    setAudit(await api2.audit(60));
  }, 3000);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Security</h1>
        <p className="text-sm text-stone-600">
          Every action the Guard blocked or marked tainted, with the exact rule that fired and the email that introduced the value. These decisions are made by
          deterministic code, never by an AI model.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Blocked and tainted actions ({actions.length})</h2>
        {actions.length === 0 && <p className="rounded-xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500">Nothing blocked or tainted yet.</p>}
        {actions.map((a) => (
          <article key={a.id} className="space-y-2 rounded-xl border border-red-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <DecisionChip a={a} />
              <StatusBadge a={a} now={now} />
              <Chip tone="stone">{a.tool} · {a.tier}</Chip>
              <span className="text-xs text-stone-400">{fmtTime(a.createdAt)}</span>
            </div>
            <p className="text-sm font-medium">{a.preview}</p>
            <p className="text-sm">
              <span className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-xs">{a.rule}</span> <span className="text-stone-700">{a.reason}</span>
            </p>
            <Warnings a={a} />
            {a.sources.length > 0 && (
              <ul className="text-xs text-stone-600">
                {a.sources.map((s, i) => (
                  <li key={i}>
                    <b>{s.value}</b> came from{" "}
                    {s.emailId ? <button className="font-medium text-sky-700 hover:underline" onClick={() => onOpenEmail(s.emailId!)}>“{s.subject}” from {s.sender} ↗</button> : "an unknown source"}
                    {s.hidden && <> <Chip tone="amber">hidden text</Chip></>}
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Suspicious emails ({emails.length})</h2>
        <ul className="space-y-2">
          {emails.map((e) => (
            <li key={e.id} className="rounded-lg border border-amber-200 bg-white p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => onOpenEmail(e.id)} className="font-medium hover:underline">{e.subject}</button>
                <span className="text-xs text-stone-500">{e.from}</span>
                {e.flags.hiddenContent.some((h) => h.suspicious !== false) && <Chip tone="amber">hidden content removed</Chip>}
                {e.flags.injectionSuspected.length > 0 && <Chip tone="red">prompt injection suspected</Chip>}
                {e.flags.rejectedObligations.length > 0 && <Chip tone="red">extractor output rejected</Chip>}
              </div>
              {e.flags.injectionSuspected[0] && <p className="mt-1 text-xs italic text-stone-600">“{e.flags.injectionSuspected[0].text}”</p>}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Audit log (append-only, enforced by the database)</h2>
        <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
          <table className="w-full text-left text-xs">
            <thead className="bg-stone-50 text-stone-500"><tr><th className="p-2">#</th><th className="p-2">Time</th><th className="p-2">Event</th><th className="p-2">Actor</th><th className="p-2">Detail</th></tr></thead>
            <tbody>
              {audit.map((e) => (
                <tr key={e.id} className="border-t border-stone-100 align-top">
                  <td className="p-2 text-stone-400">{e.id}</td>
                  <td className="whitespace-nowrap p-2">{fmtTime(e.ts)}</td>
                  <td className="p-2 font-medium">{e.event}</td>
                  <td className="p-2">{e.actor}</td>
                  <td className="max-w-md truncate p-2 font-mono text-stone-500" title={JSON.stringify(e.detail)}>{JSON.stringify(e.detail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
