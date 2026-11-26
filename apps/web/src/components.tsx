import { useEffect, useId, useRef, useState } from "react";
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
  green: "bg-wash text-accent-deep",
  amber: "bg-warn-wash text-warn",
  red: "bg-red-50 text-danger",
  darkred: "bg-danger text-white",
  stone: "bg-mist text-soft",
  blue: "bg-sky-50 text-sky-900",
} as const;

export function Chip({ tone, children, title }: { tone: keyof typeof TONES; children: React.ReactNode; title?: string }) {
  return <span title={title} className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${TONES[tone]}`}>{children}</span>;
}

/** Guard decision chip, in the Guard's own words. Used in the Trust view only. */
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
    <div className="rounded-xl bg-warn-wash p-3 text-sm text-warn">
      <p className="font-semibold">⚠ Not from you</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 break-words">{a.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
    </div>
  );
}

export function Banner({ tone, children }: { tone: "red" | "amber" | "green"; children: React.ReactNode }) {
  const c = { red: "bg-red-50 text-danger", amber: "bg-warn-wash text-warn", green: "bg-wash text-accent-deep" }[tone];
  return <p role={tone === "red" ? "alert" : "status"} className={`break-words rounded-xl p-3 text-sm ${c}`}>{children}</p>;
}

export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Which data is on screen. Sandbox data is always labelled; real data is never labelled SANDBOX DATA. */
export function DataBadge({ mode }: { mode: "sandbox" | "google" | undefined }) {
  if (!mode) return null;
  return (
    <span className={`whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${mode === "sandbox" ? "border-warn/30 bg-warn-wash text-warn" : "border-accent/30 bg-wash text-accent-deep"}`}>
      {mode === "sandbox" ? "SANDBOX DATA" : "GOOGLE · LIVE DATA"}
    </span>
  );
}

/** Side sheet for everything that is one tap away. A native modal dialog: focus is trapped, Escape closes, focus returns. */
export function Drawer({ title, mode, onClose, children }: { title: string; mode?: "sandbox" | "google"; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current!;
    const opener = document.activeElement as HTMLElement | null;
    if (!d.open) d.showModal();
    return () => {
      d.close();
      opener?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="drawer overflow-y-auto p-0 shadow-2xl"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="min-h-full space-y-4 p-5 sm:p-7">
        <div className="flex items-center justify-between gap-3">
          <DataBadge mode={mode} />
          <button onClick={onClose} className="btn-quiet ml-auto" aria-label="Close details">Close</button>
        </div>
        <h2 id={titleId} className="font-display break-words text-2xl font-semibold">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

/** Brand mark: a ledger "M" over a ruled line. Pure SVG. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="Munshi logo">
      <rect width="32" height="32" rx="9" fill="#0f6b5c" />
      <path d="M9 20V10l7 6 7-6v10" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 25h14" stroke="#bfe0d6" strokeWidth="2" strokeLinecap="round" />
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
        <div key={i.id} role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-danger/40 bg-white p-3 text-sm text-danger shadow-lg">
          <span>{i.text}</span>
          <button onClick={() => setItems((x) => x.filter((y) => y.id !== i.id))} className="text-soft hover:text-ink" aria-label="Dismiss">✕</button>
        </div>
      ))}
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="flex items-center gap-2 p-6 text-sm text-soft" role="status">
      <span className="h-4 w-4 rounded-full border-2 border-line border-t-accent motion-safe:animate-spin" />
      {label}
    </p>
  );
}

/** Shown on every screen (incl. onboarding) in demo mode: outputs are scripted samples, not a live model. */
const BANNER_H = 24;
export function ReplayBanner({ health }: { health: { replay?: boolean; replayBanner?: string | null } | null }) {
  if (!health?.replay) return null;
  // Inline styles + fixed position: always visible, independent of page height, scrolling or generated CSS.
  // Wraps rather than truncates, so the disclosure is never cut off on a narrow screen.
  return (
    <>
      <div
        data-demo-bar
        role="status"
        style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 60, minHeight: BANNER_H, display: "grid", placeItems: "center", padding: "2px 8px", background: "#17302c", color: "#e9f2ef", textAlign: "center", fontSize: 11, lineHeight: "14px", fontWeight: 500 }}
      >
        {health.replayBanner ?? "DEMO MODE — scripted sample outputs, not live AI"}
      </div>
      <div aria-hidden style={{ height: BANNER_H }} />
    </>
  );
}
