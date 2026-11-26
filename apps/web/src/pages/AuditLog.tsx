import { useState } from "react";
import { api, api2, type Action, type AuditEntry, type EmailRow } from "../api";
import { Banner, fmtTime, Spinner, usePoll } from "../components";
import { stagger, useEntrance } from "../motion";
import { auditRefs, auditSentence } from "../plain";

const AUDIT_LIMIT = 500; // the API's maximum

/** The page itself: one plain sentence per entry, newest first, with the raw record one tap further. */
export function AuditLogView({ entries, actions, emails }: { entries: AuditEntry[]; actions: Action[]; emails: EmailRow[] }) {
  const refs = auditRefs(entries, actions);
  const newestFirst = [...entries].sort((a, b) => b.id - a.id);
  return (
    <div className="space-y-4">
      {entries.length >= AUDIT_LIMIT && <p className="text-sm text-soft">Showing the latest {AUDIT_LIMIT} entries.</p>}
      {entries.length === 0 ? (
        <p className="panel p-8 text-center text-sm text-soft">Nothing recorded yet.</p>
      ) : (
        <ol className="panel divide-y divide-line" aria-label="Audit entries">
          {newestFirst.map((e, i) => (
            <li key={e.id} className="row enter space-y-1 p-3 text-sm sm:px-5" style={stagger(i)}>
              <p className="break-words"><span className="mr-2 text-xs tabular-nums text-soft">{fmtTime(e.ts)}</span>{auditSentence(e, refs, emails)}</p>
              <details>
                <summary className="w-fit text-xs text-soft" aria-label={`Raw record ${e.id}`}>Raw</summary>
                <pre className="reveal mt-1 whitespace-pre-wrap break-all rounded-xl bg-mist p-2 text-xs">{JSON.stringify(e, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default function AuditLog({ actions }: { actions: Action[] }) {
  const [data, setData] = useState<{ entries: AuditEntry[]; emails: EmailRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const entrance = useEntrance("audit", data !== null);
  usePoll(async () => {
    try {
      const [entries, emails] = await Promise.all([api2.audit(AUDIT_LIMIT), api.emails()]);
      setData({ entries, emails });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, 3000);

  return (
    <div className="space-y-4" data-entrance={entrance}>
      <div className="panel enter space-y-2 p-4 sm:p-5" style={stagger(0)}>
        <h1 className="font-display text-3xl font-semibold">Audit log</h1>
        <p className="text-sm text-soft">Every step Munshi took. Append-only, enforced by the database.</p>
      </div>
      {error && <Banner tone="red">{error}</Banner>}
      {data ? <AuditLogView entries={data.entries} actions={actions} emails={data.emails} /> : !error && <Spinner label="Loading the audit log…" />}
    </div>
  );
}
