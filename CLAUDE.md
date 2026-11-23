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
- mcp-gmail: list_recent_emails, get_email, create_draft, send_email, add_label
- mcp-calendar: list_events, create_event, delete_event, get_event

## Seed policies
Never auto-send email; block tainted send_email to non-allowlisted recipients;
auto-allow calendar reminders for obligations with confidence >= 0.8.

## Milestones
- [x] M1 Monorepo scaffold, CLAUDE.md, env, DB schema + migrations, Fastify health route, web shell
- [ ] M2 MCP servers (sandbox backends + fixtures) + server MCP client; debug route listing tools
- [ ] M3 LLM adapter (Gemini + Anthropic) + Quarantined Extractor + obligations API + UI cards
- [ ] M4 Guard with unit tests (tainted recipient, R3 block, duplicate skip, policy paths)
- [ ] M5 Agent runtime + approvals + execute + verify + undo + hold window; run timeline UI
- [ ] M6 Google OAuth + GoogleBackend (encrypted tokens)
- [ ] M7 E2E sandbox script (scan → handle → approve → verify → undo, + injection), README + demo

## Out of scope (Phase 1)
Telegram/WhatsApp, natural-language policy compiler, scheduled scans, Drive, deployment, attack
benchmark. Keep interfaces pluggable for these.

## Commands
`npm run dev:server`, `npm run dev:web`, `npm run typecheck`, `npm test`, `npm run db:generate`.
