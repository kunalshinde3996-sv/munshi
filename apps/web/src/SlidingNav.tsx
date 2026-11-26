import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type NavItem<T extends string> = { id: T; label: string; badge?: string };

/** A row of tabs with one pill that slides to the current one (position and width). */
export default function SlidingNav<T extends string>({ items, current, onSelect, label, tone, className = "" }: {
  items: readonly NavItem<T>[];
  current: T;
  onSelect: (id: T) => void;
  label: string;
  tone: "wash" | "ink";
  className?: string;
}) {
  const nav = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [ready, setReady] = useState(false); // the first placement must not slide in from the corner

  const measure = () => {
    const el = nav.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (el) setPill({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
  };
  useLayoutEffect(measure, [current]);
  useEffect(() => {
    if (pill && !ready) {
      const f = requestAnimationFrame(() => setReady(true));
      return () => cancelAnimationFrame(f);
    }
  }, [pill, ready]);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined" || !nav.current) return;
    const o = new ResizeObserver(measure);
    o.observe(nav.current);
    return () => o.disconnect();
  }, []);

  const active = tone === "ink" ? "text-panel" : "text-accent-deep";
  return (
    <nav ref={nav} aria-label={label} className={`relative flex ${className}`}>
      {pill && (
        <span aria-hidden className={`nav-pill ${tone === "ink" ? "bg-ink" : "bg-wash"}`} data-ready={ready}
          style={{ transform: `translate(${pill.x}px, ${pill.y}px)`, width: pill.w, height: pill.h }} />
      )}
      {items.map((t) => (
        <button
          key={t.id}
          onClick={() => onSelect(t.id)}
          aria-current={current === t.id ? "page" : undefined}
          aria-label={t.badge ? `${t.label}, ${t.badge}` : undefined}
          className={`relative z-10 min-h-11 whitespace-nowrap rounded-full px-2.5 text-sm font-semibold sm:px-4 md:min-h-9 ${current === t.id ? active : "text-soft hover:text-ink"}`}
        >
          {t.label}
          {t.badge && <span aria-hidden className="absolute right-0.5 top-2 h-2 w-2 rounded-full bg-warn md:top-1" />}
        </button>
      ))}
    </nav>
  );
}
