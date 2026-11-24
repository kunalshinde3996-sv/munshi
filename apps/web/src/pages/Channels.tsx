import { useState } from "react";
import { channelsApi, type TelegramStatus } from "../api";
import { Chip, usePoll } from "../components";

/** Telegram channel status. "Not configured" is a normal state: the web app is the primary channel and works without it. */
export default function TelegramCard() {
  const [s, setS] = useState<TelegramStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  usePoll(async () => {
    try {
      setS(await channelsApi.telegram());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, 5000);

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-4" aria-label="Telegram channel">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Telegram</h3>
        {err ? <Chip tone="red">Unavailable</Chip> : !s ? <Chip tone="stone">Loading…</Chip> : !s.configured ? <Chip tone="stone">Not configured</Chip> : s.linked ? <Chip tone="green">Linked</Chip> : <Chip tone="amber">Send /start to your bot</Chip>}
      </div>
      <p className="mt-1 text-sm text-stone-600">
        Get approval requests (with the Guard preview and provenance warning) and due-date nudges on your phone. Approve or Reject with one tap; tainted actions need a second confirming tap. Decisions use the same Guard path and audit log as this app.
      </p>
      {s?.bot && <p className="mt-2 text-xs text-stone-500">Bot: @{s.bot}</p>}
      {s?.lastError && <p className="mt-2 text-xs text-red-700">Last error: {s.lastError}</p>}
      {err && <p className="mt-2 text-xs text-red-700">{err}</p>}
      {s && (!s.configured || !s.linked) && (
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-stone-700">
          {s.setup.map((step) => <li key={step}>{step}</li>)}
        </ol>
      )}
    </section>
  );
}
