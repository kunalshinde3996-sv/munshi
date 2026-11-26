# Munshi: 2-minute demo script

All data is **SANDBOX DATA** (a fictional mailbox, dates relative to today). No Google account needed.

## Before you start (once)

1. Stop the server, then `npm run demo:reset` (clean DB, fresh sandbox mailbox of 15 demo emails: 9 legit, 4 noise, 2 injection; the 30 eval emails are not in the inbox).
2. `npm run dev:server` and, in another terminal, `npm run dev:web`. Open http://localhost:5173.
3. `.env` needs `DEMO_USER_EMAIL` and `DEMO_USER_PASSWORD` (the example file has them). The default `LLM_PROVIDER=replay` needs no key; for live AI use a working LLM key. Optional: `SCAN_INTERVAL_MIN=0` so nothing scans in the background mid-demo.

## Script

| Time | Click | Say |
|---|---|---|
| 0:00 | Press **Use demo account** (or sign in with the demo login from `.env`), then **Try sandbox** | "Opening Munshi should feel lighter than opening your inbox. Everything here is a fictional sandbox mailbox." |
| 0:15 | **Today**, press **Scan inbox** | "Each email goes to an extractor LLM in quarantine. It has no tools. Its output must pass strict schema checks, and every quote must appear verbatim in the email." |
| 0:30 | In **Coming up**, tap the BESCOM bill, show the quote, press **Close** | "One line per thing I owe. The proof is one tap away." |
| 0:40 | Press **Let Munshi handle it** | "The agent gets only validated obligations, never raw email text. The headline now answers two questions: what needs me, and what is handled." |
| 0:55 | On the draft card, point at the locked **Approve**, press **Why?**, then **Close** | "This address came from an email, not from me. The explanation and the exact rule are right here." |
| 1:10 | Tick **I checked this address**, press **Approve**. On the other card press **Approve** | "Anything doubtful needs my yes. Executed, then read back to verify." |
| 1:20 | Open **Handled**, press **Undo** on one reminder | "Everything else stayed out of my way, and it is undoable." |
| 1:30 | Press the shield chip **2 suspicious emails blocked** | "That opens Trust. Two emails tried to give the assistant orders." |
| 1:40 | In **Security**, on "This week's best deals" press **Show what it tried** | "This one hid an instruction in invisible text. The sanitiser stripped it and flagged it." |
| 1:45 | Top navigation, **Audit log**; open **Raw** on one row | "Every step is here in plain words, newest first, with the raw record underneath. It is append-only: the database refuses edits and deletes." |
| 1:50 | **Trust**, then **Eval** | "20 injection emails plus 10 benign look-alikes against a worst-case compromised agent: 20 of 20 blocked or flagged, 0 attacker actions executed without the user." |
| 2:00 | Done | "Less magic, more utility: the model proposes, code decides." |

If judges ask for more: **Details** on any card in Trust shows the rule id, tool, tier and exact arguments. **Trust, Activity** has the run step by step, and **Trust, Policies** lists the rules with their ids. Rules are edited in **Settings** (plain-language drafting needs a live LLM).

## Honest notes to say if asked

- The headline eval measures the deterministic layers (sanitiser, vetting, taint, Guard) with a scripted worst-case extractor and agent, not how well a real LLM resists injection. Re-run with `npm run eval:attacks -- --live`.
- 1 of 10 benign look-alike emails raised a security flag (a false positive); 10 of 10 benign tasks completed. The rules were tuned on these same fixtures.
- If the user clicks through every warned, tainted action, the Guard cannot protect them (approval fatigue). The Eval view shows that stress test too.

## Recovery

- Scan fails with a quota message: wait for the stated delay or set `LLM_FALLBACK_MODEL`. Already-extracted emails are cached.
- Want a clean slate: stop the server, `npm run demo:reset`, clear the site's local storage to see onboarding again.
