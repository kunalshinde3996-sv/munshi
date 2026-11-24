import type { Db } from "./db/index.js";
import type { LlmAdapter } from "./llm/types.js";
import type { McpHub } from "./mcp/hub.js";
import { syncNudges } from "./nudges.js";
import { scanInbox, type ScanSummary } from "./scan.js";

export interface SchedulerStatus {
  enabled: boolean;
  intervalMin: number;
  running: boolean;
  lastRunAt: number | null;
  lastSummary: ScanSummary | null;
  lastError: string | null;
  newNudges: number;
  nextRunAt: number | null;
}

/**
 * Background scan every `intervalMin` minutes. It only ever reads the inbox and extracts (through the same pacing and
 * extraction cache as a manual scan) and then creates nudges. It never starts an agent run and never executes any
 * action, so R2 (and every other) action still needs the user. Disabled when intervalMin <= 0; never constructed in tests.
 */
export class ScanScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private state: Omit<SchedulerStatus, "enabled" | "intervalMin" | "running" | "nextRunAt"> = { lastRunAt: null, lastSummary: null, lastError: null, newNudges: 0 };
  private nextRunAt: number | null = null;

  constructor(
    private readonly deps: { db: Db; mcp: McpHub; llm: LlmAdapter; intervalMin: number; log?: (m: string) => void; now?: () => number },
  ) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  status(): SchedulerStatus {
    return { enabled: this.deps.intervalMin > 0, intervalMin: this.deps.intervalMin, running: this.running, nextRunAt: this.nextRunAt, ...this.state };
  }

  start() {
    if (this.deps.intervalMin <= 0 || this.timer) return;
    const ms = this.deps.intervalMin * 60_000;
    this.nextRunAt = this.now() + ms;
    this.timer = setInterval(() => {
      this.nextRunAt = this.now() + ms;
      void this.runOnce();
    }, ms);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scheduled pass. Skips if a previous pass is still running (a slow, paced scan must not pile up). */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const summary = await scanInbox({ db: this.deps.db, mcp: this.deps.mcp, llm: this.deps.llm, now: new Date(this.now()) });
      const nudges = syncNudges(this.deps.db, this.now());
      this.state = { lastRunAt: this.now(), lastSummary: summary, lastError: null, newNudges: nudges.length };
      this.deps.log?.(`[scheduler] scanned ${summary.listed} emails (${summary.skipped} cached, ${summary.extracted} extracted, ${summary.failed} failed); ${nudges.length} new nudge(s)`);
    } catch (e) {
      // Includes the fatal "all models over quota" error: report it and try again next interval.
      this.state = { ...this.state, lastRunAt: this.now(), lastError: e instanceof Error ? e.message : String(e) };
      this.deps.log?.(`[scheduler] scan failed: ${this.state.lastError}`);
    } finally {
      this.running = false;
    }
  }
}
