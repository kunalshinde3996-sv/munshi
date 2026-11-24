import { useEffect, useRef, useState } from "react";
import { onErrorToast, type Action } from "./api";

export function usePoll(fn: () => Promise<void> | void, ms: number, deps: unknown[] = []) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let live = true;
    const tick = () => live && void Promise.resolve(ref.current()).catch(() => undefined);
    tick();
    const t = setInterval(tick, ms);
    return () => {
      live = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const TONES = {
  green: "bg-emerald-100 text-emerald-800",
  amber: "bg-amber-100 text-amber-900",
  red: "bg-red-100 text-red-800",
  darkred: "bg-red-700 text-white",
  stone: "bg-stone-100 text-stone-600",
  blue: "bg-sky-100 text-sky-800",
} as const;

export function Chip({ tone, children, title }: { tone: keyof typeof TONES; children: React.ReactNode; title?: string }) {
  return <span title={title} className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${TONES[tone]}`}>{children}</span>;
}

/** Guard decision chip: Allowed / Needs approval / Tainted / Blocked. */
export function DecisionChip({ a }: { a: Pick<Action, "decision" | "tainted"> }) {
  if (a.decision === "block") return <Chip tone="darkred">Blocked</Chip>;
  if (a.decision === "skipped") return <Chip tone="stone">Skipped (duplicate)</Chip>;
  if (a.tainted) return <Chip tone="red">Tainted · needs approval</Chip>;
  if (a.decision === "require_approval") return <Chip tone="amber">Needs approval</Chip>;
  return <Chip tone="green">Allowed</Chip>;
}

export function StatusBadge({ a, now }: { a: Action; now: number }) {
  switch (a.status) {
    case "verified": return <Chip tone="green" title={a.verify?.detail}>Verified ✓</Chip>;
    case "verification_failed": return <Chip tone="darkred" title={a.verify?.detail}>Verification failed ✗</Chip>;
    case "held": return <Chip tone="blue">Held · sends in {Math.max(0, Math.ceil(((a.holdUntil ?? now) - now) / 1000))}s</Chip>;
    case "pending_approval": return <Chip tone="amber">Awaiting approval</Chip>;
    case "approved": return <Chip tone="blue">Approved</Chip>;
    case "executed": return <Chip tone="blue">Executed</Chip>;
    case "undone": return <Chip tone="stone">Undone</Chip>;
    case "rejected": return <Chip tone="stone">Rejected</Chip>;
    case "blocked": return <Chip tone="darkred">Blocked</Chip>;
    case "skipped": return <Chip tone="stone">Skipped</Chip>;
    case "failed": return <Chip tone="darkred">Failed ✗</Chip>;
    default: return <Chip tone="stone">{a.status}</Chip>;
  }
}

export function Warnings({ a }: { a: Action }) {
  if (!a.warnings.length) return null;
  return (
    <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900" role="alert">
      <p className="font-semibold">⚠ Not from you</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">{a.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
    </div>
  );
}

export function Banner({ tone, children }: { tone: "red" | "amber" | "green"; children: React.ReactNode }) {
  const c = { red: "border-red-200 bg-red-50 text-red-800", amber: "border-amber-200 bg-amber-50 text-amber-900", green: "border-emerald-200 bg-emerald-50 text-emerald-900" }[tone];
  return <p className={`rounded-lg border p-3 text-sm ${c}`}>{children}</p>;
}

export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Brand mark: ledger "M" in paper on ink with a saffron rule and seal dot. Pure SVG. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="Munshi logo">
      <rect width="32" height="32" rx="8" fill="#1c2434" />
      <path d="M8 23h16" stroke="#d9770a" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M9 20V12l7 6 7-6v8" fill="none" stroke="#faf8f4" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="7.5" r="1.8" fill="#d9770a" />
    </svg>
  );
}

/** Error toasts for failed write requests. Auto-dismiss after 6s; also dismissable. */
export function Toaster() {
  const [items, setItems] = useState<{ id: number; text: string }[]>([]);
  useEffect(() => {
    let n = 0;
    return onErrorToast((text) => {
      const id = ++n;
      setItems((x) => [...x.slice(-3), { id, text }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 6000);
    });
  }, []);
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2" aria-live="assertive">
      {items.map((i) => (
        <div key={i.id} role="alert" className="flex items-start justify-between gap-3 rounded-lg border border-red-300 bg-white p-3 text-sm text-red-800 shadow-lg">
          <span>{i.text}</span>
          <button onClick={() => setItems((x) => x.filter((y) => y.id !== i.id))} className="text-stone-400 hover:text-ink" aria-label="Dismiss">✕</button>
        </div>
      ))}
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="flex items-center gap-2 p-6 text-sm text-stone-500" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-saffron" />
      {label}
    </p>
  );
}

/** Shown on every screen (incl. onboarding) while LLM_PROVIDER=replay: outputs come from a recording, not a live model. */
export function ReplayBanner({ health }: { health: { replay?: boolean; replayBanner?: string | null } | null }) {
  if (!health?.replay) return null;
  return (
    <div role="status" className="sticky top-0 z-40 bg-violet-700 px-3 py-1.5 text-center text-xs font-bold tracking-wide text-white">
      {health.replayBanner ?? "DEMO MODE — scripted sample outputs, not live AI"}
    </div>
  );
}
