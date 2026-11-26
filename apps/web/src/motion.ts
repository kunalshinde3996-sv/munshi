// Small motion helpers. All movement is CSS; this file only decides when it happens and honours reduced motion.
import { useEffect, useRef, useState } from "react";

export const REDUCE_CLASS = "reduce-motion";
/** How long "✓ Approved" stays before the card folds away (information, so kept with reduced motion), and the fold. */
export const HOLD_MS = 600;
export const COLLAPSE_MS = 320;

export const motionOff = () => document.documentElement.classList.contains(REDUCE_CLASS);

/** Mirrors the OS "reduce motion" setting onto <html>, and follows it if it changes. */
export function useReducedMotionClass() {
  useEffect(() => {
    const q = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!q) return;
    const apply = () => void document.documentElement.classList.toggle(REDUCE_CLASS, q.matches);
    apply();
    q.addEventListener("change", apply);
    return () => q.removeEventListener("change", apply);
  }, []);
}

/** A ripple from the point of the click on primary buttons (from the centre for keyboard clicks). */
export function useRipple() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const b = (e.target as Element | null)?.closest?.<HTMLElement>(".btn-primary");
      if (!b || motionOff() || b.getAttribute("aria-disabled") === "true" || (b as HTMLButtonElement).disabled) return;
      const r = b.getBoundingClientRect();
      const size = Math.max(r.width, r.height) * 2;
      const keyboard = e.detail === 0;
      const dot = document.createElement("span");
      dot.className = "ripple";
      dot.setAttribute("aria-hidden", "true");
      dot.style.width = dot.style.height = `${size}px`;
      dot.style.left = `${(keyboard ? r.width / 2 : e.clientX - r.left) - size / 2}px`;
      dot.style.top = `${(keyboard ? r.height / 2 : e.clientY - r.top) - size / 2}px`;
      b.appendChild(dot);
      setTimeout(() => dot.remove(), 500);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
}

const entered = new Set<string>();
export const resetEntrances = () => entered.clear();

/**
 * "on" the first time a screen shows its content during this page load, so its .enter children stagger in once.
 * Polling, new rows and revisiting the screen do not replay it.
 */
export function useEntrance(id: string, ready = true): "on" | undefined {
  const [on, setOn] = useState(() => !entered.has(id));
  useEffect(() => {
    if (!ready || !on) return;
    const t = setTimeout(() => { entered.add(id); setOn(false); }, 1000);
    return () => clearTimeout(t);
  }, [ready, on, id]);
  return on ? "on" : undefined;
}

/** Stagger position, capped so long lists never wait more than about half a second. */
export const stagger = (i: number) => ({ "--i": Math.min(i, 8) }) as React.CSSProperties;

/** Eases the shown number towards the real one. Jumps straight there with reduced motion. */
export function useCountUp(target: number, ms = 450): number {
  const [shown, setShown] = useState(() => (typeof window === "undefined" || motionOff() ? target : 0));
  const from = useRef(shown);
  useEffect(() => {
    if (motionOff() || from.current === target) {
      from.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const value = Math.round(origin + (target - origin) * (1 - (1 - p) ** 3));
      from.current = value;
      setShown(value);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return shown;
}
