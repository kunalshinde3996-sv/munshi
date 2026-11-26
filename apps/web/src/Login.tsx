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

  const submit = async (e: React.FormEvent | null, demo = false) => {
    e?.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onLoggedIn(demo ? await authApi.demoLogin() : await authApi.login(email, password));
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
      <main className="grid min-h-[85vh] place-items-center px-4 py-10">
        <form onSubmit={(e) => void submit(e)} className="w-full max-w-xs space-y-4">
          <div className="space-y-3 pb-2">
            <Logo size={44} />
            <h1 className="font-display text-3xl font-semibold">Sign in to Munshi</h1>
          </div>
          {offline && <Banner tone="red">Cannot reach the server. Start it with <code>npm run dev:server</code>.</Banner>}
          {err && <Banner tone="red">{err}</Banner>}
          {health?.demoLogin && (
            <>
              <button type="button" disabled={busy || offline} onClick={() => void submit(null, true)} className="btn-primary w-full">
                Use demo account
              </button>
              <p className="text-center text-sm text-soft">or</p>
            </>
          )}
          <label className="block text-sm font-medium">
            Email
            <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className="field mt-1 w-full font-normal" />
          </label>
          <label className="block text-sm font-medium">
            Password
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="field mt-1 w-full font-normal" />
          </label>
          <button type="submit" disabled={busy || offline} className={`w-full ${health?.demoLogin ? "btn-quiet" : "btn-primary"}`}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </main>
    </>
  );
}
