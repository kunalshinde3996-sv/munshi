// Bottom toasts: short confirmations (with a real undo where one exists) and failed-write errors.
import { useEffect, useState } from "react";
import { onErrorToast } from "./api";

export const TOAST_MS = 5000;
const ERROR_MS = 6000;

export type Toast = { text: string; tone?: "ok" | "error"; action?: { label: string; run: () => void } };
type Item = Toast & { id: number };

const listeners = new Set<(t: Toast) => void>();
export const notify = (t: Toast) => listeners.forEach((f) => f(t));

function ToastItem({ t, onDismiss }: { t: Item; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false); // hovering or focusing it holds it open, so the action is reachable
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(onDismiss, t.tone === "error" ? ERROR_MS : TOAST_MS);
    return () => clearTimeout(timer);
  }, [paused]); // eslint-disable-line react-hooks/exhaustive-deps
  const error = t.tone === "error";
  return (
    <div
      role={error ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}
      className={`toast pointer-events-auto flex items-center gap-3 rounded-2xl border p-3 pl-4 text-sm shadow-lg ${error ? "border-danger bg-panel text-danger" : "border-transparent bg-inverse text-on-inverse"}`}
    >
      <span className="min-w-0 flex-1 break-words">{t.text}</span>
      {t.action && (
        <button onClick={() => { onDismiss(); t.action!.run(); }} className="min-h-9 shrink-0 rounded-full border border-current px-3 font-semibold">{t.action.label}</button>
      )}
      <button onClick={onDismiss} className="min-h-9 min-w-9 shrink-0 rounded-full" aria-label="Dismiss">✕</button>
    </div>
  );
}

export function Toaster() {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    let n = 0;
    const add = (t: Toast) => setItems((x) => [...x.slice(-2), { ...t, id: ++n }]);
    listeners.add(add);
    const off = onErrorToast((text) => add({ text, tone: "error" }));
    return () => { listeners.delete(add); off(); };
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 mx-auto flex w-full max-w-md flex-col gap-2 p-3">
      {items.map((t) => <ToastItem key={t.id} t={t} onDismiss={() => setItems((x) => x.filter((i) => i.id !== t.id))} />)}
    </div>
  );
}
