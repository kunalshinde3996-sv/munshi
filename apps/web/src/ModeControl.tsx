import { useState } from "react";
import { googleApi, type GoogleStatus } from "./api";
import { Banner, usePoll } from "./components";

/** Mode badge + Google connection controls. Everything shown here comes from the server, nothing is assumed. */
export function ModeBadge({ mode }: { mode: "sandbox" | "google" | undefined }) {
  if (mode === "google") return <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold tracking-wide text-emerald-800">GOOGLE · LIVE DATA</span>;
  if (mode === "sandbox") return <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold tracking-wide text-amber-800">SANDBOX DATA</span>;
  return <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-bold tracking-wide text-stone-500">…</span>;
}

function SetupModal({ g, onClose }: { g: GoogleStatus; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Google is not configured</h2>
        <p className="mt-1 text-sm text-stone-600">
          Missing in <code>.env</code>: <b>{g.missing.join(", ")}</b>. Sandbox mode keeps working without them.
        </p>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
          {g.setupSteps.map((s, i) => <li key={i} className="break-words">{s}</li>)}
        </ol>
        <button onClick={onClose} className="mt-4 rounded-lg bg-ink px-4 py-1.5 text-sm font-semibold text-white">Close</button>
      </div>
    </div>
  );
}

export default function ModeControl({ onModeChange }: { onModeChange: () => void }) {
  const [g, setG] = useState<GoogleStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  usePoll(async () => setG(await googleApi.status()), 4000);

  const run = async (fn: () => Promise<GoogleStatus>) => {
    setBusy(true);
    setErr(null);
    try {
      setG(await fn());
      onModeChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!g) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {!g.connected && (
        <button
          onClick={() => (g.configured ? (window.location.href = "/auth/google/start") : setHelp(true))}
          className="rounded-lg border border-stone-300 bg-white px-3 py-1 font-medium hover:bg-stone-50"
          title={g.configured ? "Sign in with Google" : "Google OAuth is not configured"}
        >
          Connect Google{!g.configured && " (not configured)"}
        </button>
      )}
      {g.connected && (
        <>
          <span className="hidden text-stone-500 md:inline">{g.email}</span>
          <button disabled={busy} onClick={() => void run(() => googleApi.setMode(g.mode === "google" ? "sandbox" : "google"))} className="rounded-lg border border-stone-300 bg-white px-3 py-1 font-medium hover:bg-stone-50 disabled:opacity-40">
            {g.mode === "google" ? "Use sandbox" : "Use Google"}
          </button>
          <button disabled={busy} onClick={() => void run(() => googleApi.disconnect())} className="text-stone-500 underline hover:text-red-700 disabled:opacity-40">Disconnect</button>
        </>
      )}
      {err && <span className="basis-full text-red-700">{err}</span>}
      {help && <SetupModal g={g} onClose={() => setHelp(false)} />}
      {g.authProblem && g.mode === "google" && (
        <div className="basis-full">
          <Banner tone="red">
            {g.authProblem}{" "}
            <button className="font-semibold underline" onClick={() => (window.location.href = "/auth/google/start")}>Reconnect Google</button>
          </Banner>
        </div>
      )}
    </div>
  );
}
