import { useState } from "react";
import { googleApi, type Health } from "./api";
import { Banner, Logo } from "./components";

const POINTS = [
  ["It reads", "Finds bills, deadlines and renewals in your mail."],
  ["It helps", "Sets reminders and drafts replies."],
  ["You decide", "Anything risky waits for your yes."],
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
    <main className="grid min-h-[90vh] place-items-center px-4 py-10">
      <div className="w-full max-w-md space-y-7">
        <div className="space-y-3">
          <Logo size={44} />
          <h1 className="font-display text-3xl font-semibold">Less to keep in your head</h1>
        </div>
        <ul className="space-y-4">
          {POINTS.map(([t, d]) => (
            <li key={t}>
              <p className="font-semibold">{t}</p>
              <p className="text-soft">{d}</p>
            </li>
          ))}
        </ul>
        <p className="rounded-xl bg-warn-wash p-3 text-sm text-warn"><b>SANDBOX DATA:</b> a made-up mailbox. No Google account needed.</p>
        {offline && <Banner tone="red">Cannot reach the server. Start it with <code>npm run dev:server</code>.</Banner>}
        {health && !health.llmConfigured && <Banner tone="amber">LLM not configured ({health.llmError}). Scanning needs a key in <code>.env</code>.</Banner>}
        {err && <Banner tone="red">{err}</Banner>}
        <button onClick={() => void start()} disabled={busy || offline} className="btn-primary min-h-12 w-full text-base">
          {busy ? "Starting…" : "Try sandbox"}
        </button>
      </div>
    </main>
  );
}
