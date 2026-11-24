import { useState } from "react";
import { googleApi, type Health } from "./api";
import { Banner, Logo } from "./components";

const POINTS = [
  ["Reads your inbox in quarantine", "A tool-less extractor turns bills, deadlines, renewals and refunds into structured obligations. Raw email text never reaches the agent."],
  ["Acts only through MCP tools", "It can draft, label, add calendar reminders, or propose an email, using Munshi's own Gmail and Calendar MCP servers."],
  ["Every action passes a code-based Guard", "Policy, provenance, preview, verify, undo. Nothing external happens without your approval, and no LLM decides what is safe."],
];

export default function Onboarding({ health, offline, onStart }: { health: Health | null; offline: boolean; onStart: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (health?.mode === "google") await googleApi.setMode("sandbox");
      onStart();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-xl space-y-6 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="flex items-center gap-3">
          <Logo size={44} />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Munshi</h1>
            <p className="text-sm text-stone-600">Life-admin on autopilot, with a Guard you can trust.</p>
          </div>
        </div>
        <ol className="space-y-4">
          {POINTS.map(([t, d], i) => (
            <li key={t} className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-saffron text-xs font-bold text-white">{i + 1}</span>
              <div>
                <p className="font-medium">{t}</p>
                <p className="text-sm text-stone-600">{d}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
          <b>SANDBOX DATA:</b> the demo mailbox is fictional and includes prompt-injection emails so you can watch the Guard stop them. No Google account is needed.
        </p>
        {offline && <Banner tone="red">Cannot reach the server. Start it with <code>npm run dev:server</code>.</Banner>}
        {health?.replay && <Banner tone="amber">Replay mode: scan and agent results come from a recording, not a live model. No API key needed.</Banner>}
        {health && !health.llmConfigured && <Banner tone="amber">LLM not configured ({health.llmError}). You can look around, but scanning needs a key in <code>.env</code>.</Banner>}
        {err && <Banner tone="red">{err}</Banner>}
        <button
          onClick={() => void start()}
          disabled={busy || offline}
          className="w-full rounded-lg bg-ink px-4 py-3 font-semibold text-white hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Starting…" : "Try sandbox"}
        </button>
      </div>
    </div>
  );
}
