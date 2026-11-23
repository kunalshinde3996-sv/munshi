import { useEffect, useState } from "react";
import { api, api2, type Action, type Health } from "./api";
import { Banner, usePoll } from "./components";
import ModeControl, { ModeBadge } from "./ModeControl";
import Activity from "./pages/Activity";
import Approvals from "./pages/Approvals";
import Inbox from "./pages/Inbox";
import Policies from "./pages/Policies";

type Page = "inbox" | "approvals" | "activity" | "policies";

const TABS: { id: Page; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "approvals", label: "Approvals" },
  { id: "activity", label: "Activity" },
  { id: "policies", label: "Policies" },
];

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [offline, setOffline] = useState(false);
  const [page, setPage] = useState<Page>("inbox");
  const [actions, setActions] = useState<Action[]>([]);
  const refreshActions = async () => setActions(await api2.actions());
  usePoll(refreshActions, 2000);
  const pending = actions.filter((x) => x.status === "pending_approval");

  const loadHealth = () => api.health().then((h) => { setHealth(h); setOffline(false); }).catch(() => setOffline(true));
  usePoll(loadHealth, 5000);

  // Result of the Google OAuth redirect (?google=connected|denied|error&message=...)
  const [notice, setNotice] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const g = q.get("google");
    if (!g) return;
    setNotice(g === "connected" ? { tone: "green", text: "Google connected. Use “Use Google” to switch the mailbox." } : { tone: "red", text: `Google connection failed: ${q.get("message") ?? g}` });
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  return (
    <div className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink text-lg font-bold text-saffron">म</span>
            <span className="text-lg font-semibold tracking-tight">Munshi</span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <ModeControl onModeChange={() => void loadHealth()} />
            <ModeBadge mode={health?.mode} />
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
              {t.id === "approvals" && pending.length > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-500 px-1.5 py-0.5 text-xs font-bold text-white">{pending.length}</span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <main key={health?.mode} className="mx-auto max-w-5xl space-y-6 px-4 py-8">
        {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
        {page === "inbox" && <Inbox health={health} onActionsChange={() => void refreshActions()} goToApprovals={() => setPage("approvals")} />}
        {page === "approvals" && <Approvals pending={pending} refresh={() => void refreshActions()} />}
        {page === "activity" && <Activity actions={actions} refresh={() => void refreshActions()} />}
        {page === "policies" && <Policies />}
      </main>
    </div>
  );
}
