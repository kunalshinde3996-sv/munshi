import { useEffect, useRef, useState } from "react";
import type { Action } from "./api";

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
