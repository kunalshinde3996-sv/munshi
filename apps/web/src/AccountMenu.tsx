import { useEffect, useId, useRef, useState } from "react";

/** The account has only an email address, so the name and initials are derived from the part before the "@". */
const words = (email: string) => (email.split("@")[0] ?? "").split(/[._+-]+/).filter(Boolean);
export const displayName = (email: string) => words(email).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || email;
export const initials = (email: string) => words(email).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("") || "?";

export default function AccountMenu({ email, onSettings, onTrust, onSignOut }: {
  email: string;
  onSettings: () => void;
  onTrust: () => void;
  /** Rejects if the server did not end the session; the menu then says so and the user stays signed in. */
  onSignOut: () => Promise<void>;
}) {
  const [open, setOpen] = useState<false | "first" | "last">(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
  const close = (returnFocus: boolean) => {
    setOpen(false);
    setFailed(false);
    if (returnFocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const all = items();
    all[open === "last" ? all.length - 1 : 0]?.focus();
    const outside = (e: Event) => { if (!wrap.current?.contains(e.target as Node)) close(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(true); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") return close(false); // focus moves on naturally
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (at + 1) % all.length
      : e.key === "ArrowUp" ? (at - 1 + all.length) % all.length
      : e.key === "Home" ? 0
      : e.key === "End" ? all.length - 1
      : null;
    if (next !== null) {
      e.preventDefault();
      all[next]?.focus();
    }
  };

  const signOut = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await onSignOut(); // on success this whole shell unmounts
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  const item = "flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-medium hover:bg-mist focus-visible:bg-mist";
  return (
    <div ref={wrap} className="relative">
      <button
        ref={button}
        onClick={() => (open ? close(false) : setOpen("first"))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen("first"); }
          if (e.key === "ArrowUp") { e.preventDefault(); setOpen("last"); }
        }}
        aria-haspopup="menu"
        aria-expanded={Boolean(open)}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account: ${email}`}
        className="lift grid h-11 w-11 place-items-center rounded-full bg-accent text-sm font-semibold text-on-accent md:h-10 md:w-10"
      >
        {initials(email)}
      </button>
      {open && (
        <div className="card pop absolute right-0 top-[calc(100%+0.5rem)] z-40 w-64 max-w-[calc(100vw-2rem)] p-2 shadow-[var(--lift-shadow)]">
          <div className="px-3 pb-2 pt-1">
            <p className="break-words font-semibold">{displayName(email)}</p>
            <p className="break-all text-sm text-soft">{email}</p>
          </div>
          <div ref={menu} id={menuId} role="menu" aria-label="Account" onKeyDown={onMenuKey} className="border-t border-line pt-2">
            <button role="menuitem" tabIndex={-1} className={item} onClick={() => { close(false); onSettings(); }}>Settings</button>
            <button role="menuitem" tabIndex={-1} className={item} onClick={() => { close(false); onTrust(); }}>Trust</button>
            <div role="separator" className="my-2 border-t border-line" />
            <button role="menuitem" tabIndex={-1} className={`${item} text-danger`} aria-disabled={busy || undefined} onClick={() => void signOut()}>
              {busy && <span className="spinner" aria-hidden />}
              {busy ? "Signing out…" : "Sign out"}
            </button>
          </div>
          {failed && <p role="alert" className="px-3 pt-2 text-sm text-danger">Couldn't sign out. You're still signed in.</p>}
        </div>
      )}
    </div>
  );
}
