import { useEffect, useState } from "react";
import { api, type Health } from "./api";
import Inbox from "./pages/Inbox";

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
    api.health().then(setHealth).catch(() => setOffline(true));
  }, []);

  return (
    <div className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink text-lg font-bold text-saffron">म</span>
            <span className="text-lg font-semibold tracking-tight">Munshi</span>
          </div>
          <div className="flex items-center gap-3">
            {health?.mode === "google" ? (
              <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold tracking-wide text-emerald-800">GOOGLE</span>
            ) : (
              <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold tracking-wide text-amber-800">SANDBOX DATA</span>
            )}
            <span className="hidden text-xs text-stone-500 sm:inline">
              {health?.llmModel ? `${health.llmProvider} · ${health.llmModel}` : "LLM not configured"}
            </span>
            <span className={`flex items-center gap-1.5 text-xs ${offline ? "text-red-600" : "text-stone-500"}`}>
              <span className={`h-2 w-2 rounded-full ${offline ? "bg-red-500" : health?.ok ? "bg-emerald-500" : "bg-stone-300"}`} />
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
                page === t.id ? "border-saffron text-ink" : "border-transparent text-stone-500 hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">
        {page === "inbox" && <Inbox health={health} />}
        {page === "activity" && (
          <p className="text-sm text-stone-600">The audit trail and undo controls arrive in milestone M5.</p>
        )}
        {page === "policies" && (
          <p className="text-sm text-stone-600">Policy and contacts management arrives in milestone M4.</p>
        )}
      </main>
    </div>
  );
}
