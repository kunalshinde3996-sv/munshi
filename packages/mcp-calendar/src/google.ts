import type { CalendarBackend } from "./types.js";

const NOT_READY = "GoogleBackend for Calendar is implemented in milestone M6 (Google OAuth). Use sandbox mode.";

/** Placeholder so the interface is wired end-to-end; every call fails loudly until M6. */
export class GoogleCalendarBackend implements CalendarBackend {
  readonly source = "google" as const;
  private nope(): never {
    throw new Error(NOT_READY);
  }
  listEvents = async () => this.nope();
  getEvent = async () => this.nope();
  createEvent = async () => this.nope();
  deleteEvent = async () => this.nope();
}
