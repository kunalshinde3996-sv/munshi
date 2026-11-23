export interface CalendarEvent {
  id: string;
  calendar: string;
  title: string;
  /** ISO 8601 with offset */
  start: string;
  end: string;
  description: string;
  attendees: string[];
  reminderMinutes?: number;
}

export interface CreateEventInput {
  title: string;
  start: string;
  end: string;
  description: string;
  attendees: string[];
  reminderMinutes?: number;
}

export interface ListEventsOptions {
  from?: string;
  to?: string;
  limit: number;
}

export interface CalendarBackend {
  readonly source: "sandbox" | "google";
  listEvents(opts: ListEventsOptions): Promise<CalendarEvent[]>;
  getEvent(id: string): Promise<CalendarEvent>;
  createEvent(input: CreateEventInput): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<{ deleted: true; id: string }>;
}
