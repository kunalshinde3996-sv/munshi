import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Load the repo-root .env regardless of which workspace dir npm runs us from.
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"), quiet: true });

/** Evaluation fixtures (20 injection + 10 benign-but-suspicious emails), also used by `npm run eval:attacks`. */
export const ATTACK_FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/attacks");

/** Recorded extractor + agent outputs used when LLM_PROVIDER=replay. */
export const REPLAY_RECORDING_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/replay/recording.json");

export const EVAL_RESULTS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/eval-results.json");

const Env = z.object({
  PORT: z.coerce.number().default(8787),
  DATABASE_PATH: z.string().default("./data/munshi.db"),
  SANDBOX_STORE_DIR: z.string().default("./data/sandbox"),
  /** Opt-in: add the 30 attack/benign evaluation emails (fixtures/attacks) to the SANDBOX mailbox. Default off: the demo inbox is the 15 demo emails. `npm run eval:attacks` always uses them regardless. */
  SANDBOX_ATTACK_EMAILS: z.string().default("false").transform((v) => !["false", "0", "off", "no"].includes(v.trim().toLowerCase())),
  LLM_PROVIDER: z.enum(["gemini", "anthropic", "replay"]).default("gemini"),
  LLM_MODEL: z.string().optional(),
  LLM_FALLBACK_MODEL: z.string().optional(),
  /** Max LLM requests per minute across extractor + agent (0 disables pacing). */
  LLM_RPM: z.coerce.number().min(0).default(8),
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().default("http://localhost:8787/auth/google/callback"),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  /** Telegram channel (optional). Without a token the feature reports "Not configured". */
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  /** Background scan period in minutes (0 disables). Never runs in tests. */
  SCAN_INTERVAL_MIN: z.coerce.number().min(0).default(30),
  /** Single demo login, seeded at startup (no registration, no password reset). Without both, nobody can sign in. */
  DEMO_USER_EMAIL: z.string().optional(),
  DEMO_USER_PASSWORD: z.string().optional(),
  SEND_HOLD_SECONDS: z.coerce.number().default(60),
});

export type Config = z.infer<typeof Env>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => Env.parse(env);
