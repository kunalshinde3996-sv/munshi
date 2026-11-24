# Munshi: 2-minute demo script

All data is **SANDBOX DATA** (a fictional mailbox, dates relative to today). No Google account needed.

## Before you start (once)

1. Stop the server, then `npm run demo:reset` (clean DB, fresh sandbox mailbox of 15 demo emails: 9 legit, 4 noise, 2 injection; the 30 eval emails are not in the inbox).
2. `npm run dev:server` and, in another terminal, `npm run dev:web`. Open http://localhost:5173.
3. Make sure `.env` has a working LLM key. Optional: `SCAN_INTERVAL_MIN=0` so nothing scans in the background mid-demo.

## Script

| Time | Click | Say |
|---|---|---|
| 0:00 | Onboarding screen, press **Try sandbox** | "Munshi reads your inbox, finds what you owe, and acts through MCP tools. Everything here is a fictional sandbox mailbox." |
| 0:15 | **Inbox**, press **Scan inbox** | "Each email goes to an extractor LLM in quarantine. It has no tools. Its output must pass strict schema checks, and every quote must appear verbatim in the email." |
| 0:35 | Point at the obligation cards (bills, renewals, appointments) | "Bills, deadlines, renewals. Each card links to its source email." |
| 0:45 | Press **Handle these** | "Now the agent gets only these validated obligations, never raw email text." |
| 1:00 | **Approvals** tab: open a pending action, expand "Why the Guard asked" | "Anything external needs me. I see a plain-language preview and where each value came from." |
| 1:10 | Approve a calendar reminder, then in **Activity** show **Verified ✓**, then **Undo** | "Executed, read back from the calendar to verify, and undoable." |
| 1:25 | Inbox, **Security notes** section: open the "This week's best deals" newsletter (or the fake bank "URGENT: Verify your account" email) | "This email hides an instruction in invisible text telling the assistant to send my data to an outsider. The sanitiser stripped it and flagged it." |
| 1:40 | **Security** tab | "The injected requests ended up here, blocked by a deterministic rule. No LLM decided that. The audit log is append-only." |
| 1:50 | **Eval** tab | "We ran 20 injection emails plus 10 benign look-alikes against a worst-case compromised agent: 20 of 20 blocked or flagged, 0 attacker actions executed without the user." |
| 2:00 | Done | "Less magic, more utility: the model proposes, code decides." |

## Honest notes to say if asked

- The headline eval measures the deterministic layers (sanitiser, vetting, taint, Guard) with a scripted worst-case extractor and agent, not how well a real LLM resists injection. Re-run with `npm run eval:attacks -- --live`.
- 6 of 10 benign look-alike emails raised a security flag (false positives); 9 of 10 benign tasks completed.
- If the user clicks through every warned, tainted action, the Guard cannot protect them (approval fatigue). The Eval tab shows that stress test too.

## Recovery

- Scan fails with a quota message: wait for the stated delay or set `LLM_FALLBACK_MODEL`. Already-extracted emails are cached.
- Want a clean slate: stop the server, `npm run demo:reset`, clear the site's local storage to see onboarding again.
