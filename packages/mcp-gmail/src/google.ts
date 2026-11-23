import type { GmailBackend } from "./types.js";

const NOT_READY = "GoogleBackend for Gmail is implemented in milestone M6 (Google OAuth). Use sandbox mode.";

/** Placeholder so the interface is wired end-to-end; every call fails loudly until M6. */
export class GoogleGmailBackend implements GmailBackend {
  readonly source = "google" as const;
  private nope(): never {
    throw new Error(NOT_READY);
  }
  userAddress = async () => this.nope();
  listRecentEmails = async () => this.nope();
  getEmail = async () => this.nope();
  createDraft = async () => this.nope();
  getDraft = async () => this.nope();
  deleteDraft = async () => this.nope();
  sendEmail = async () => this.nope();
  addLabel = async () => this.nope();
  removeLabel = async () => this.nope();
}
