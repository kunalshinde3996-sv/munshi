import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import type { GoogleConnection } from "./google/connection.js";

const NO_GOOGLE = { configured: false, missing: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"], connected: false, email: null, mode: "sandbox", authProblem: null, setupSteps: [] as string[], redirectUri: "" };

export function registerGoogleRoutes(app: FastifyInstance, config: Config, google: GoogleConnection | undefined) {
  app.get("/api/google/status", async () => (google ? google.status() : NO_GOOGLE));

  /** Browser navigation target for the "Connect Google" button. */
  app.get("/auth/google/start", async (_req, reply) => {
    if (!google) return reply.code(503).send({ error: "Google integration unavailable" });
    try {
      return reply.redirect(google.startUrl());
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get("/auth/google/callback", async (req, reply) => {
    const back = (q: string) => reply.redirect(`${config.WEB_ORIGIN}/?${q}`);
    if (!google) return back("google=error&message=Google+integration+unavailable");
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    if (error) return back(`google=denied&message=${encodeURIComponent(error)}`);
    try {
      await google.handleCallback(code, state);
      return back("google=connected");
    } catch (e) {
      return back(`google=error&message=${encodeURIComponent((e as Error).message)}`);
    }
  });

  app.post("/api/google/disconnect", async (_req, reply) => {
    if (!google) return reply.code(503).send({ error: "Google integration unavailable" });
    await google.disconnect();
    return google.status();
  });

  app.post("/api/settings/mode", async (req, reply) => {
    const { mode } = z.object({ mode: z.enum(["sandbox", "google"]) }).parse(req.body);
    if (!google) return reply.code(mode === "sandbox" ? 200 : 400).send(mode === "sandbox" ? { mode } : { error: "Google is not configured" });
    try {
      await google.setMode(mode);
      return google.status();
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
}
