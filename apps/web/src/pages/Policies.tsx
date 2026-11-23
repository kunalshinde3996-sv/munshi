import { useCallback, useState } from "react";
import { api2, type Contact, type PolicyRow } from "../api";
import { Banner, Chip, usePoll } from "../components";

const TEMPLATE = `{
  "id": "my-rule",
  "description": "Ask me before creating events with a wedding in the title",
  "match": { "tool": "create_event", "argsCondition": { "title": { "contains": "wedding" } } },
  "decision": "require_approval",
  "reason": "I want to review wedding events myself."
}`;

const DECISION_TONE = { allow: "green", require_approval: "amber", block: "darkred" } as const;

export default function Policies() {
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [draft, setDraft] = useState(TEMPLATE);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

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
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Policies</h1>
        <p className="text-sm text-stone-600">
          Rules the Guard applies to every action. The most restrictive matching rule wins. Some protections are built in and cannot be
          switched off: sending email always needs approval, and a tainted action is never auto-allowed.
        </p>
      </div>
      {err && <Banner tone="red">{err}</Banner>}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Rules ({policies.length})</h2>
        <ul className="divide-y divide-stone-200 rounded-xl border border-stone-200 bg-white">
          {policies.map((p) => (
            <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold">{p.id}</span>
                  {p.rule && <Chip tone={DECISION_TONE[p.rule.decision as keyof typeof DECISION_TONE] ?? "stone"}>{p.rule.decision.replace("_", " ")}</Chip>}
                  {p.seed && <Chip tone="stone">default</Chip>}
                  {!p.valid && <Chip tone="red">invalid: ignored</Chip>}
                  {!p.enabled && <Chip tone="stone">disabled</Chip>}
                </div>
                {p.rule?.description && <p className="text-sm text-stone-700">{p.rule.description}</p>}
                <pre className="overflow-x-auto rounded bg-stone-50 p-2 text-xs">{JSON.stringify(p.rule?.match, null, 1)}</pre>
              </div>
              <div className="flex gap-2">
                <button onClick={() => void run(() => api2.togglePolicy(p.id, !p.enabled))} className="rounded-lg border border-stone-300 px-3 py-1 text-sm hover:bg-stone-50">
                  {p.enabled ? "Disable" : "Enable"}
                </button>
                <button onClick={() => void run(() => api2.deletePolicy(p.id))} className="rounded-lg border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50">Delete</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Add a rule (JSON)</h2>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={9} spellCheck={false} className="w-full rounded-lg border border-stone-300 bg-white p-3 font-mono text-xs" />
        <p className="text-xs text-stone-500">
          <code>match</code>: <code>tool</code> (or "*"), <code>argsCondition</code> (literal, or contains / gte / lte / in / exists), <code>tainted</code>,{" "}
          <code>allSensitiveAllowlisted</code>, <code>minObligationConfidence</code>. <code>decision</code>: allow, require_approval, block.
        </p>
        <button onClick={() => void addPolicy()} className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink/90">Add rule</button>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Contacts allowlist ({contacts.length})</h2>
        <p className="text-sm text-stone-600">Only addresses you add here (or your own) count as allowlisted recipients.</p>
        <ul className="divide-y divide-stone-200 rounded-xl border border-stone-200 bg-white">
          {contacts.length === 0 && <li className="p-4 text-sm text-stone-500">No contacts yet.</li>}
          {contacts.map((c) => (
            <li key={c.id} className="flex items-center justify-between p-3 text-sm">
              <span><b>{c.name}</b> <span className="text-stone-500">&lt;{c.email}&gt;</span></span>
              <button onClick={() => void run(() => api2.deleteContact(c.id))} className="text-red-700 hover:underline">Remove</button>
            </li>
          ))}
        </ul>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api2.addContact(name, email), () => { setName(""); setEmail(""); });
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm" />
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" required type="email" className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm" />
          <button className="rounded-lg bg-ink px-4 py-1.5 text-sm font-semibold text-white">Add contact</button>
        </form>
      </section>
    </div>
  );
}
