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
- LLM calls: 30s AbortController timeout, 3 attempts with exponential backoff on 429/503/timeout, then `LLM_FALLBACK_MODEL` (optional); the model that answered is logged (`[llm] answered by �`).
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
