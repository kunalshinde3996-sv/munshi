import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SANDBOX_LABEL = "SANDBOX DATA";
/** The sandbox user's own mailbox address (TRUSTED provenance in the Guard). */
export const SANDBOX_USER_EMAIL = "rohan.mehta@example.com";
export const SANDBOX_USER_NAME = "Rohan Mehta";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Date `days` from now at the given IST wall-clock hour:minute, as an ISO string with +05:30. */
export function istDate(days: number, hour = 10, minute = 0, now = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 3600_000 + days * DAY_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`;
}

/** "28 Nov 2026" for a date `days` from now (IST). */
export function humanDate(days: number, now = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 3600_000 + days * DAY_MS);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
    ist.getUTCMonth()
  ];
  return `${ist.getUTCDate()} ${mon} ${ist.getUTCFullYear()}`;
}

/** Tiny JSON file store shared across the stdio child process and restarts. Atomic writes. */
export class JsonStore<T> {
  private readonly path: string;
  constructor(dir: string, file: string, private readonly initial: () => T) {
    this.path = join(dir, file);
    mkdirSync(dirname(this.path), { recursive: true });
  }
  read(): T {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as T;
    } catch {
      const fresh = this.initial();
      this.write(fresh);
      return fresh;
    }
  }
  write(data: T): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.path);
  }
  update<R>(fn: (data: T) => R): R {
    const data = this.read();
    const result = fn(data);
    this.write(data);
    return result;
  }
}

export type McpResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export const ok = (value: unknown): McpResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
export const fail = (message: string): McpResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** Run a handler, converting thrown errors into MCP tool errors. */
export async function guarded(fn: () => unknown | Promise<unknown>): Promise<McpResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export type BackendMode = "sandbox" | "google";
export const backendMode = (env = process.env): BackendMode =>
  env.MUNSHI_BACKEND === "google" ? "google" : "sandbox";
export const sandboxDir = (env = process.env): string => env.SANDBOX_STORE_DIR ?? "./data/sandbox";
