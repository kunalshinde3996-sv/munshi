import { istDate, JsonStore } from "@munshi/mcp-common";
import type {
  CalendarBackend, CalendarEvent, CreateEventInput, ListEventsOptions,
} from "./types.js";

interface State {
  counter: number;
  created: CalendarEvent[];
  /** Fixture ids the user/Guard deleted. */
  deleted: string[];
}

/** SANDBOX DATA — a few pre-existing personal events, regenerated relative to today. */
export function buildFixtureEvents(now = new Date()): CalendarEvent[] {
  const ev = (id: string, title: string, day: number, h: number, m: number, mins: number, description = ""): CalendarEvent => {
    const start = istDate(day, h, m, now);
    const end = istDate(day, h + Math.floor((m + mins) / 60), (m + mins) % 60, now);
    return { id: `sbx-ev-${id}`, calendar: "primary", title, start, end, description, attendees: [] };
  };
  return [
    ev("yoga", "Morning yoga", 1, 6, 30, 60),
    ev("standup", "Team standup", 2, 10, 0, 30),
    ev("family", "Lunch with parents", 6, 13, 0, 90, "Sunday lunch at home."),
  ];
}

/** SANDBOX DATA backend; writes persist in a JSON file so verify/undo work across calls. */
export class SandboxCalendarBackend implements CalendarBackend {
  readonly source = "sandbox" as const;
  private readonly store: JsonStore<State>;

  constructor(dir: string, private readonly clock: () => Date = () => new Date()) {
    this.store = new JsonStore<State>(dir, "sandbox-calendar.json", () => ({
      counter: 0, created: [], deleted: [],
    }));
  }

  private all(): CalendarEvent[] {
    const s = this.store.read();
    return [
      ...buildFixtureEvents(this.clock()).filter((e) => !s.deleted.includes(e.id)),
      ...s.created,
    ].sort((a, b) => a.start.localeCompare(b.start));
  }

  async listEvents({ from, to, limit }: ListEventsOptions) {
    const f = from ? Date.parse(from) : -Infinity;
    const t = to ? Date.parse(to) : Infinity;
    return this.all()
      .filter((e) => Date.parse(e.start) >= f && Date.parse(e.start) <= t)
      .slice(0, limit);
  }

  async getEvent(id: string) {
    const e = this.all().find((x) => x.id === id);
    if (!e) throw new Error(`Event not found: ${id}`);
    return e;
  }

  async createEvent(input: CreateEventInput) {
    return this.store.update((s) => {
      const ev: CalendarEvent = { id: `sbx-ev-new-${++s.counter}`, calendar: "primary", ...input };
      s.created.push(ev);
      return ev;
    });
  }

  async deleteEvent(id: string) {
    await this.getEvent(id); // throws if missing
    return this.store.update((s) => {
      const i = s.created.findIndex((e) => e.id === id);
      if (i >= 0) s.created.splice(i, 1);
      else s.deleted.push(id);
      return { deleted: true as const, id };
    });
  }
}
