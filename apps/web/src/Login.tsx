import { useState } from "react";
import { api, authApi, type AuthUser, type Health } from "./api";
import { Banner, Logo, ReplayBanner, usePoll } from "./components";

export default function Login({ onLoggedIn }: { onLoggedIn: (u: AuthUser) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [offline, setOffline] = useState(false);
  // /api/health is public, so the DEMO MODE banner and server status work before sign-in.
  usePoll(() => api.health().then((h) => { setHealth(h); setOffline(false); }).catch(() => setOffline(true)), 5000);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onLoggedIn(await authApi.login(email, password));
    } catch (e2) {
      setErr((e2 as Error).message);
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ReplayBanner health={health} />
      <div className="grid min-h-[80vh] place-items-center px-4 py-10">
        <form onSubmit={(e) => void submit(e)} className="w-full max-w-sm space-y-4 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="flex items-center gap-3">
            <Logo size={40} />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Sign in to Munshi</h1>
              <p className="text-xs text-stone-500">Single-user app. There is no sign-up.</p>
            </div>
          </div>
          {offline && <Banner tone="red">Cannot reach the server. Start it with <code>npm run dev:server</code>.</Banner>}
          {err && <Banner tone="red">{err}</Banner>}
          <label className="block text-sm font-medium">
            Email
            <input
              type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal"
            />
          </label>
          <label className="block text-sm font-medium">
            Password
            <input
              type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm font-normal"
            />
          </label>
          <button
            type="submit" disabled={busy || offline}
            className="w-full rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <p className="text-xs text-stone-500">The demo login is set in <code>.env</code> (<code>DEMO_USER_EMAIL</code> / <code>DEMO_USER_PASSWORD</code>).</p>
        </form>
      </div>
    </>
  );
}
