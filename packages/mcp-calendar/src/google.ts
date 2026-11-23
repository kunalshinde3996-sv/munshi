import { googleAuthFromEnv, googleCall } from "@munshi/mcp-common/google";
import { google, type calendar_v3 } from "googleapis";
import type { CalendarBackend, CalendarEvent, CreateEventInput, ListEventsOptions } from "./types.js";

const CAL = "primary";

function toEvent(e: calendar_v3.Schema$Event): CalendarEvent {
  const when = (t?: calendar_v3.Schema$EventDateTime) => t?.dateTime ?? (t?.date ? `${t.date}T00:00:00+05:30` : "");
  const popup = e.reminders?.overrides?.find((o) => o.method === "popup")?.minutes ?? undefined;
  return {
    id: e.id!, calendar: CAL, title: e.summary ?? "(no title)", start: when(e.start), end: when(e.end),
    description: e.description ?? "", attendees: (e.attendees ?? []).map((a) => (a.email ?? "").toLowerCase()).filter(Boolean),
    ...(popup !== undefined ? { reminderMinutes: popup } : {}),
  };
}

export class GoogleCalendarBackend implements CalendarBackend {
  readonly source = "google" as const;

  constructor(private readonly cal: calendar_v3.Calendar = google.calendar({ version: "v3", auth: googleAuthFromEnv() })) {}

  async listEvents({ from, to, limit }: ListEventsOptions) {
    const { data } = await googleCall(() =>
      this.cal.events.list({ calendarId: CAL, timeMin: from, timeMax: to, maxResults: limit, singleEvents: true, orderBy: "startTime" }));
    return (data.items ?? []).map(toEvent);
  }

  async getEvent(id: string) {
    const { data } = await googleCall(() => this.cal.events.get({ calendarId: CAL, eventId: id }));
    return toEvent(data);
  }

  async createEvent(input: CreateEventInput) {
    const { data } = await googleCall(() =>
      this.cal.events.insert({
        calendarId: CAL,
        // Never email invitations automatically: attendees are added silently; the user decides what to send.
        sendUpdates: "none",
        requestBody: {
          summary: input.title, description: input.description,
          start: { dateTime: input.start }, end: { dateTime: input.end },
          attendees: input.attendees.map((email) => ({ email })),
          ...(input.reminderMinutes !== undefined
            ? { reminders: { useDefault: false, overrides: [{ method: "popup", minutes: input.reminderMinutes }] } }
            : {}),
        },
      }));
    return toEvent(data);
  }

  async deleteEvent(id: string) {
    await googleCall(() => this.cal.events.delete({ calendarId: CAL, eventId: id, sendUpdates: "none" }));
    return { deleted: true as const, id };
  }
}
