import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Appends one entry (timestamp, kind, full stack) to the error log file. Never throws. */
export function logFatal(file: string, kind: string, err: unknown): void {
  const text = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : (() => { try { return JSON.stringify(err); } catch { return String(err); } })();
  const entry = `[${new Date().toISOString()}] ${kind}\n${text}\n\n`;
  console.error(`[${kind}] ${text}`);
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, entry);
  } catch (e) {
    console.error(`[crash-log] could not write ${file}: ${(e as Error).message}`);
  }
}

/**
 * Process-level safety net: unhandled rejections and uncaught exceptions are logged (console + file) instead of
 * killing the server silently. A burst (more than `maxPerMinute`) means something is badly wrong, so we exit then,
 * loudly, rather than limp along in an unknown state.
 */
export function installCrashHandlers(file: string, maxPerMinute = 20, proc: NodeJS.Process = process, exit: (code: number) => void = (c) => process.exit(c)): void {
  const stamps: number[] = [];
  const handle = (kind: string) => (err: unknown) => {
    logFatal(file, kind, err);
    const now = Date.now();
    stamps.push(now);
    while (stamps.length && now - stamps[0]! > 60_000) stamps.shift();
    if (stamps.length > maxPerMinute) {
      logFatal(file, "too many errors", `More than ${maxPerMinute} unhandled errors in a minute; exiting.`);
      exit(1);
    }
  };
  proc.on("unhandledRejection", (reason) => handle("unhandledRejection")(reason));
  proc.on("uncaughtException", (err) => handle("uncaughtException")(err));
}
