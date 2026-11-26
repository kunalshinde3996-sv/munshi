// @vitest-environment jsdom
// Interactive behaviour in a DOM: sign out, the account menu, reduced motion and the locked Approve button.
// The server side of sign out (the old cookie gets 401) is covered by apps/server/test/auth.test.ts and the e2e run.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountMenu, { displayName, initials } from "./AccountMenu";
import App from "./App";
import ApprovalCard from "./ApprovalCard";
import type { Action } from "./api";
import { motionOff, useReducedMotionClass, useRipple } from "./motion";
import { decisionOutcome } from "./plain";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.documentElement.className = "";
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const render = (el: React.ReactNode) => act(async () => root.render(el));
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const press = (el: Element, key: string) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
const button = (name: string | RegExp) => {
  const found = [...document.querySelectorAll("button")].find((b) => {
    const label = b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "";
    return typeof name === "string" ? label === name : name.test(label);
  });
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
const items = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const focused = () => document.activeElement?.textContent;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A stand-in for the API with real session semantics: after a successful logout every protected call is a 401. */
function fakeApi(opts: { logoutStatus?: number } = {}) {
  let signedIn = true;
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url === "/api/health") return json({ ok: true, mode: "sandbox", replay: true, llmConfigured: true, agentAvailable: true, demoLogin: true, holdSeconds: 60 });
    if (url === "/api/auth/logout") {
      if (opts.logoutStatus) return json({ error: "boom" }, opts.logoutStatus);
      signedIn = false;
      return json({ ok: true });
    }
    if (!signedIn) return json({ error: "Not signed in" }, 401);
    if (url === "/api/auth/me") return json({ user: { email: "demo@munshi.local" } });
    return json({ actions: [], obligations: [], emails: [], nudges: [], policies: [], contacts: [], setup: [], missing: [], setupSteps: [], configured: false, linked: false, connected: false, mode: "sandbox", enabled: false, intervalMin: 0, running: false, lastError: null });
  }));
  return { calls };
}

async function openApp() {
  localStorage.setItem("munshi.onboarded.demo@munshi.local", "1");
  await render(<App />);
  await flush();
  await flush();
}

describe("sign out", () => {
  it("calls the logout API, shows the signed-out screen, then the login page, and the API answers 401", async () => {
    const { calls } = fakeApi();
    await openApp();
    await click(button("Account: demo@munshi.local"));
    await click(items().find((i) => i.textContent === "Sign out")!);
    expect(calls).toContain("POST /api/auth/logout");
    expect(document.body.textContent).toContain("You're signed out");
    expect(document.querySelector('nav[aria-label="Main"]')).toBeNull(); // the whole shell and its state are gone
    expect((await fetch("/api/actions")).status).toBe(401);
    await click(button("Sign in again"));
    expect(document.body.textContent).toContain("Sign in to Munshi");
  });

  it("stays signed in, and says so, if the server did not end the session", async () => {
    fakeApi({ logoutStatus: 500 });
    await openApp();
    await click(button("Account: demo@munshi.local"));
    await click(items().find((i) => i.textContent === "Sign out")!);
    expect(document.body.textContent).toContain("Couldn't sign out. You're still signed in.");
    expect(document.body.textContent).not.toContain("You're signed out");
    expect(document.querySelector('nav[aria-label="Main"]')).not.toBeNull();
  });

  it("is also offered in Settings, in the Account panel", async () => {
    const { calls } = fakeApi();
    await openApp();
    await click(button("Settings"));
    expect(document.querySelector('section[aria-label="Account"]')!.contains(button("Sign out"))).toBe(true);
    await click(button("Sign out"));
    expect(calls).toContain("POST /api/auth/logout");
    expect(document.body.textContent).toContain("You're signed out");
  });
});

describe("settings layout", () => {
  const names = (root: ParentNode) => [...root.querySelectorAll(":scope > section")].map((s) => s.getAttribute("aria-label"));

  it("puts Account on top, then two columns in reading and focus order", async () => {
    fakeApi();
    await openApp();
    await click(button("Settings"));
    const all = [...document.querySelectorAll("main section[aria-label]")].map((s) => s.getAttribute("aria-label"));
    expect(all.slice(0, 5)).toEqual(["Account", "Mailbox", "Policies", "Contacts", "Notifications"]);
    expect(names(document.querySelector('[data-column="left"]')!)).toEqual(["Mailbox", "Policies"]);
    expect(names(document.querySelector('[data-column="right"]')!)).toEqual(["Contacts", "Notifications"]);
    const grid = document.querySelector('[data-column="left"]')!.parentElement!;
    expect(grid.className).toContain("items-start");
    expect(grid.className).toContain("md:grid-cols-2");
  });
  it("shows who is signed in, with initials and a status line", async () => {
    fakeApi();
    await openApp();
    await click(button("Settings"));
    const account = document.querySelector('section[aria-label="Account"]')!;
    expect(account.textContent).toContain("Signed in as demo@munshi.local");
    expect(account.textContent).toContain("AI: demo, scripted. Server: ok.");
    expect(account.querySelector("[aria-hidden]")!.textContent).toBe("D");
  });
});

describe("account menu", () => {
  const menu = (onSignOut = async () => undefined) => {
    const spies = { onSettings: vi.fn(), onTrust: vi.fn(), onSignOut: vi.fn(onSignOut) };
    return { spies, el: <><AccountMenu email="asha.rao@example.com" {...spies} /><button>outside</button></> };
  };
  const avatar = () => button("Account: asha.rao@example.com");

  it("derives initials and a name from the email", () => {
    expect(initials("asha.rao@example.com")).toBe("AR");
    expect(initials("demo@munshi.local")).toBe("D");
    expect(displayName("asha.rao@example.com")).toBe("Asha Rao");
  });
  it("lists name, email, Settings, Trust, a divider and Sign out", async () => {
    await render(menu().el);
    await click(avatar());
    expect(document.body.textContent).toContain("Asha Rao");
    expect(document.body.textContent).toContain("asha.rao@example.com");
    expect(items().map((i) => i.textContent)).toEqual(["Settings", "Trust", "Sign out"]);
    expect(document.querySelector('[role="separator"]')).not.toBeNull();
    expect(items()[2]!.className).toContain("text-danger");
    expect(avatar().getAttribute("aria-expanded")).toBe("true");
  });
  it("moves with arrows, Home and End, wrapping at both ends", async () => {
    await render(menu().el);
    await click(avatar());
    expect(focused()).toBe("Settings");
    const list = document.querySelector('[role="menu"]')!;
    await press(list, "ArrowDown");
    expect(focused()).toBe("Trust");
    await press(list, "End");
    expect(focused()).toBe("Sign out");
    await press(list, "ArrowDown");
    expect(focused()).toBe("Settings");
    await press(list, "ArrowUp");
    expect(focused()).toBe("Sign out");
    await press(list, "Home");
    expect(focused()).toBe("Settings");
  });
  it("opens from the keyboard on the first or last item", async () => {
    await render(menu().el);
    await press(avatar(), "ArrowUp");
    expect(focused()).toBe("Sign out");
  });
  it("closes on Escape and returns focus to the avatar", async () => {
    await render(menu().el);
    await click(avatar());
    await press(document.activeElement!, "Escape");
    expect(items()).toHaveLength(0);
    expect(document.activeElement).toBe(avatar());
  });
  it("closes on an outside click and on Tab", async () => {
    await render(menu().el);
    await click(avatar());
    await act(async () => { button("outside").dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    expect(items()).toHaveLength(0);
    await click(avatar());
    await press(document.querySelector('[role="menu"]')!, "Tab");
    expect(items()).toHaveLength(0);
  });
  it("runs the chosen item", async () => {
    const { spies, el } = menu();
    await render(el);
    await click(avatar());
    await click(items()[1]!);
    expect(spies.onTrust).toHaveBeenCalledOnce();
    expect(items()).toHaveLength(0);
  });
});

describe("reduced motion", () => {
  function Probe() {
    useReducedMotionClass();
    useRipple();
    return <button className="btn-primary">Go</button>;
  }
  const media = (matches: boolean) => {
    let listener: () => void = () => undefined;
    const q = { matches, addEventListener: (_: string, f: () => void) => { listener = f; }, removeEventListener: () => undefined };
    vi.stubGlobal("matchMedia", () => q);
    window.matchMedia = () => q as unknown as MediaQueryList;
    return (next: boolean) => act(async () => { q.matches = next; listener(); });
  };

  it("sets the reduce-motion class from the OS setting and follows changes", async () => {
    const change = media(true);
    await render(<Probe />);
    expect(document.documentElement.classList.contains("reduce-motion")).toBe(true);
    await change(false);
    expect(motionOff()).toBe(false);
    await change(true);
    expect(motionOff()).toBe(true);
  });
  it("adds a ripple only when motion is allowed", async () => {
    const change = media(false);
    await render(<Probe />);
    await click(button("Go"));
    expect(button("Go").querySelector(".ripple")).not.toBeNull();
    button("Go").querySelector(".ripple")!.remove();
    await change(true);
    await click(button("Go"));
    expect(button("Go").querySelector(".ripple")).toBeNull();
  });
});

const draft: Action = {
  id: "act-1", runId: "r", obligationId: null, tool: "create_draft", tier: "R1", args: { to: ["x@y.example"], subject: "s", body: "b" },
  tainted: true, decision: "require_approval", reason: "r", rule: "g", status: "pending_approval", preview: "p", warnings: [],
  taint: [{ arg: "to", value: "x@y.example", trusted: false, allowlisted: false, explanation: "e", origins: [{ emailId: "e1" }] }],
  holdUntil: null, result: null, verify: null, createdAt: 0, canUndo: false, undoHint: null,
};

describe("approval card", () => {
  const setup = async (respond: () => Response) => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { bodies.push(`${url} ${String(init?.body)}`); return respond(); }));
    const spies = { onPin: vi.fn(), onDecided: vi.fn(), onFailed: vi.fn(), onGone: vi.fn(), onDetails: vi.fn() };
    await render(<ApprovalCard a={draft} obligation={undefined} emails={[]} holdSeconds={60} {...spies} />);
    return { spies, bodies };
  };
  const done = () => json({ action: { ...draft, status: "verified", canUndo: true, undoHint: "Undo" } });
  const tick = () => click(document.querySelector('input[type="checkbox"]')!);

  it("shakes and stays locked: clicking or pressing A sends nothing", async () => {
    const { spies, bodies } = await setup(done);
    expect(button("Approve").getAttribute("aria-disabled")).toBe("true");
    await click(button("Approve"));
    await press(document.querySelector("article")!, "a");
    expect(bodies).toEqual([]);
    expect(spies.onPin).not.toHaveBeenCalled();
    expect(button("Approve").className).toContain("shake");
    expect(document.body.textContent).toContain("Tick the box first.");
  });
  it("after the tick, approves with the acknowledgement, shows ✓ Approved, then folds away", async () => {
    const { spies, bodies } = await setup(done);
    await tick();
    expect(button("Approve").hasAttribute("aria-disabled")).toBe(false);
    await click(button("Approve"));
    expect(bodies).toEqual(['/api/actions/act-1/approve {"acknowledgeTaint":true}']);
    expect(spies.onDecided).toHaveBeenCalledWith("approve", expect.objectContaining({ status: "verified" }));
    expect(document.body.textContent).toContain("✓ Approved");
    expect(spies.onGone).not.toHaveBeenCalled();
    await act(async () => { await new Promise((r) => setTimeout(r, 1000)); });
    expect(document.querySelector(".collapsible")!.getAttribute("data-collapsed")).toBe("true");
    expect(spies.onGone).toHaveBeenCalledWith("act-1");
  });
  it("never shows ✓ when the request fails; the card stays", async () => {
    const { spies } = await setup(() => json({ error: "nope" }, 500));
    await tick();
    await click(button("Approve"));
    expect(spies.onFailed).toHaveBeenCalledWith("act-1");
    expect(spies.onDecided).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("nope");
    expect(document.body.textContent).not.toContain("✓ Approved");
  });
});

describe("outcome of a decision", () => {
  const result = (status: string, canUndo: boolean, undoHint: string | null = canUndo ? "Undo" : null): Action => ({ ...draft, status, canUndo, undoHint });
  it("offers Undo only where a real one exists", () => {
    expect(decisionOutcome("approve", result("verified", true)).undo).toEqual({ kind: "server", label: "Undo" });
    expect(decisionOutcome("approve", result("held", true, "Cancel send")).undo).toEqual({ kind: "server", label: "Cancel send" });
    expect(decisionOutcome("approve", result("verified", false, "Already sent; can't be undone")).undo).toBeNull();
    expect(decisionOutcome("reject", result("rejected", false)).undo).toBeNull();
    expect(decisionOutcome("snooze", draft).undo?.kind).toBe("unsnooze");
  });
  it("does not claim success when the action failed", () => {
    for (const status of ["failed", "verification_failed"]) {
      const o = decisionOutcome("approve", result(status, false));
      expect(o.ok).toBe(false);
      expect(o.button).not.toContain("✓");
    }
  });
});
