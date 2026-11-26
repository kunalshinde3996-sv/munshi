import { useState } from "react";
import { api, type Health } from "./api";
import { Logo, ReplayBanner, usePoll } from "./components";

/** Shown only after the server has confirmed the logout. */
export default function SignedOut({ onSignInAgain }: { onSignInAgain: () => void }) {
  const [health, setHealth] = useState<Health | null>(null);
  usePoll(() => api.health().then(setHealth).catch(() => undefined), 5000);
  return (
    <>
      <ReplayBanner health={health} />
      <main className="grid min-h-[85vh] place-items-center px-4 py-10">
        <div className="panel fade-in w-full max-w-sm space-y-4 p-8 text-center">
          <div className="flex justify-center"><Logo size={44} /></div>
          <h1 className="font-display text-2xl font-semibold">You're signed out</h1>
          <p className="text-soft">Your session has ended.</p>
          <button autoFocus onClick={onSignInAgain} className="btn-primary w-full">Sign in again</button>
        </div>
      </main>
    </>
  );
}
