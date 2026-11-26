import { useEffect, useRef, useState } from "react";
import { api, api2, authApi, onUnauthorized, type Action, type AuthUser, type Health } from "./api";
import AccountMenu from "./AccountMenu";
import { Banner, DataBadge, Logo, ReplayBanner, Spinner, usePoll } from "./components";
import Login from "./Login";
import { resetEntrances, useReducedMotionClass, useRipple } from "./motion";
import Onboarding from "./Onboarding";
import AuditLog from "./pages/AuditLog";
import Settings from "./pages/Settings";
import Today from "./pages/Today";
import Trust from "./pages/Trust";
import SignedOut from "./SignedOut";
import SlidingNav from "./SlidingNav";
import { Toaster } from "./toasts";
import { useRun } from "./useRun";

type Page = "today" | "trust" | "audit" | "settings";
/** Array order is the visual order and the keyboard focus order. */
export const NAV: { id: Page; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "trust", label: "Trust" },
  { id: "audit", label: "Audit log" },
  { id: "settings", label: "Settings" },
];

/** Auth gate: shows the login screen until /api/auth/me confirms a session; any later 401 sends you back here. */
export default function App() {
  useReducedMotionClass();
  useRipple();
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined); // undefined = checking
  const [signedOut, setSignedOut] = useState(false);
  const signingOut = useRef(false);
  useEffect(() => {
    authApi.me().then(setUser).catch(() => setUser(null));
    // A poll that races the logout may get a 401 first; the sign-out flow handles that transition itself.
    return onUnauthorized(() => { if (!signingOut.current) setUser(null); });
  }, []);

  /**
   * Ends the session on the server first. Only then is the UI cleared: if the request fails this rejects and the
   * user stays signed in, because showing "signed out" while the cookie still works would be false.
   */
  const signOut = async () => {
    signingOut.current = true;
    try {
      await authApi.logout();
      resetEntrances();
      setSignedOut(true);
      setUser(null); // unmounts the shell, which discards every piece of client state it held
    } finally {
      signingOut.current = false;
    }
  };

  if (signedOut) return <SignedOut onSignInAgain={() => setSignedOut(false)} />;
  if (user === undefined) return <Spinner label="Checking your session…" />;
  if (!user) return <Login onLoggedIn={setUser} />;
  return <Shell user={user} onSignOut={signOut} />;
}

function Shell({ user, onSignOut }: { user: AuthUser; onSignOut: () => Promise<void> }) {
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

  const navItems = NAV.map((t) => ({ ...t, badge: t.id === "today" && pending > 0 && page !== "today" ? `${pending} waiting for you` : undefined }));
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-8 focus:z-[70] focus:rounded-lg focus:bg-panel focus:px-3 focus:py-2">Skip to content</a>
      <Toaster />
      <ReplayBanner health={health} />
      <div className="mx-auto max-w-[1100px] px-3 pt-3 sm:px-4">
        <header className="panel relative z-30 flex flex-wrap items-center gap-x-4 gap-y-2 p-2 md:flex-nowrap md:px-3">
          <div className="order-1 flex items-center gap-2 pl-1">
            <Logo size={28} />
            <span className="font-display text-lg font-semibold">Munshi</span>
            <DataBadge mode={health?.mode} />
          </div>
          <SlidingNav items={navItems} current={page} onSelect={setPage} label="Main" tone="wash" className="order-3 w-full justify-between md:order-2 md:mx-auto md:w-auto md:justify-start md:gap-1" />
          <div className="order-2 ml-auto md:order-3 md:ml-0">
            <AccountMenu email={user.email} onSettings={() => setPage("settings")} onTrust={() => setPage("trust")} onSignOut={onSignOut} />
          </div>
        </header>
      </div>

      <main id="main" key={health?.mode} className="mx-auto max-w-[1100px] space-y-4 px-3 pb-28 pt-4 sm:px-4">
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
        {page === "audit" && <AuditLog actions={actions ?? []} />}
        {page === "settings" && <Settings health={health} offline={offline} email={user.email} onModeChange={() => void loadHealth()} onSignOut={onSignOut} />}
      </main>
    </div>
  );
}
