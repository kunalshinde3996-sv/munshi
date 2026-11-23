import { google } from "googleapis";

/** Minimal scopes: read mail, create drafts/send, labels (modify), and calendar events. */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

/** Tool errors that start with this mean "the Google grant is gone/insufficient"; the server shows a reconnect message. */
export const GOOGLE_AUTH_PREFIX = "GOOGLE_AUTH:";

export class GoogleAuthError extends Error {
  constructor(detail: string) {
    super(`${GOOGLE_AUTH_PREFIX} ${detail}`);
  }
}

/**
 * OAuth client for the MCP child processes. They receive the long-lived refresh token via env and refresh
 * access tokens themselves; the token at rest in the app database stays AES-256-GCM encrypted.
 */
export function googleAuthFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret, GOOGLE_REFRESH_TOKEN: refresh } = env;
  if (!id || !secret || !refresh) throw new GoogleAuthError("Google is not connected. Connect Google in Munshi first.");
  const auth = new google.auth.OAuth2(id, secret);
  auth.setCredentials({ refresh_token: refresh });
  return auth;
}

/** Normalise googleapis errors; auth problems become GoogleAuthError so the UI can say "reconnect". */
export function mapGoogleError(e: unknown): Error {
  if (e instanceof GoogleAuthError) return e;
  const err = e as { message?: string; code?: number | string; status?: number; response?: { status?: number; data?: { error?: string | { message?: string; status?: string } } } };
  const status = err.response?.status ?? err.status ?? (typeof err.code === "number" ? err.code : undefined);
  const msg = err.message ?? String(e);
  const data = err.response?.data?.error;
  const text = `${msg} ${typeof data === "string" ? data : (data?.message ?? "")}`;
  if (/invalid_grant|invalid_client|unauthorized_client|Token has been expired or revoked/i.test(text) || status === 401) {
    return new GoogleAuthError("Google access was revoked or has expired. Reconnect Google in Munshi.");
  }
  if (status === 403 && /insufficient|scope|permission/i.test(text)) {
    return new GoogleAuthError("Munshi is missing a Google permission. Disconnect and reconnect Google to grant it again.");
  }
  return new Error(`Google API error${status ? ` (${status})` : ""}: ${msg}`);
}

export async function googleCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw mapGoogleError(e);
  }
}
