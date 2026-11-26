// The "one tap away" layer: source email, obligation evidence, and the full Guard record of an action.
import { useEffect, useState } from "react";
import { api, type Action, type EmailDetail, type Obligation } from "./api";
import { Banner, DecisionChip, Drawer, Spinner, StatusBadge, useNow, Warnings } from "./components";
import { fullDue, money, relativeDue } from "./plain";

type Mode = "sandbox" | "google" | undefined;

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
  return <ul className="list-disc space-y-1 break-words rounded-xl bg-warn-wash p-3 pl-7 text-sm text-warn">{items}</ul>;
}

function EmailBody({ d }: { d: EmailDetail }) {
  return (
    <>
      <p className="break-words text-sm text-soft">From {d.email.from.name} &lt;{d.email.from.address}&gt;, {new Date(d.email.date).toLocaleString("en-IN")}</p>
      <FlagList flags={d.flags} />
      {d.status === "extraction_failed" && <Banner tone="red">Extraction failed: {d.error}</Banner>}
      <h3 className="text-sm font-semibold">Original email (untrusted)</h3>
      <pre className="whitespace-pre-wrap break-words rounded-xl bg-mist p-3 text-xs">{d.email.body}</pre>
      <h3 className="text-sm font-semibold">What Munshi's extractor was shown (hidden content removed)</h3>
      <pre className="whitespace-pre-wrap break-words rounded-xl bg-wash p-3 text-xs">{d.extractorInput}</pre>
    </>
  );
}

export function EmailDrawer({ id, mode, onClose, onBack }: { id: string; mode: Mode; onClose: () => void; onBack?: () => void }) {
  const [d, setD] = useState<EmailDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.email(id).then(setD).catch((e: Error) => setErr(e.message));
  }, [id]);
  return (
    <Drawer title={d?.email.subject ?? "Email"} mode={mode} onClose={onClose}>
      {onBack && <button onClick={onBack} className="btn-text">Back</button>}
      {err && <Banner tone="red">{err}</Banner>}
      {!d && !err && <Spinner label="Loading email…" />}
      {d && <EmailBody d={d} />}
    </Drawer>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2">
      <dt className="text-soft">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium">{children}</dd>
    </div>
  );
}

export function ObligationDrawer({ o, related, mode, onClose }: { o: Obligation; related: Action[]; mode: Mode; onClose: () => void }) {
  const [showEmail, setShowEmail] = useState(false);
  const now = useNow();
  if (showEmail) return <EmailDrawer key="email" id={o.emailId} mode={mode} onClose={onClose} onBack={() => setShowEmail(false)} />;
  const amount = money(o.amount, o.currency);
  return (
    <Drawer key="obligation" title={o.title} mode={mode} onClose={onClose}>
      <dl className="divide-y divide-line text-sm">
        <Row label="Type"><span className="capitalize">{o.type}</span></Row>
        <Row label="Due">{fullDue(o.dueDate)} ({relativeDue(o.dueDate)})</Row>
        {amount && <Row label="Amount">{amount}</Row>}
        {o.counterparty && <Row label="With">{o.counterparty}</Row>}
        <Row label="Extractor confidence">{Math.round(o.confidence * 100)}%</Row>
      </dl>
      <h3 className="text-sm font-semibold">The line this came from</h3>
      <blockquote className="break-words rounded-xl bg-wash p-4 text-sm">“{o.evidenceQuote}”</blockquote>
      <p className="break-words text-sm text-soft">{o.emailSubject}, from {o.emailFrom}</p>
      <button onClick={() => setShowEmail(true)} className="btn-quiet">Open source email</button>
      {related.length > 0 && (
        <>
          <h3 className="text-sm font-semibold">What Munshi did about it</h3>
          <ul className="space-y-2 text-sm">
            {related.map((a) => (
              <li key={a.id} className="space-y-1">
                <StatusBadge a={a} now={now} />
                <p className="break-words">{a.preview}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </Drawer>
  );
}

/** Full Guard record for one action: why it was gated, where each value came from, rule id and exact arguments. */
export function ActionDrawer({ a, mode, onClose }: { a: Action; mode: Mode; onClose: () => void }) {
  const now = useNow();
  return (
    <Drawer title={a.tainted ? "Why check this?" : "Details"} mode={mode} onClose={onClose}>
      <p className="break-words font-medium">{a.preview}</p>
      <Warnings a={a} />
      {a.taint.length > 0 && (
        <>
          <h3 className="text-sm font-semibold">Where each address came from</h3>
          <ul className="space-y-2 text-sm">
            {a.taint.map((t, i) => (
              <li key={i} className="break-words">
                <b>{t.value}</b> ({t.arg}): {t.trusted ? <span className="text-accent-deep">trusted</span> : <span className="text-danger">untrusted</span>}
                {t.allowlisted && ", in your contacts or your own address"}. {t.explanation}
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 className="text-sm font-semibold">What the Guard decided</h3>
      <div className="flex flex-wrap items-center gap-2"><DecisionChip a={a} /><StatusBadge a={a} now={now} /></div>
      <p className="break-words text-sm">{a.reason}</p>
      {a.verify && <p className="break-words text-sm text-soft">Read-back: {a.verify.detail}</p>}
      <dl className="divide-y divide-line text-sm">
        {a.rule && <Row label="Rule"><code>{a.rule}</code></Row>}
        <Row label="Tool"><code>{a.tool}</code></Row>
        <Row label="Risk tier">{a.tier}</Row>
      </dl>
      <h3 className="text-sm font-semibold">Exact arguments</h3>
      <pre className="whitespace-pre-wrap break-words rounded-xl bg-mist p-3 text-xs">{JSON.stringify(a.args, null, 2)}</pre>
    </Drawer>
  );
}
