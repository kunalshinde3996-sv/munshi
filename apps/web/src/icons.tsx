// Original inline SVG icons and the "all caught up" illustration. Decorative: text next to them carries the meaning.
import type { ObligationType } from "./api";

const PATHS: Record<ObligationType | "shield", React.ReactNode> = {
  bill: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></>,
  deadline: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l3 2M9 2h6" /></>,
  renewal: <><path d="M20 11a8 8 0 0 0-14.5-4.5" /><path d="M5 3v4h4" /><path d="M4 13a8 8 0 0 0 14.500 4.500" /><path d="M19 21v-4h-4" /></>,
  refund: <><circle cx="12" cy="12" r="9" /><path d="M9 8h6M9 11h6M13 8c2 4-1 5-4 5l5 4" /></>,
  travel: <><rect x="5" y="3" width="14" height="14" rx="3" /><path d="M5 11h14M9 14h.01M15 14h.01M8 17l-2 4M16 17l2 4" /></>,
  appointment: <><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M4 10h16M8 3v4M16 3v4M9 15l2 2 4-4" /></>,
  other: <><circle cx="12" cy="12" r="9" /><path d="M8 12h.01M12 12h.01M16 12h.01" /></>,
  shield: <><path d="M12 3l8 3v6c0 5-3.500 8-8 9-4.500-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></>,
};

export function Icon({ name, size = 20 }: { name: ObligationType | "shield"; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      {PATHS[name]}
    </svg>
  );
}

/** A closed ledger and a cup of tea: the day's accounts are done. */
export function CaughtUpArt() {
  return (
    <svg width="168" height="104" viewBox="0 0 168 104" fill="none" aria-hidden focusable="false">
      <ellipse cx="84" cy="94" rx="76" ry="6" fill="#e3f0ec" />
      <rect x="22" y="62" width="78" height="14" rx="3" fill="#0f6b5c" />
      <rect x="28" y="65" width="72" height="8" fill="#ffffff" />
      <rect x="22" y="75" width="78" height="14" rx="3" fill="#17302c" />
      <path d="M36 62v14" stroke="#e3f0ec" strokeWidth="2" />
      <path d="M112 62h30v14a15 15 0 0 1-30 0z" fill="#ffffff" stroke="#17302c" strokeWidth="2" />
      <path d="M142 67h4a7 7 0 0 1 0 14h-6" stroke="#17302c" strokeWidth="2" />
      <path d="M121 52c-5-7 5-9 0-17M133 52c-5-7 5-9 0-17" stroke="#0f6b5c" strokeWidth="2" strokeLinecap="round" />
      <path d="M48 42l8 8 15-16" stroke="#0f6b5c" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
