# Munshi — project context for Claude sessions

Hackathon prototype, track "Make MCP Matter — Less Magic, More Utility".
Munshi reads a user's inbox, extracts life-admin obligations (bills, deadlines, renewals,
refunds, appointments, tickets) and acts through MCP tools. **Every action passes through a
deterministic Guard** (policy, provenance, preview, verify, undo). Security decisions are made by
code, never by an LLM.

## Non-negotiables
- No fake features, no hardcoded "AI outputs". Every UI button works.
- Sandbox data must be visibly labeled **SANDBOX DATA** everywhere it appears.
- Work milestone by milestone: typecheck + tests green, commit, summarize, then continue.
- If an SDK detail is uncertain, read the installed package's types — don't guess.
- Model ids come from env (`LLM_PROVIDER`, `LLM_MODEL`); never hardcode.

## Stack
TypeScript, Node 20+, npm workspaces. SQLite + Drizzle, zod, vitest.
- `apps/server` — Fastify API, agent runtime, Guard, MCP client, LLM adapters.
- `apps/web` — Vite + React + Tailwind.
- `packages/mcp-gmail`, `packages/mcp-calendar` — our own MCP servers (`@modelcontextprotocol/sdk`),
  spawned by the server as stdio child processes. Each has `SandboxBackend` (JSON fixtures) and
  `GoogleBackend` behind one interface; mode is a per-user setting `sandbox | google`.

## Architecture
1. **Quarantined extraction (dual-LLM).** Raw email bodies are UNTRUSTED and are read only by the
   Extractor LLM call, which has NO tools and returns strict zod-validated JSON (`Obligation`).
   Invalid → retry once → mark email `extraction_failed` (shown in UI). The tool-using Agent LLM sees
   only validated Obligations, wrapped as untrusted data — never raw bodies.
2. **Provenance store.** Every value that may become a tool arg is recorded with its origin.
   TRUSTED: user's typed message, user's own address, contacts allowlist, user policies.
   UNTRUSTED: email content/headers from external senders, extractor output.
3. **Guard pipeline** (runs on every proposed tool call):
   a. zod arg validation → b. risk tier → c. provenance check on `sensitiveArgs` (untraceable → TAINTED,
   forced approval or block) → d. policy engine (JSON rules: allow / require_approval / block) →
   e. human-readable preview → f. idempotency hash(tool+normalized args+obligationId) →
   g. execute → verify via verifyTool → h. append-only audit log for every step → i. undo.
4. **Agent runtime.** Agent LLM gets goal + Obligations + MCP tool list; max 8 steps; approval-pending
   calls pause the run and resume after the user decides; full trace stored per run.

## Risk tiers
| Tier | Meaning | Default handling |
|------|---------|------------------|
| R0 | read-only | auto-allow |
| R1 | reversible write (create_event, create_draft, add_label) | auto-allow if policy permits, else approval; always undoable |
| R2 | externally visible (send_email) | approval required; executes via hold window (default 60s), cancel = undo |
| R3 | destructive/financial | BLOCKED in prototype |

## MCP tool metadata
Every tool declares: `riskTier`, `reversible`, `undoTool?`, `verifyTool?`, `sensitiveArgs` (e.g. to, cc, attendees).
- mcp-gmail: list_recent_emails, get_email, get_draft, create_draft, add_label, send_email
- mcp-calendar: list_events, get_event, create_event
- Undo-only tools (`agentCallable: false`, Guard-internal, only on artifacts the Guard created):
  delete_draft (R3), remove_label (R1), delete_event (R3). Agent must never be offered these.
- Single source of truth for metadata: `packages/mcp-common/src/meta.ts` (TOOL_META). Servers advertise it in
  tools/list `_meta.munshi`; `GET /api/debug/mcp/tools` shows registry vs advertised and flags drift.
- Sandbox state persists in JSON files under SANDBOX_STORE_DIR (shared by stdio children). Fixture dates are
  generated relative to today; user writes (drafts, sent, labels, events) are layered on top.
- MCP servers are spawned cross-platform: `process.execPath --import <tsx loader URL> <entry.ts>` (apps/server/src/mcp/hub.ts).

## Extraction pipeline (M3)
- `extraction/sanitize.ts`: deterministic; strips hidden content (display:none, zero font, white text, comments,
  zero-width chars), REPORTS it ("hidden content detected"), flags injection phrasing. Flag-only; never relied on for security.
- `extraction/extractor.ts`: Extractor LLM (text-in/text-out adapter, no tool surface). Structural errors → retry once →
  `extraction_failed` (stored + shown). Then `vetObligations`: rejects (visibly, in `security_flags_json`) any obligation whose
  fields hold an address/URL/instruction-like text, whose evidence quote is not verbatim in the sanitized email, or comes from a flagged injection line.
- Fatal LLM errors (401/403/404/400) abort the scan; other errors fail only that email.
- LLM calls (`llm/types.ts`): 30s AbortController timeout; 3 attempts with exponential backoff on 503/timeout/transient network errors
  (fetch failed, ECONNRESET, ETIMEDOUT). A 429 is NEVER retried in place: its server `retryDelay` is parsed, honoured (if <= 60s), then the
  call moves to `LLM_FALLBACK_MODEL` exactly once (no fallback configured -> one retry on the same model). A hint > 60s (daily quota) puts that model on cooldown; if all models are cooling down the call fails fast with a fatal error so a scan aborts with the reason instead of burning requests. All calls are paced by a shared
  `LLM_RPM` budget (default 8, 0 = off). The answering model is logged (`[llm] answered by ...`).
- Extraction cache: `emails.content_hash` = sha256(model, sender, subject, sanitized body) + `extraction_model`. A scan skips emails whose
  status is `done` and hash matches; failed ones are retried; "Re-scan all" (`force`) ignores the cache.
- LLM adapters use plain fetch (Gemini generateContent, Anthropic messages); mock LLM exists only in tests.
- `npm run extract:live` runs the real configured LLM over all sandbox emails and prints a table (in-memory DB).

## Guard (M4) — apps/server/src/guard
- `Guard.evaluate(call)` is pure/deterministic: tool known → agentCallable → not R3 → strict zod args → obligation exists →
  provenance of sensitiveArgs → idempotency → policies (most restrictive wins) → hard invariants.
  `Guard.propose` also writes the actions ledger + audit log.
- Hard invariants (hold even if all policies are deleted): R2 always needs approval; tainted never auto-allowed; tainted R2 to a
  non-allowlisted recipient is blocked; R3 / undo-only tools are never agent-callable.
- Taint: a value is trusted iff typed by the user in this run's goal, or is the user's own address, or is a contact that no email introduced.
  Allowlisted = own address or contact. "Tainted + allowlisted" = a contact whose address an email introduced → approval with red warning.
- `provenance` table: untrusted rows written at scan (sender + addresses in email content, hidden flag); run-scoped trusted rows for goal text.
- `Guard.authorizeUndo(tool,args)`: only undo-only tools, only for artifacts whose ledger row (executed/verified) proves Munshi created them.
- `audit_log` is append-only via SQLite triggers (migration 0003); only `audit.ts` inserts.
- Tool arg schemas live in `mcp-common/src/schemas.ts` (shared by MCP servers and Guard).

## Agent runtime (M5) — apps/server/src/agent, llm/agent.ts
- Tool-calling adapters (`AgentLlm`: Gemini, Anthropic) are separate from the text-only extractor `LlmAdapter`.
- Agent sees: goal + vetted obligations (in `<untrusted_obligations>`, incl. `senderAddress`) + WRITE tools only (R1/R2, agentCallable,
  not returnsUntrusted). It has no read tools, so raw email text never reaches it. `obligationId` is injected into each tool schema and
  stripped before the Guard. Tool results fed back to the model are generic (no email-derived text).
- `AgentRuntime`: max 8 steps; every call → `Guard.propose`; allow → `ActionExecutor.executeApproved`; require_approval → run pauses
  (`awaiting_approval`, conversation in `agent_runs.state_json`); `onActionSettled` resumes it. `recover()` resumes/fails runs after restart.
- `ActionExecutor`: approve (tainted needs `acknowledgeTaint`) / reject / execute → verify (`verify.ts` reads back via get_* and compares) / undo
  (via `Guard.authorizeUndo` + read-back). send_email → status `held` with `holdUntil`; `releaseDueHolds` (1s scheduler, also on startup) sends only after
  the window; undo during hold = cancel. All state is in the `actions` ledger.
- API: /api/runs, /api/runs/:id, /api/actions(+approve/reject/undo), /api/audit, /api/policies, /api/contacts.

## Google (M6)
- OAuth (googleapis), scopes: gmail.readonly, gmail.compose, gmail.modify, calendar.events. Redirect: http://localhost:8787/auth/google/callback.
- Refresh token stored AES-256-GCM encrypted (`google/crypto.ts`, key TOKEN_ENCRYPTION_KEY). The MCP child processes receive the refresh token
  via env at spawn (they refresh access tokens themselves). Not configured → status shows missing env vars + setup steps; sandbox unaffected.
- `GoogleConnection` owns OAuth state (CSRF nonce), token storage, per-user mode (`users.mode`); switching restarts the MCP children
  (`McpHub.reconnect`), is refused while runs/approvals/holds are open, and moves the trusted own-address (`users.email`).
- Google backends: Gmail limited to last 14 days / max 30 emails; HTML body preferred (hidden-text detection); header-injection-safe MIME;
  calendar events created with sendUpdates:none. Revoked/insufficient grant → `GOOGLE_AUTH:` tool error → 401 `google_auth` + UI reconnect banner.
- mcp-common/mcp-gmail/mcp-calendar import googleapis only via the `/google` subpath (lazy), keeping sandbox children fast.
- Data views are filtered by `emails.source` = current mode; real data is never labelled SANDBOX DATA.

## Demo readiness (M7)
- `npm run demo:reset` (stop server first): deletes DB + sandbox store, recreates schema/default policies.
- `npm run e2e` / `test/e2e.test.ts`: offline scenario via the real Fastify routes + Guard + MCP + SQLite; only the two LLM calls are scripted mocks.
- `GET /api/security` + Security page: every blocked/tainted action with rule + source email, suspicious emails, audit log.
- API hardening in app.ts: Origin allowlist for non-GET, Host must be localhost (CSRF / DNS rebinding).
- README.md: setup, demo, mermaid diagram, threat model, honest known-gaps list.

## Telegram + nudges (Phase 2, C1) - apps/server/src/telegram, nudges.ts
- `TelegramApi`: plain-fetch Bot API client, long polling (`getUpdates`), no webhook. Plain-text messages only (email-derived text can't inject formatting). Token never logged.
- `TelegramChannel`: only `TELEGRAM_CHAT_ID` can act; other chats get only their chat id from `/start`. Approval requests (preview + provenance warning + Approve/Reject buttons) are sent once
  (`notifications` table dedupes). Decisions call `ActionExecutor.approve/reject(..., {channel:"telegram"})`: same Guard path, audit detail records the channel.
  Tainted: first tap shows a warning + "Confirm anyway" (nothing approved); only the second tap passes `acknowledgeTaint`.
- Nudges: `syncNudges` creates a `notifications(kind=nudge)` row for each obligation due within 48h with no pending/approved/held/executed/verified action; delivered once to Telegram, marked "Not handled yet" in Today's Coming up list (`GET /api/nudges`).
- No token -> `GET /api/telegram` = `{configured:false}` + setup steps; UI shows "Not configured"; nothing else changes.

## Plain-language policies (Phase 2, C2) - guard/policy-compile.ts
- `POST /api/policies/compile {text}` -> LLM (tool-less text adapter, sees only the user's typed sentence + tool/arg list) -> strict `PolicyRule` zod + real-tool/real-arg checks
  (retry once) -> **draft** with a deterministic readback (`describeRule`, code not LLM) + warnings. Nothing is saved. Rule id is server-assigned (`user-xxxxxx`).
- Only `POST /api/policies/compile/:draftId/confirm` (single-use, 15 min TTL, saves the exact stored rule) activates it. Audit events `policy_proposed` / `policy_confirmed`.
- Invalid compile -> 422 with a clear message; the built-in Guard invariants are unaffected by any rule.

## Proactive scheduler (Phase 2, C3) - scheduler.ts
- `ScanScheduler` (index.ts only; never built in tests): every `SCAN_INTERVAL_MIN` minutes (default 30, 0 = off) runs `scanInbox` (same LLM pacing + extraction cache) then `syncNudges`.
  It never starts an agent run and never executes or proposes an action, so R2 stays user-only. Overlapping passes are skipped; `scanInbox` calls on one DB are serialized.
  Errors (incl. all-models-over-quota) are recorded and retried next interval. `GET /api/scheduler` shows status; Settings shows a status line and Today shows the last error.

## Demo polish (Phase 2, D) - apps/web
- `Onboarding.tsx`: first-run screen (3 points + "Try sandbox", switches mode to sandbox if needed); flag in localStorage `munshi.onboarded`.
- `components.tsx`: `Logo`, `Toaster` (fed by `onErrorToast` in api.ts: every failed write request, incl. server-unreachable), `Spinner`, `Drawer` (native modal dialog), `DataBadge` (SANDBOX DATA).
- Nav is Today / Trust (Security, Activity, read-only Policies, Eval) / Settings (mailbox, policy editing, contacts, Telegram, account).
- UI rules: main screens use plain language (`plain.ts`, unit-tested); tool names, tiers and rule ids appear only in drawers, collapsed details and Trust. Approval sentences are built from the exact args and always show every recipient. Tainted Approve stays locked until the checkbox. A/R act only on the focused card. "Not now" is client-only. "Blocked" is said only for flagged emails that yielded no obligations. Pending, held, failed and verification_failed actions are never collapsed away.
- Trust: `ActionRecord.tsx` is the one shape for an action (title, at most one short flag, final status via `finalStatus`; the full record in Details, also used by the Today drawer). The provenance text appears once (`reasonWithoutProvenance`). The audit log is collapsed and renders `auditSentence` per entry with raw JSON behind it; new audit events or detail shapes need a sentence there.
- Text Munshi writes uses ₹. Sandbox email text and verbatim evidence quotes keep the sender's "Rs" (quotes must match the email exactly).
- The default sandbox inbox is the 15 demo emails (9 legit, 4 noise, 2 injection). The 30 eval emails (fixtures/attacks) are added only if `SANDBOX_ATTACK_EMAILS=true` (default false); `eval:attacks` and the Eval view data always use them regardless. `npm run demo:reset` reports which mailbox you get. `docs/DEMO_SCRIPT.md` = 2-minute click-by-click.

## FP tuning + live checks
- Sanitizer: every hidden finding is removed and reported, but only `suspicious` ones (instruction verbs, address/URL, injection phrasing, >=5 invisible chars) count as security flags (UI chips, /api/security, eval). Exfiltration phrasing needs an address/URL on the same line for whole-email flagging; extractor output fields (title/counterparty) still reject the address-free wording (`detectInstructionLike`).
- Eval after tuning: benign FP 1/10 (was 6/10), attacks 20/20 blocked-or-flagged, 0 executed. Numbers are generated into docs/eval-results.md.
- `npm run agent:live` (scripts/agent-live.ts): real LLM for extraction AND agent, sandbox, in-memory DB, never approves anything. `npm run check:sqlite`: native binding load test.

## Replay provider
- `LLM_PROVIDER=replay` (llm/replay.ts, fixtures/replay/recording.json): ReplayLlm (extractor, keyed by sender address) + ReplayAgent (first step proposes the recorded plan per obligation, later steps summarise). No key, no model id, no network. `{{date:N}}` placeholders keep dates relative to today. Unknown senders get `{"obligations":[]}`.
- The recording is AUTHORED to match the sandbox fixtures, not captured from a live model. Its output goes through the same schema check, vetting and Guard as live output.
- `/api/health` returns `replay` + `replayBanner`; the web app shows a sticky "DEMO MODE — scripted sample outputs, not live AI" banner on every screen incl. onboarding. Switching to Google mode is refused while replaying. Telegram messages carry no replay marker (Telegram is optional and off by default).

## Authentication (auth.ts, app.ts)
- Single user, no registration/reset. `seedDemoUser` (index.ts) creates/refreshes the login from `DEMO_USER_EMAIL`/`DEMO_USER_PASSWORD`; tables `auth_users` (scrypt hash) and `sessions` (sha256(token), 12h expiry). `users` stays the mailbox owner (trusted own-address provenance).
- `POST /api/auth/login` (rate limit 5/min per IP, 429) sets httpOnly SameSite=Strict cookie `munshi_session`; `/logout` deletes the session; `/me`. An onRequest hook returns 401 `{error:"Not signed in"}` for all `/api/*` and `/auth/google/start` except health/login/logout; `/auth/google/callback` is exempt (own CSRF nonce). Origin/Host check runs first.
- `POST /api/auth/demo-login`: passwordless login of the seeded demo user, only when `LLM_PROVIDER=replay` and the demo user exists (else 403); shares the login rate limit; audit `login` detail `method: demo_account`. `/api/health.demoLogin` drives the "Use demo account" button; the password never reaches the client.
- Tests: `withSession(app, db)` (test/helpers.ts) gives an app a real session row + cookie on `app.inject`; e2e does a real login. Web: `App` is the auth gate (`Login.tsx`), any 401 returns to login, onboarding flag is per user email.

## README, screenshots, dev
- `npm run dev` (scripts/dev.mjs) runs API + web. `npm run screenshots` (scripts/screenshots.mjs, Playwright chromium, demo mode) regenerates docs/screenshots/01..10 after demo:reset; fails if any image is tiny. `npm run check:readme` verifies README paths/scripts/env vars/tool names/links. The README's EVAL block is rewritten by `eval:attacks` (keep the markers).
- README honesty rules: numbers only from docs/eval-results.md; demo mode outputs are hand-written (not captured); live Gemini/Google/Telegram are untested live.

## Resilience
- `crash-log.ts`: `installCrashHandlers` (index.ts) logs unhandledRejection/uncaughtException to console + `<db dir>/server-error.log` and keeps running; >20 in a minute exits(1). Route error handler (routes.ts) returns `{error}` JSON for every failure (4xx keep their status, others 500 "Internal error: ..."), logs the stack. An agent run failure is recorded as run status `failed` (never escapes the background task).

## Seed policies
Never auto-send email; block tainted send_email to non-allowlisted recipients;
auto-allow calendar reminders for obligations with confidence >= 0.8.

## Milestones
- [x] M1 Monorepo scaffold, CLAUDE.md, env, DB schema + migrations, Fastify health route, web shell
- [x] M2 MCP servers (sandbox backends + fixtures) + server MCP client; debug route listing tools
- [x] M3 LLM adapter (Gemini + Anthropic) + Quarantined Extractor + obligations API + UI cards
- [x] M4 Guard with unit tests (tainted recipient, R3 block, duplicate skip, policy paths)
- [x] M5 Agent runtime + approvals + execute + verify + undo + hold window; run timeline UI
- [x] M6 Google OAuth + GoogleBackend (encrypted tokens)
- [x] M7 E2E sandbox script (scan → handle → approve → verify → undo, + injection), README + demo

## Out of scope (Phase 1)
Telegram/WhatsApp, natural-language policy compiler, scheduled scans, Drive, deployment, attack
benchmark. Keep interfaces pluggable for these.

## Commands
`npm run dev:server`, `npm run dev:web`, `npm run typecheck`, `npm test`, `npm run db:generate`.
