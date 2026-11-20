import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { GoogleEvent } from "@/lib/google/calendar";
import type { GoogleTask } from "@/lib/google/tasks";
import { registerTools } from "@/lib/tools";
import { CALENDAR_ACCESS_MESSAGE, CALENDAR_API_OFF_MESSAGE } from "@/lib/tools/errors";
import { linkedTaskId, linkedTaskValue, withoutTag, withTag } from "@/lib/tools/schedule";
import { isLocalTime, isTimeZone, toAppleSeconds, zonedTimeToInstant } from "@/lib/tools/time";

const TASKS = "https://tasks.googleapis.com/tasks/v1";
const CALENDAR = "https://www.googleapis.com/calendar/v3";
const LIST = { id: "inbox", title: "My Tasks", updated: "2026-10-01T00:00:00.000Z" };

type Call = { method: string; url: URL; body: Record<string, unknown> | undefined };

/** An in-memory Google that answers the Tasks and Calendar calls scheduling makes. */
class FakeGoogle {
  tasks: GoogleTask[] = [];
  events: GoogleEvent[] = [];
  calls: Call[] = [];
  timeZone: string | undefined = "America/Chicago";
  /** When set, every Calendar request gets this error. */
  calendarError?: { status: number; message: string };
  /** When true, changing a task fails. */
  failTaskPatch = false;
  private nextId = 1;

  fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = await request.text();
    const call: Call = { method: request.method, url, body: text ? JSON.parse(text) : undefined };
    this.calls.push(call);
    expect(request.headers.get("authorization")).toBe("Bearer g-token");
    return url.href.startsWith(CALENDAR) ? this.calendar(call) : this.tasksApi(call);
  });

  private tasksApi({ method, url, body }: Call): Response {
    const parts = decodeURIComponent(url.pathname.replace("/tasks/v1", "")).split("/").filter(Boolean);
    if (parts[0] === "users") return parts.length === 3 ? ok({ items: [LIST] }) : ok(LIST);
    const task = this.tasks.find((candidate) => candidate.id === parts[3]);
    if (!task) return error(404, "Task not found");
    if (method === "GET") return ok(task);
    if (method === "PATCH") {
      if (this.failTaskPatch) return error(500, "Failed on purpose");
      for (const [key, value] of Object.entries(body ?? {})) {
        if (value === null) delete (task as Record<string, unknown>)[key];
        else (task as Record<string, unknown>)[key] = value;
      }
      return ok(task);
    }
    return error(405, "Method not allowed");
  }

  private calendar({ method, url, body }: Call): Response {
    if (this.calendarError) return error(this.calendarError.status, this.calendarError.message);
    const parts = url.pathname.replace("/calendar/v3", "").split("/").filter(Boolean);
    expect(parts.slice(0, 3)).toEqual(["calendars", "primary", "events"]);
    if (parts.length === 3 && method === "GET") {
      if (url.searchParams.get("fields") === "timeZone") return ok({ timeZone: this.timeZone });
      return ok({ items: this.events });
    }
    if (parts.length === 3 && method === "POST") {
      const event = { id: `event${this.nextId++}`, status: "confirmed", ...body } as GoogleEvent;
      this.events.push(event);
      return ok(event);
    }
    const event = this.events.find((candidate) => candidate.id === parts[3]);
    if (!event) return error(404, "Not Found");
    if (method === "PATCH") {
      const { extendedProperties, ...rest } = (body ?? {}) as Partial<GoogleEvent>;
      Object.assign(event, rest);
      // Google merges private properties key by key on a patch.
      if (extendedProperties?.private) {
        event.extendedProperties = { private: { ...event.extendedProperties?.private, ...extendedProperties.private } };
      }
      return ok(event);
    }
    if (method === "DELETE") {
      this.events.splice(this.events.indexOf(event), 1);
      return new Response(null, { status: 204 });
    }
    return error(405, "Method not allowed");
  }
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function error(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { code: status, message } }), { status });
}

type Registered = {
  config: { inputSchema: z.ZodType };
  callback: (args: unknown, ctx: ServerContext) => Promise<CallToolResult>;
};

let google: FakeGoogle;
let tools: Map<string, Registered>;

const context = {
  http: { authInfo: { token: "t", clientId: "c", scopes: ["tasks"], extra: { googleAccessToken: "g-token" } } },
} as unknown as ServerContext;

async function callRaw(name: string, args: unknown): Promise<CallToolResult> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.callback(tool.config.inputSchema.parse(args), context);
}

async function call(name: string, args: unknown): Promise<Record<string, unknown>> {
  const result = await callRaw(name, args);
  const content = result.content[0];
  if (result.isError || content.type !== "text") throw new Error(`tool failed: ${JSON.stringify(result)}`);
  return JSON.parse(content.text) as Record<string, unknown>;
}

async function callError(name: string, args: unknown): Promise<string> {
  const result = await callRaw(name, args);
  const content = result.content[0];
  expect(result.isError).toBe(true);
  return content.type === "text" ? content.text : "";
}

function calendarCalls(method: string): Call[] {
  return google.calls.filter((entry) => entry.method === method && entry.url.href.startsWith(CALENDAR));
}

beforeEach(() => {
  google = new FakeGoogle();
  google.tasks.push({ id: "R2dGSjUyY0hLbktiMjVuSw", title: "Scheduling test", status: "needsAction" });
  tools = new Map();
  const server = {
    registerTool: (name: string, config: Registered["config"], callback: Registered["callback"]) => {
      tools.set(name, { config, callback });
    },
  } as unknown as McpServer;
  registerTools(server, { fetch: google.fetch as unknown as typeof fetch, tasksApiUrl: TASKS, calendarApiUrl: CALENDAR });
});

describe("time", () => {
  it("accepts real local times only", () => {
    expect(isLocalTime("2026-11-21T14:00")).toBe(true);
    expect(isLocalTime("2026-11-21T14:00:30")).toBe(true);
    expect(isLocalTime("2026-11-21T24:00")).toBe(false);
    expect(isLocalTime("2026-02-30T10:00")).toBe(false);
    expect(isLocalTime("2026-11-21T14:00Z")).toBe(false);
    expect(isLocalTime("2026-11-21T14:00:00-06:00")).toBe(false);
    expect(isLocalTime("2026-11-21")).toBe(false);
  });

  it("knows IANA zone names", () => {
    expect(isTimeZone("America/Chicago")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });

  it("finds the instant a clock time names", () => {
    const at = (local: string, zone: string) => new Date(zonedTimeToInstant(local, zone)).toISOString();
    expect(at("2026-11-21T14:00", "America/Chicago")).toBe("2026-11-21T20:00:00.000Z");
    expect(at("2026-07-04T09:30", "America/Chicago")).toBe("2026-07-04T14:30:00.000Z");
    expect(at("2026-11-21T14:00", "UTC")).toBe("2026-11-21T14:00:00.000Z");
    expect(at("2026-11-21T14:00", "Asia/Kolkata")).toBe("2026-11-21T08:30:00.000Z");
    expect(at("2026-01-01T00:15", "Pacific/Auckland")).toBe("2025-12-31T11:15:00.000Z");
  });

  it("moves a skipped time forward and takes the first of a repeated one", () => {
    const at = (local: string) => new Date(zonedTimeToInstant(local, "America/Chicago")).toISOString();
    // 2:30 AM doesn't exist on the day clocks spring forward; it reads as 3:30 CDT.
    expect(at("2026-03-08T02:30")).toBe("2026-03-08T08:30:00.000Z");
    // 1:30 AM happens twice on the day clocks fall back; the first is still CDT.
    expect(at("2026-11-01T01:30")).toBe("2026-11-01T06:30:00.000Z");
  });

  it("counts seconds from 2001 the way Calendars does", () => {
    // From the event Calendars made for a task dragged to 2:00 PM Central on 2026-11-21.
    expect(toAppleSeconds(Date.parse("2026-11-21T20:00:00Z"))).toBe(816984000);
  });
});

describe("the link Calendars reads", () => {
  it("writes LINKEDTASK exactly as Calendars does", () => {
    expect(linkedTaskValue("R2dGSjUyY0hLbktiMjVuSw", Date.parse("2026-11-21T20:00:00Z"))).toBe(
      '{"taskIdentifier":"R2dGSjUyY0hLbktiMjVuSw","taskAccountKind":1,"taskDate":816984000}',
    );
  });

  it("reads the task id back, and nothing from other events", () => {
    const linked = { id: "e", extendedProperties: { private: { LINKEDTASK: linkedTaskValue("abc", 0) } } };
    expect(linkedTaskId(linked)).toBe("abc");
    expect(linkedTaskId({ id: "e" })).toBeUndefined();
    expect(linkedTaskId({ id: "e", extendedProperties: { private: { LINKEDTASK: "not json" } } })).toBeUndefined();
    expect(linkedTaskId({ id: "e", extendedProperties: { private: { LINKEDTASK: '{"taskIdentifier":5}' } } })).toBeUndefined();
  });

  it("adds and removes the tag without touching other notes", () => {
    expect(withTag(undefined)).toBe("@scheduled:1");
    expect(withTag("Call first\n@duration:900")).toBe("Call first\n@duration:900\n@scheduled:1");
    expect(withTag("Call first\n@scheduled:1")).toBe("Call first\n@scheduled:1");
    expect(withoutTag("Call first\n@scheduled:1\n@duration:900")).toBe("Call first\n@duration:900");
    expect(withoutTag("@scheduled:1")).toBeNull();
    expect(withoutTag(undefined)).toBeNull();
  });
});

describe("schedule_task", () => {
  const args = { task_id: "R2dGSjUyY0hLbktiMjVuSw", start: "2026-11-21T14:00", duration_minutes: 45 };

  it("creates the linked event and tags the task", async () => {
    const result = await call("schedule_task", args);

    expect(calendarCalls("POST")).toHaveLength(1);
    const post = calendarCalls("POST")[0];
    expect(post.url.searchParams.get("sendUpdates")).toBe("none");
    expect(post.body).toEqual({
      summary: "Scheduling test",
      start: { dateTime: "2026-11-21T20:00:00Z", timeZone: "America/Chicago" },
      end: { dateTime: "2026-11-21T20:45:00Z", timeZone: "America/Chicago" },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] },
      extendedProperties: {
        private: { LINKEDTASK: '{"taskIdentifier":"R2dGSjUyY0hLbktiMjVuSw","taskAccountKind":1,"taskDate":816984000}' },
      },
    });
    expect(google.tasks[0].notes).toBe("@scheduled:1");
    expect(google.tasks[0].due).toBeUndefined();
    expect(result.moved).toBe(false);
    expect(result.task).toMatchObject({ id: args.task_id, task_list: "My Tasks", notes: "@scheduled:1" });
    expect(result.event).toMatchObject({ id: "event1", start: "2026-11-21T20:00:00Z", time_zone: "America/Chicago" });
  });

  it("defaults to 30 minutes and keeps existing notes", async () => {
    google.tasks[0].notes = "Bring the receipt";
    await call("schedule_task", { task_id: args.task_id, start: "2026-11-21T14:00" });
    expect(calendarCalls("POST")[0].body?.end).toEqual({ dateTime: "2026-11-21T20:30:00Z", timeZone: "America/Chicago" });
    expect(google.tasks[0].notes).toBe("Bring the receipt\n@scheduled:1");
  });

  it("uses time_zone when given, without asking the calendar for its own", async () => {
    await call("schedule_task", { ...args, time_zone: "America/New_York" });
    expect(calendarCalls("POST")[0].body?.start).toEqual({ dateTime: "2026-11-21T19:00:00Z", timeZone: "America/New_York" });
    expect(calendarCalls("GET").some((entry) => entry.url.searchParams.get("fields") === "timeZone")).toBe(false);
  });

  it("moves an existing time block and leaves other properties on it alone", async () => {
    await call("schedule_task", args);
    google.events[0].extendedProperties = {
      private: { ...google.events[0].extendedProperties?.private, TASKPARTCOMPLETED: "true" },
    };
    const result = await call("schedule_task", { ...args, start: "2026-11-22T09:00", duration_minutes: 60 });

    expect(result.moved).toBe(true);
    expect(google.events).toHaveLength(1);
    expect(calendarCalls("POST")).toHaveLength(1);
    expect(calendarCalls("PATCH")[0].body).not.toHaveProperty("reminders");
    expect(google.events[0].start).toEqual({ dateTime: "2026-11-22T15:00:00Z", timeZone: "America/Chicago" });
    expect(google.events[0].end).toEqual({ dateTime: "2026-11-22T16:00:00Z", timeZone: "America/Chicago" });
    expect(google.events[0].extendedProperties?.private).toEqual({
      LINKEDTASK: linkedTaskValue(args.task_id, Date.parse("2026-11-22T15:00:00Z")),
      TASKPARTCOMPLETED: "true",
    });
    // The tag was already there, so the task isn't written a second time.
    expect(google.calls.filter((entry) => entry.method === "PATCH" && entry.url.href.startsWith(TASKS))).toHaveLength(1);
  });

  it("ignores events linked to other tasks", async () => {
    google.events.push({ id: "other", extendedProperties: { private: { LINKEDTASK: linkedTaskValue("someone-else", 0) } } });
    const result = await call("schedule_task", args);
    expect(result.moved).toBe(false);
    expect(google.events).toHaveLength(2);
  });

  it("refuses a completed task before touching the calendar", async () => {
    google.tasks[0].status = "completed";
    expect(await callError("schedule_task", args)).toContain("Reopen it");
    expect(calendarCalls("POST")).toHaveLength(0);
  });

  it("takes the new event back when the task can't be tagged", async () => {
    google.failTaskPatch = true;
    expect(await callError("schedule_task", args)).toContain("Google Tasks is not answering properly");
    expect(google.events).toHaveLength(0);
    expect(calendarCalls("DELETE")).toHaveLength(1);
  });

  it("says how to fix a missing calendar permission or a disabled API", async () => {
    google.calendarError = { status: 403, message: "Request had insufficient authentication scopes." };
    expect(await callError("schedule_task", args)).toBe(CALENDAR_ACCESS_MESSAGE);
    google.calendarError = {
      status: 403,
      message: "Google Calendar API has not been used in project 123 before or it is disabled.",
    };
    expect(await callError("schedule_task", args)).toBe(CALENDAR_API_OFF_MESSAGE);
    expect(google.tasks[0].notes).toBeUndefined();
  });

  it("asks for time_zone when the calendar doesn't give one", async () => {
    google.timeZone = undefined;
    expect(await callError("schedule_task", args)).toContain("Pass time_zone");
  });

  it("refuses times with an offset, unknown zones and odd lengths", () => {
    const schema = tools.get("schedule_task")?.config.inputSchema;
    expect(schema?.safeParse({ ...args, start: "2026-11-21T14:00:00-06:00" }).success).toBe(false);
    expect(schema?.safeParse({ ...args, time_zone: "Central" }).success).toBe(false);
    expect(schema?.safeParse({ ...args, duration_minutes: 0 }).success).toBe(false);
    expect(schema?.safeParse({ ...args, duration_minutes: 2000 }).success).toBe(false);
    expect(schema?.safeParse(args).success).toBe(true);
  });
});

describe("unschedule_task", () => {
  const args = { task_id: "R2dGSjUyY0hLbktiMjVuSw" };

  it("deletes the linked event and removes the tag", async () => {
    google.tasks[0].notes = "Bring the receipt";
    await call("schedule_task", { ...args, start: "2026-11-21T14:00" });
    google.events.push({ id: "unrelated", summary: "Lunch" });

    const result = await call("unschedule_task", args);
    expect(result.events_removed).toBe(1);
    expect(google.events.map((event) => event.id)).toEqual(["unrelated"]);
    expect(google.tasks[0].notes).toBe("Bring the receipt");
  });

  it("clears the notes when the tag was all they held", async () => {
    await call("schedule_task", { ...args, start: "2026-11-21T14:00" });
    await call("unschedule_task", args);
    expect(google.tasks[0].notes).toBeUndefined();
  });

  it("removes a leftover tag even when the event is already gone", async () => {
    google.tasks[0].notes = "@scheduled:1";
    const result = await call("unschedule_task", args);
    expect(result.events_removed).toBe(0);
    expect(google.tasks[0].notes).toBeUndefined();
  });

  it("says so when the task isn't scheduled", async () => {
    expect(await callError("unschedule_task", args)).toContain("isn't scheduled");
    expect(calendarCalls("DELETE")).toHaveLength(0);
  });
});
