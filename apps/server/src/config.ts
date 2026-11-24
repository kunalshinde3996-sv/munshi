import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Load the repo-root .env regardless of which workspace dir npm runs us from.
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"), quiet: true });

const Env = z.object({
  PORT: z.coerce.number().default(8787),
  DATABASE_PATH: z.string().default("./data/munshi.db"),
  SANDBOX_STORE_DIR: z.string().default("./data/sandbox"),
  LLM_PROVIDER: z.enum(["gemini", "anthropic"]).default("gemini"),
  LLM_MODEL: z.string().optional(),
  LLM_FALLBACK_MODEL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().default("http://localhost:8787/auth/google/callback"),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  SEND_HOLD_SECONDS: z.coerce.number().default(60),
});

export type Config = z.infer<typeof Env>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => Env.parse(env);
