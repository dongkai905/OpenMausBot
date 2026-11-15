// The shapes the brief, the check plan and the inbox triage read: a calendar event, an email header, a thread's
// messages, and the session that reads them. The reading itself is the app's job (the native Email app, or the
// person's own MCP server); these are only the data it hands over.

export interface CalendarEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  selfDeclined: boolean;
  attendees: Array<{ email: string; name?: string; self: boolean; organizer: boolean; response?: string }>;
  seriesId?: string;
  joinUrl?: string;
  location?: string;
  description?: string;
  calendarId?: string;
  ownedCalendar?: boolean;
  iCalUID?: string;
  originalStart?: number;
  organizer?: string;
}

export interface EmailHeader {
  id: string;
  threadId: string;
  at: number;
  from: string;
  subject: string;
  preview: string;
}

export interface ThreadMessage {
  id: string;
  at: number;
  /** The sender's lower-case address, or "" when the answer named none. */
  from: string;
}

export interface ReadSession {
  events(fromMs: number, toMs: number): Promise<CalendarEvent[]>;
  /** Inbox mail since `sinceMs`, newest first, at most `limit`; `more` when there was more than that. */
  emails(sinceMs: number, limit: number): Promise<{ emails: EmailHeader[]; more: boolean }>;
  /** Null only when the app says the message is gone. */
  message(messageId: string): Promise<EmailHeader | null>;
  thread(threadId: string): Promise<ThreadMessage[]>;
  /** The account's own address. */
  address(): Promise<string>;
}
