import { useCallback, useState } from "react";
import { api, api2, channelsApi, type Contact, type Health, type PolicyDraft, type PolicyRow, type SchedulerStatus } from "../api";
import { Banner, usePoll } from "../components";
import { initials } from "../AccountMenu";
import ModeControl from "../ModeControl";
import { stagger, useEntrance } from "../motion";
import { plural } from "../plain";
import TelegramCard from "./Channels";
import { RuleSummary } from "./Rules";

const TEMPLATE = `{
  "id": "my-rule",
  "description": "Ask me before creating events with a wedding in the title",
  "match": { "tool": "create_event", "argsCondition": { "title": { "contains": "wedding" } } },
  "decision": "require_approval",
  "reason": "I want to review wedding events myself."
}`;

function Section({ title, label, order = 1, children }: { title: string; label?: string; order?: number; children: React.ReactNode }) {
  return (
    <section className="panel enter space-y-3 p-4 sm:p-5" style={stagger(order)} aria-label={label ?? title}>
      <h2 className="font-display text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** Mailbox connection, background scan and "re-read everything". */
function Mailbox({ health, onModeChange }: { health: Health | null; onModeChange: () => void }) {
  const [sched, setSched] = useState<SchedulerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  usePoll(async () => setSched(await channelsApi.scheduler().catch(() => null)), 15000);

  const rescan = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const s = await api.scan(true);
      setMsg({ tone: s.failed ? "red" : "green", text: `Re-read ${plural(s.listed, "email")}: ${s.extracted} read, ${s.failed} failed.` });
    } catch (e) {
      setMsg({ tone: "red", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Mailbox" order={2}>
      <div className="space-y-4">
        <ModeControl onModeChange={onModeChange} />
        {sched && (
          <p className="text-sm text-soft" aria-label="Background scan status">
            {sched.enabled
              ? `Checks mail every ${sched.intervalMin} min${sched.running ? " (running now)" : sched.lastRunAt ? `, last at ${new Date(sched.lastRunAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}` : ""}. It only reads and reminds; it never acts.`
              : "Background checking is off (set SCAN_INTERVAL_MIN in .env)."}
            {sched.lastError && <span className="text-danger"> Last check failed: {sched.lastError}</span>}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => void rescan()} disabled={busy || !health?.llmConfigured} className="btn-quiet">
            {busy && <span className="spinner" aria-hidden />}{busy ? "Re-reading your mail…" : "Re-scan all"}
          </button>
          <span className="text-sm text-soft">Reads every email again.</span>
        </div>
        {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      </div>
    </Section>
  );
}

export default function Settings({ health, offline, email, onModeChange, onSignOut }: {
  health: Health | null;
  offline: boolean;
  email: string;
  onModeChange: () => void;
  onSignOut: () => Promise<void>;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const entrance = useEntrance("settings");
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [draft, setDraft] = useState(TEMPLATE);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [sentence, setSentence] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [pending, setPending] = useState<PolicyDraft | null>(null);

  const load = useCallback(async () => {
    const [p, c] = await Promise.all([api2.policies(), api2.contacts()]);
    setPolicies(p);
    setContacts(c);
  }, []);
  usePoll(load, 5000);

  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setErr(null);
    try {
      await fn();
      after?.();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const compile = async () => {
    setErr(null);
    setCompiling(true);
    try {
      setPending(await api2.compilePolicy(sentence));
    } catch (e) {
      setPending(null);
      setErr((e as Error).message);
    } finally {
      setCompiling(false);
    }
  };

  const addPolicy = () =>
    run(async () => {
      let rule: unknown;
      try {
        rule = JSON.parse(draft);
      } catch {
        throw new Error("That is not valid JSON.");
      }
      await api2.addPolicy(rule);
    });

  return (
    <div className="space-y-4" data-entrance={entrance}>
      <div className="panel enter p-4 sm:p-5" style={stagger(0)}>
        <h1 className="font-display text-2xl font-semibold sm:text-3xl">Settings</h1>
      </div>

      <section className="panel enter flex flex-wrap items-center gap-x-4 gap-y-3 p-4 sm:p-5" style={stagger(1)} aria-label="Account">
        <span aria-hidden className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-accent font-semibold text-on-accent">{initials(email)}</span>
        <div className="min-w-0 flex-1 basis-48">
          <p className="break-words">Signed in as <b className="break-all">{email}</b></p>
          <p className="text-sm text-soft">
            AI: {health?.replay ? "demo, scripted" : health?.llmModel ? `${health.llmProvider}, ${health.llmModel}` : "not configured"}. Server: {offline ? "offline" : health?.ok ? "ok" : "connecting"}.
          </p>
        </div>
        <button
          disabled={signingOut}
          onClick={() => { setSigningOut(true); void onSignOut().catch(() => setSigningOut(false)); }}
          className="btn-quiet ml-auto text-danger"
        >
          {signingOut && <span className="spinner" aria-hidden />}{signingOut ? "Signing out…" : "Sign out"}
        </button>
      </section>

      {/* Two independent columns from 768px (top-aligned, panels keep their natural height); one column below. */}
      <div className="grid items-start gap-4 md:grid-cols-2">
        <div className="min-w-0 space-y-4" data-column="left">
          <Mailbox health={health} onModeChange={onModeChange} />
          <Section title="Policies" order={3}>
            <p className="text-sm text-soft">Your rules for what Munshi may do. The strictest one wins.</p>
            {err && <Banner tone="red">{err}</Banner>}

            <div className="inset space-y-3 p-3" role="group" aria-label="Plain-language rule">
              <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void compile(); }}>
                <input value={sentence} onChange={(e) => { setSentence(e.target.value); setPending(null); }} minLength={5} maxLength={500} required
                  aria-label="Describe a rule in plain language" placeholder="Never email my professor without asking" className="field min-w-0 flex-1 basis-56" />
                <button disabled={compiling} className="btn-primary">{compiling && <span className="spinner" aria-hidden />}{compiling ? "Drafting…" : "Draft rule"}</button>
              </form>
              <p className="text-xs text-soft">An AI drafts it. Nothing is active until you confirm.</p>
              {pending && (
                <div className="reveal space-y-3 rounded-xl bg-warn-wash p-4" role="group" aria-label="Draft rule">
                  <p className="text-sm font-semibold text-warn">Draft: not active yet</p>
                  <p className="text-sm"><b>In plain English:</b> {pending.readback}</p>
                  {pending.warnings.map((w) => <p key={w} className="rounded-lg bg-panel p-2 text-xs text-warn">{w}</p>)}
                  <details className="text-xs"><summary className="w-fit text-soft">Compiled rule (JSON)</summary><pre className="mt-1 overflow-x-auto rounded-lg bg-panel p-2">{JSON.stringify(pending.rule, null, 1)}</pre></details>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => void run(() => api2.confirmPolicyDraft(pending.draftId), () => { setPending(null); setSentence(""); })} className="btn-primary">Confirm and save</button>
                    <button onClick={() => void run(() => api2.discardPolicyDraft(pending.draftId), () => setPending(null))} className="btn-quiet">Discard</button>
                  </div>
                </div>
              )}
            </div>

            <ul className="card divide-y divide-line">
              {policies.map((p) => (
                <li key={p.id} className="row flex px-4 py-3">
                  <RuleSummary
                    p={p}
                    controls={
                      <>
                        <button onClick={() => void run(() => api2.togglePolicy(p.id, !p.enabled))} className="btn-quiet px-3 text-xs md:min-h-8 md:py-1" aria-label={`${p.enabled ? "Disable" : "Enable"} rule ${p.id}`}>
                          {p.enabled ? "Disable" : "Enable"}
                        </button>
                        <button onClick={() => void run(() => api2.deletePolicy(p.id))} className="btn-danger px-3 text-xs md:min-h-8 md:py-1" aria-label={`Delete rule ${p.id}`}>Delete</button>
                      </>
                    }
                  />
                </li>
              ))}
            </ul>

            <details className="text-sm">
              <summary className="w-fit font-medium">Add a rule as JSON</summary>
              <div className="reveal mt-3 space-y-2">
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={9} spellCheck={false} aria-label="Rule JSON" className="field w-full font-mono text-xs" />
                <p className="text-xs text-soft">
                  <code>match</code>: <code>tool</code> (or "*"), <code>argsCondition</code> (literal, or contains / gte / lte / in / exists), <code>tainted</code>,{" "}
                  <code>allSensitiveAllowlisted</code>, <code>minObligationConfidence</code>. <code>decision</code>: allow, require_approval, block.
                </p>
                <button onClick={() => void addPolicy()} className="btn-quiet">Add rule</button>
              </div>
            </details>
          </Section>
        </div>
        <div className="min-w-0 space-y-4" data-column="right">
          <Section title="Contacts" order={4}>
            <p className="text-sm text-soft">Only these addresses, and yours, count as known.</p>
            <ul className="card divide-y divide-line">
              {contacts.length === 0 && <li className="p-4 text-sm text-soft">No contacts yet.</li>}
              {contacts.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 p-4 text-sm">
                  <span className="min-w-0 break-words"><b>{c.name}</b> <span className="text-soft">&lt;{c.email}&gt;</span></span>
                  <button onClick={() => void run(() => api2.deleteContact(c.id))} className="text-danger underline" aria-label={`Remove ${c.name}`}>Remove</button>
                </li>
              ))}
            </ul>
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => api2.addContact(name, address), () => { setName(""); setAddress(""); });
              }}
            >
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Contact name" required className="field min-w-0 flex-1 basis-32" />
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="email@example.com" aria-label="Contact email" required type="email" className="field min-w-0 flex-1 basis-48" />
              <button className="btn-quiet">Add contact</button>
            </form>
          </Section>
          <Section title="Notifications" order={5}>
            <TelegramCard />
          </Section>
        </div>
      </div>
    </div>
  );
}
