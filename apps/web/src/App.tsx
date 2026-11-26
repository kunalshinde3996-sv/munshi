import { useEffect, useState } from "react";
import { api, api2, authApi, onUnauthorized, type Action, type AuthUser, type Health } from "./api";
import { Banner, DataBadge, Logo, ReplayBanner, Spinner, Toaster, usePoll } from "./components";
import Login from "./Login";
import Onboarding from "./Onboarding";
import Settings from "./pages/Settings";
import Today from "./pages/Today";
import Trust from "./pages/Trust";
import { useRun } from "./useRun";

type Page = "today" | "trust" | "settings";
const NAV: { id: Page; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "trust", label: "Trust" },
  { id: "settings", label: "Settings" },
];

/** Auth gate: shows the login screen until /api/auth/me confirms a session; any later 401 sends you back here. */
export default function App() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined); // undefined = checking
  useEffect(() => {
    authApi.me().then(setUser).catch(() => setUser(null));
    return onUnauthorized(() => setUser(null));
  }, []);
  if (user === undefined) return <Spinner label="Checking your session…" />;
  if (!user) return <Login onLoggedIn={setUser} />;
  return <Shell user={user} onLoggedOut={() => setUser(null)} />;
}

function Shell({ user, onLoggedOut }: { user: AuthUser; onLoggedOut: () => void }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [offline, setOffline] = useState(false);
  const [page, setPage] = useState<Page>("today");
  const [actions, setActions] = useState<Action[] | null>(null);
  const [snoozed, setSnoozed] = useState<string[]>([]); // "Not now": hidden in this window only; still pending on the server
  const refreshActions = async () => setActions(await api2.actions());
  usePoll(refreshActions, 2000);
  const refresh = () => void refreshActions().catch(() => undefined);
  const run = useRun(refresh);
  const pending = actions?.filter((a) => a.status === "pending_approval").length ?? 0;

  const loadHealth = () => api.health().then((h) => { setHealth(h); setOffline(false); }).catch(() => setOffline(true));
  usePoll(loadHealth, 5000);

  // Result of the Google OAuth redirect (?google=connected|denied|error&message=...)
  const [notice, setNotice] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const g = q.get("google");
    if (!g) return;
    setNotice(g === "connected" ? { tone: "green", text: "Google connected. Press “Use Google” to switch mailbox." } : { tone: "red", text: `Google connection failed: ${q.get("message") ?? g}` });
    setPage("settings");
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const [welcomed, setWelcomed] = useState(() => localStorage.getItem(`munshi.onboarded.${user.email}`) === "1");
  if (!welcomed) {
    return (
      <>
        <ReplayBanner health={health} />
        <Onboarding
          health={health}
          offline={offline}
          onStart={() => { localStorage.setItem(`munshi.onboarded.${user.email}`, "1"); setWelcomed(true); void loadHealth(); }}
        />
        <Toaster />
      </>
    );
  }

  const logout = () => void authApi.logout().catch(() => undefined).finally(onLoggedOut);

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-8 focus:z-[70] focus:rounded-lg focus:bg-white focus:px-3 focus:py-2">Skip to content</a>
      <Toaster />
      <ReplayBanner health={health} />
      <header className="mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 pt-5">
        <div className="flex items-center gap-2">
          <Logo size={28} />
          <span className="font-display text-lg font-semibold">Munshi</span>
          <DataBadge mode={health?.mode} />
        </div>
        <nav className="flex gap-1" aria-label="Main">
          {NAV.map((t) => (
            <button
              key={t.id}
              onClick={() => setPage(t.id)}
              aria-current={page === t.id ? "page" : undefined}
              aria-label={t.id === "today" && pending > 0 && page !== "today" ? `Today, ${pending} waiting for you` : undefined}
              className={`relative rounded-full px-4 py-2 text-sm font-semibold ${page === t.id ? "bg-white text-ink shadow-sm" : "text-soft hover:text-ink"}`}
            >
              {t.label}
              {t.id === "today" && pending > 0 && page !== "today" && <span aria-hidden className="absolute right-1 top-1.5 h-2 w-2 rounded-full bg-warn" />}
            </button>
          ))}
        </nav>
      </header>

      <main id="main" key={health?.mode} className="mx-auto max-w-2xl space-y-6 px-4 pb-24 pt-10">
        {offline && <Banner tone="red">Can't reach the Munshi server. Is <code>npm run dev:server</code> running?</Banner>}
        {health?.googleAuthProblem && health.mode === "google" && (
          <Banner tone="red">
            {health.googleAuthProblem}{" "}
            <button className="font-semibold underline" onClick={() => (window.location.href = "/auth/google/start")}>Reconnect Google</button>
          </Banner>
        )}
        {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
        {page === "today" && (
          <Today health={health} actions={actions} refreshActions={refresh} run={run} snoozed={snoozed} setSnoozed={setSnoozed} goToTrust={() => setPage("trust")} />
        )}
        {page === "trust" && <Trust actions={actions ?? []} mode={health?.mode} refresh={refresh} onEditRules={() => setPage("settings")} />}
        {page === "settings" && <Settings health={health} offline={offline} email={user.email} onModeChange={() => void loadHealth()} onLogout={logout} />}
      </main>
    </div>
  );
}
