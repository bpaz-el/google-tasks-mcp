/**
 * A small client for the Google Calendar REST API (v3). It only does what
 * schedule_task and unschedule_task need: read the primary calendar's time
 * zone, and list, insert, patch and delete events on it.
 */

export type EventTime = {
  /** RFC 3339. Google answers with the offset filled in. */
  dateTime?: string;
  /** Set on all-day events, which have no dateTime. */
  date?: string;
  timeZone?: string;
};

export type GoogleEvent = {
  id: string;
  status?: string;
  summary?: string;
  htmlLink?: string;
  start?: EventTime;
  end?: EventTime;
  extendedProperties?: { private?: Record<string, string> };
};

/** Writable event fields. On a patch, a missing key is left alone. */
export type EventFields = {
  summary?: string;
  start?: EventTime;
  end?: EventTime;
  reminders?: { useDefault: boolean; overrides?: { method: "popup" | "email"; minutes: number }[] };
  extendedProperties?: { private: Record<string, string> };
};

export type ListEventsOptions = {
  /** RFC 3339 timestamps bounding the search. */
  timeMin: string;
  timeMax: string;
  /** Stop after this many pages of 250 events. */
  maxPages?: number;
};

export type ListEventsResult = {
  items: GoogleEvent[];
  /** False when maxPages ran out before the last page. */
  complete: boolean;
};

export class CalendarApiError extends Error {
  /** The HTTP status Google answered with, or 502/504 when it couldn't be reached. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CalendarApiError";
    this.status = status;
  }
}

export type CalendarClientOptions = {
  accessToken: string;
  /** Config.calendarApiUrl, e.g. https://www.googleapis.com/calendar/v3 */
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

type Query = Record<string, string | number | boolean | undefined>;

const CALENDAR = "primary";
const PAGE_SIZE = 250;
const DEFAULT_MAX_PAGES = 8;
const DEFAULT_TIMEOUT_MS = 15_000;
// Only what the tools read, so a busy calendar stays a small answer.
const EVENT_FIELDS = "id,status,summary,htmlLink,start,end,extendedProperties/private";

export class CalendarClient {
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CalendarClientOptions) {
    this.accessToken = options.accessToken;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    // Looked up on every call so tests can stub the global after construction.
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * The primary calendar's IANA time zone. Read from an events listing because
   * that works with the events-only scope, which calendars.get does not.
   */
  async primaryTimeZone(): Promise<string | undefined> {
    const body = await this.request<{ timeZone?: string }>("GET", `/calendars/${CALENDAR}/events`, {
      query: { maxResults: 1, fields: "timeZone" },
    });
    return body.timeZone;
  }

  /** Events on the primary calendar in a time range, with repeating events expanded. */
  async listEvents(options: ListEventsOptions): Promise<ListEventsResult> {
    const items: GoogleEvent[] = [];
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const body = await this.request<{ items?: GoogleEvent[]; nextPageToken?: string }>(
        "GET",
        `/calendars/${CALENDAR}/events`,
        {
          query: {
            timeMin: options.timeMin,
            timeMax: options.timeMax,
            singleEvents: true,
            showDeleted: false,
            maxResults: PAGE_SIZE,
            fields: `nextPageToken,items(${EVENT_FIELDS})`,
            pageToken,
          },
        },
      );
      items.push(...(body.items ?? []));
      pageToken = body.nextPageToken;
      if (!pageToken) return { items, complete: true };
    }
    return { items, complete: false };
  }

  insertEvent(fields: EventFields): Promise<GoogleEvent> {
    return this.request("POST", `/calendars/${CALENDAR}/events`, {
      query: { sendUpdates: "none", fields: EVENT_FIELDS },
      body: fields,
    });
  }

  patchEvent(eventId: string, fields: EventFields): Promise<GoogleEvent> {
    return this.request("PATCH", `/calendars/${CALENDAR}/events/${encodeURIComponent(eventId)}`, {
      query: { sendUpdates: "none", fields: EVENT_FIELDS },
      body: fields,
    });
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.request<void>("DELETE", `/calendars/${CALENDAR}/events/${encodeURIComponent(eventId)}`, {
      query: { sendUpdates: "none" },
    });
  }

  private async request<T>(method: string, path: string, options: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/json",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new CalendarApiError(504, `Google Calendar did not answer within ${this.timeoutMs / 1000} seconds.`);
      }
      throw new CalendarApiError(
        502,
        `Could not reach Google Calendar: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = await response.text();
    if (!response.ok) throw new CalendarApiError(response.status, googleMessage(text, response));
    if (response.status === 204 || text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CalendarApiError(502, "Google Calendar sent a response that isn't JSON.");
    }
  }
}

/** Google's errors look like { error: { code, message, status } }. */
function googleMessage(text: string, response: Response): string {
  let message: string | undefined;
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (body.error && typeof body.error === "object" && "message" in body.error) {
      const inner = (body.error as { message?: unknown }).message;
      if (typeof inner === "string") message = inner;
    } else if (typeof body.error === "string") {
      message = body.error;
    }
  } catch {
    // Not JSON, so fall through to the status line.
  }
  message = message?.trim() || response.statusText || `HTTP ${response.status}`;
  return message.length > 500 ? `${message.slice(0, 500)}...` : message;
}
