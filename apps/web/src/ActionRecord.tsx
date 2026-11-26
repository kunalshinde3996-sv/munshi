// One shape for an action in Trust: title, at most one short flag, final status. Everything else is in the record.
import type { Action, EmailRow } from "./api";
import { Chip } from "./components";
import { finalStatus, reasonWithoutProvenance, shortFlag, shortTitle } from "./plain";

export function FinalStatus({ a, now }: { a: Action; now: number }) {
  const s = finalStatus(a, now);
  return <Chip tone={s.tone}>{s.text}</Chip>;
}

const DECISION = { allow: "allow", require_approval: "needs approval", block: "block", skipped: "skip (duplicate)" } as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-soft">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium">{children}</dd>
    </div>
  );
}

/** The full Guard record. The provenance explanation appears here exactly once. */
export function ActionRecord({ a, onOpenEmail }: { a: Action; onOpenEmail: (id: string) => void }) {
  const reason = reasonWithoutProvenance(a);
  const sources = new Map<string, { subject?: string | null; hidden?: boolean }>();
  for (const t of a.taint) if (!t.trusted) for (const o of t.origins ?? []) if (o.emailId) sources.set(o.emailId, o);
  return (
    <div className="space-y-3 text-sm">
      <p className="break-words">{a.preview}</p>
      {a.taint.length > 0 && (
        <>
          <h3 className="font-semibold">Where each address came from</h3>
          <ul className="space-y-1">
            {a.taint.map((t, i) => (
              <li key={i} className="break-words">
                {t.explanation}{" "}
                <span className={t.trusted ? "text-accent-deep" : "text-danger"}>
                  ({t.arg}, {t.trusted ? "trusted" : "untrusted"}{t.allowlisted ? ", in your contacts or your own address" : ""})
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {[...sources].map(([emailId, o]) => (
        <p key={emailId}>
          <button onClick={() => onOpenEmail(emailId)} className="btn-text break-words text-left">
            Open source email{sources.size > 1 && o.subject ? `: ${o.subject}` : ""}
          </button>
          {o.hidden && <> <Chip tone="amber">hidden text</Chip></>}
        </p>
      ))}
      <dl className="divide-y divide-line">
        {/* Skipped when nothing is left beyond the decision shown on the next row. */}
        {reason && reason.toLowerCase() !== DECISION[a.decision] && <Row label="Guard's reason">{reason}</Row>}
        <Row label="First decision">{DECISION[a.decision]}</Row>
        {a.rule && <Row label="Rule"><code>{a.rule}</code></Row>}
        <Row label="Tool"><code>{a.tool}</code></Row>
        <Row label="Risk tier">{a.tier}</Row>
        {a.verify && <Row label="Read-back">{a.verify.detail}</Row>}
      </dl>
      <h3 className="font-semibold">Exact arguments</h3>
      <pre className="whitespace-pre-wrap break-words rounded-xl bg-mist p-3 text-xs">{JSON.stringify(a.args, null, 2)}</pre>
    </div>
  );
}

export function ActionCard({ a, now, emails, time, onOpenEmail, children }: {
  a: Action;
  now: number;
  emails?: EmailRow[];
  time?: string;
  onOpenEmail: (id: string) => void;
  /** Extra controls, e.g. Undo. */
  children?: React.ReactNode;
}) {
  const title = shortTitle(a, emails);
  const flag = shortFlag(a);
  return (
    <article className="card lift min-w-0 space-y-2 p-4">
      <h3 className="truncate font-medium" title={title}>{title}</h3>
      {flag && <p className="text-sm text-warn"><span aria-hidden>⚠ </span>{flag}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <FinalStatus a={a} now={now} />
        {time && <span className="text-xs text-soft">{time}</span>}
        {children && <span className="ml-auto flex items-center gap-3">{children}</span>}
      </div>
      <details>
        <summary className="w-fit text-sm text-soft" aria-label={`Details: ${title}`}>Details</summary>
        <div className="reveal mt-3 border-t border-line pt-3"><ActionRecord a={a} onOpenEmail={onOpenEmail} /></div>
      </details>
    </article>
  );
}
