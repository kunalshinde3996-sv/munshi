import { useState } from "react";
import { googleApi, type GoogleStatus } from "./api";
import { Banner, DataBadge, Drawer, usePoll } from "./components";

/** Google connection controls. Everything shown here comes from the server, nothing is assumed. */
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

  if (!g) return <p className="text-sm text-soft">Loading mailbox…</p>;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <DataBadge mode={g.mode} />
        {g.connected && <span className="break-all text-soft">{g.email}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {!g.connected && (
          <button onClick={() => (g.configured ? (window.location.href = "/auth/google/start") : setHelp(true))} className="btn-quiet">
            Connect Google{!g.configured && " (not configured)"}
          </button>
        )}
        {g.connected && (
          <>
            <button disabled={busy} onClick={() => void run(() => googleApi.setMode(g.mode === "google" ? "sandbox" : "google"))} className="btn-quiet">
              {g.mode === "google" ? "Use sandbox" : "Use Google"}
            </button>
            <button disabled={busy} onClick={() => void run(() => googleApi.disconnect())} className="text-soft underline enabled:hover:text-danger">Disconnect</button>
          </>
        )}
      </div>
      {err && <Banner tone="red">{err}</Banner>}
      {help && (
        <Drawer title="Google is not configured" mode={g.mode} onClose={() => setHelp(false)}>
          <p className="break-words text-sm text-soft">
            Missing in <code>.env</code>: <b>{g.missing.join(", ")}</b>. Sandbox mode keeps working without them.
          </p>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            {g.setupSteps.map((s, i) => <li key={i} className="break-words">{s}</li>)}
          </ol>
        </Drawer>
      )}
    </div>
  );
}
