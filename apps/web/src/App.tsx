import { useEffect, useState } from "react";

type Health = { ok: boolean; llmProvider: string; llmConfigured: boolean };
type Page = "inbox" | "activity" | "policies";

const TABS: { id: Page; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "activity", label: "Activity" },
  { id: "policies", label: "Policies" },
];

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [offline, setOffline] = useState(false);
  const [page, setPage] = useState<Page>("inbox");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch(() => setOffline(true));
  }, []);

  return (
    <div className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink text-lg font-bold text-saffron">
              म
            </span>
            <span className="text-lg font-semibold tracking-tight">Munshi</span>
          </div>
          <div className="flex items-center gap-3">
            {/* Mode is hardcoded to sandbox until the per-user setting API lands (M2/M6). */}
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold tracking-wide text-amber-800">
              SANDBOX DATA
            </span>
            <span
              className={`flex items-center gap-1.5 text-xs ${offline ? "text-red-600" : "text-stone-500"}`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  offline ? "bg-red-500" : health?.ok ? "bg-emerald-500" : "bg-stone-300"
                }`}
              />
              {offline ? "server offline" : health?.ok ? "server ok" : "connecting…"}
            </span>
          </div>
        </div>
        <nav className="mx-auto flex max-w-5xl gap-1 px-4">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setPage(t.id)}
              className={`border-b-2 px-3 py-2 text-sm font-medium ${
                page === t.id
                  ? "border-saffron text-ink"
                  : "border-transparent text-stone-500 hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="text-2xl font-semibold capitalize">{page}</h1>
        <p className="mt-2 text-sm text-stone-600">
          {page === "inbox" && "Inbox scanning arrives in milestone M3."}
          {page === "activity" && "The audit trail and undo controls arrive in milestone M5."}
          {page === "policies" && "Policy and contacts management arrives in milestone M4."}
        </p>
        {health && !health.llmConfigured && (
          <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            LLM_MODEL is not set in <code>.env</code> — extraction will not work until it is.
          </p>
        )}
      </main>
    </div>
  );
}
