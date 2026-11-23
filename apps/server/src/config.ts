import "dotenv/config";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().default(8787),
  DATABASE_PATH: z.string().default("./data/munshi.db"),
  LLM_PROVIDER: z.enum(["gemini", "anthropic"]).default("gemini"),
  LLM_MODEL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  SEND_HOLD_SECONDS: z.coerce.number().default(60),
});

export type Config = z.infer<typeof Env>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => Env.parse(env);
