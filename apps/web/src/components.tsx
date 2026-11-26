import { useEffect, useId, useRef, useState } from "react";

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
  red: "bg-danger-wash text-danger",
  darkred: "bg-danger text-on-danger",
  stone: "bg-mist text-soft",
  blue: "bg-info-wash text-info",
} as const;

export function Chip({ tone, children, title }: { tone: keyof typeof TONES; children: React.ReactNode; title?: string }) {
  return <span title={title} className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${TONES[tone]}`}>{children}</span>;
}

export function Banner({ tone, children }: { tone: "red" | "amber" | "green"; children: React.ReactNode }) {
  const c = { red: "bg-danger-wash text-danger", amber: "bg-warn-wash text-warn", green: "bg-wash text-accent-deep" }[tone];
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
      <rect width="32" height="32" rx="9" fill="var(--color-accent)" />
      <path d="M9 20V10l7 6 7-6v10" fill="none" stroke="var(--color-on-accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 25h14" stroke="var(--color-on-accent)" strokeOpacity="0.6" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="flex items-center gap-2 p-6 text-sm text-soft" role="status">
      <span className="spinner text-accent" aria-hidden />
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
        style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 60, minHeight: BANNER_H, display: "grid", placeItems: "center", padding: "2px 8px", background: "var(--color-inverse)", color: "var(--color-on-inverse)", textAlign: "center", fontSize: 11, lineHeight: "14px", fontWeight: 500 }}
      >
        {health.replayBanner ?? "DEMO MODE — scripted sample outputs, not live AI"}
      </div>
      <div aria-hidden style={{ height: BANNER_H }} />
    </>
  );
}
