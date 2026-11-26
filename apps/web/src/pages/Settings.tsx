import { useCallback, useState } from "react";
import { api, api2, channelsApi, type Contact, type Health, type PolicyDraft, type PolicyRow, type SchedulerStatus } from "../api";
import { Banner, usePoll } from "../components";
import ModeControl from "../ModeControl";
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

function Section({ title, label, children }: { title: string; label?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3" aria-label={label ?? title}>
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
    <Section title="Mailbox">
      <div className="panel space-y-4 p-4">
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
          <button onClick={() => void rescan()} disabled={busy || !health?.llmConfigured} className="btn-quiet">{busy ? "Re-reading…" : "Re-scan all"}</button>
          <span className="text-sm text-soft">Reads every email again.</span>
        </div>
        {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      </div>
    </Section>
  );
}

export default function Settings({ health, offline, email, onModeChange, onLogout }: {
  health: Health | null;
  offline: boolean;
  email: string;
  onModeChange: () => void;
  onLogout: () => void;
}) {
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
    <div className="space-y-10">
      <h1 className="font-display text-3xl font-semibold">Settings</h1>
      <Mailbox health={health} onModeChange={onModeChange} />

      <Section title="Policies">
        <p className="text-sm text-soft">Your rules for what Munshi may do. The strictest one wins.</p>
        {err && <Banner tone="red">{err}</Banner>}

        <div className="panel space-y-3 p-4" role="group" aria-label="Plain-language rule">
          <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void compile(); }}>
            <input value={sentence} onChange={(e) => { setSentence(e.target.value); setPending(null); }} minLength={5} maxLength={500} required
              aria-label="Describe a rule in plain language" placeholder="Never email my professor without asking" className="field min-w-0 flex-1 basis-56" />
            <button disabled={compiling} className="btn-primary">{compiling ? "Drafting…" : "Draft rule"}</button>
          </form>
          <p className="text-xs text-soft">An AI drafts it. Nothing is active until you confirm.</p>
          {pending && (
            <div className="reveal space-y-3 rounded-xl bg-warn-wash p-4" role="group" aria-label="Draft rule">
              <p className="text-sm font-semibold text-warn">Draft: not active yet</p>
              <p className="text-sm"><b>In plain English:</b> {pending.readback}</p>
              {pending.warnings.map((w) => <p key={w} className="rounded-lg bg-white/70 p-2 text-xs text-warn">{w}</p>)}
              <details className="text-xs"><summary className="w-fit text-soft">Compiled rule (JSON)</summary><pre className="mt-1 overflow-x-auto rounded-lg bg-white p-2">{JSON.stringify(pending.rule, null, 1)}</pre></details>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => void run(() => api2.confirmPolicyDraft(pending.draftId), () => { setPending(null); setSentence(""); })} className="btn-primary">Confirm and save</button>
                <button onClick={() => void run(() => api2.discardPolicyDraft(pending.draftId), () => setPending(null))} className="btn-quiet">Discard</button>
              </div>
            </div>
          )}
        </div>

        <ul className="panel divide-y divide-line">
          {policies.map((p) => (
            <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
              <RuleSummary p={p} />
              <div className="flex gap-2">
                <button onClick={() => void run(() => api2.togglePolicy(p.id, !p.enabled))} className="btn-quiet" aria-label={`${p.enabled ? "Disable" : "Enable"} rule ${p.id}`}>
                  {p.enabled ? "Disable" : "Enable"}
                </button>
                <button onClick={() => void run(() => api2.deletePolicy(p.id))} className="btn text-danger enabled:hover:bg-red-50" aria-label={`Delete rule ${p.id}`}>Delete</button>
              </div>
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

      <Section title="Contacts" label="Contacts">
        <p className="text-sm text-soft">Only these addresses, and yours, count as known.</p>
        <ul className="panel divide-y divide-line">
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

      <Section title="Notifications">
        <TelegramCard />
      </Section>

      <Section title="Account">
        <div className="panel space-y-3 p-4 text-sm">
          <p className="break-all">Signed in as <b>{email}</b></p>
          <p className="text-soft">
            AI: {health?.replay ? "demo, scripted" : health?.llmModel ? `${health.llmProvider}, ${health.llmModel}` : "not configured"}. Server: {offline ? "offline" : health?.ok ? "ok" : "connecting"}.
          </p>
          <button onClick={onLogout} className="btn-quiet">Log out</button>
        </div>
      </Section>
    </div>
  );
}
