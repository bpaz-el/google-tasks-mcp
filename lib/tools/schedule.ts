/**
 * Scheduling a task the way Calendars by Readdle does when a task is dragged
 * onto the calendar. Google Tasks keeps no time of day, so Calendars puts the
 * time block in Google Calendar and ties the two together:
 *
 * - an event on the primary calendar, titled like the task, whose private
 *   extended property LINKEDTASK names the task and its start time
 * - a line reading @scheduled:1 in the task's notes
 *
 * Readdle doesn't document this. It was read off an event Calendars made, so
 * a change on their side can break the link, and the event then shows as a
 * plain event.
 */
import type { CalendarClient, GoogleEvent } from "@/lib/google/calendar";
import type { GoogleTask, GoogleTaskList, TasksClient } from "@/lib/google/tasks";
import { ToolError } from "@/lib/tools/errors";
import { findTask, listId, toTask, type ListChoice, type Task } from "@/lib/tools/handlers";
import type { ScheduleTaskArgs, UnscheduleTaskArgs } from "@/lib/tools/schemas";
import { toAppleSeconds, toRfc3339, zonedTimeToInstant } from "@/lib/tools/time";

export const SCHEDULED_TAG = "@scheduled:1";
export const LINKED_TASK_KEY = "LINKEDTASK";

/** Calendars' number for a Google Tasks account. */
const GOOGLE_TASKS_ACCOUNT_KIND = 1;
/** The alert Calendars puts on a task it schedules. */
const ALERT_MINUTES = 15;
const NOTES_MAX = 8192;
const DAY_MS = 24 * 60 * 60 * 1000;
// How far back and ahead to look for a task's existing time block.
const SEARCH_BACK_DAYS = 60;
const SEARCH_AHEAD_DAYS = 400;

export type ScheduledEvent = {
  id: string;
  start?: string;
  end?: string;
  time_zone?: string;
  html_link?: string;
};

export type ScheduleResult = {
  task: Task;
  event: ScheduledEvent;
  /** True when the task already had a time block and it was moved. */
  moved: boolean;
};

export type UnscheduleResult = { task: Task; events_removed: number };

/** The value Calendars stores under LINKEDTASK. The key order matches what the app writes. */
export function linkedTaskValue(taskId: string, startInstant: number): string {
  return JSON.stringify({
    taskIdentifier: taskId,
    taskAccountKind: GOOGLE_TASKS_ACCOUNT_KIND,
    taskDate: toAppleSeconds(startInstant),
  });
}

/** The task id an event is linked to, if any. */
export function linkedTaskId(event: GoogleEvent): string | undefined {
  const raw = event.extendedProperties?.private?.[LINKED_TASK_KEY];
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "taskIdentifier" in parsed) {
      const id = (parsed as { taskIdentifier?: unknown }).taskIdentifier;
      return typeof id === "string" ? id : undefined;
    }
  } catch {
    // Not JSON, so not a link this code understands.
  }
  return undefined;
}

function hasTag(notes: string | undefined): boolean {
  return (notes ?? "").split("\n").some((line) => line.trim() === SCHEDULED_TAG);
}

/** The notes with the tag on a line of its own at the end. Existing notes are kept as written. */
export function withTag(notes: string | undefined): string {
  if (hasTag(notes)) return notes ?? "";
  return notes ? `${notes}\n${SCHEDULED_TAG}` : SCHEDULED_TAG;
}

/** The notes without the tag's line, or null when nothing else is left. */
export function withoutTag(notes: string | undefined): string | null {
  const kept = (notes ?? "").split("\n").filter((line) => line.trim() !== SCHEDULED_TAG);
  const text = kept.join("\n");
  return text.trim().length === 0 ? null : text;
}

async function resolveTask(
  tasks: TasksClient,
  args: ListChoice & { task_id: string },
): Promise<{ list: GoogleTaskList; task: GoogleTask }> {
  const taskListId = await listId(tasks, args);
  if (!taskListId) return findTask(tasks, args.task_id);
  const list = await tasks.getTaskList(taskListId);
  return { list, task: await tasks.getTask(list.id, args.task_id) };
}

async function linkedEvents(calendar: CalendarClient, taskId: string, now: number): Promise<GoogleEvent[]> {
  const { items } = await calendar.listEvents({
    timeMin: toRfc3339(now - SEARCH_BACK_DAYS * DAY_MS),
    timeMax: toRfc3339(now + SEARCH_AHEAD_DAYS * DAY_MS),
  });
  return items.filter((event) => event.status !== "cancelled" && linkedTaskId(event) === taskId);
}

function summarizeEvent(event: GoogleEvent): ScheduledEvent {
  const out: ScheduledEvent = { id: event.id };
  if (event.start?.dateTime) out.start = event.start.dateTime;
  if (event.end?.dateTime) out.end = event.end.dateTime;
  if (event.start?.timeZone) out.time_zone = event.start.timeZone;
  if (event.htmlLink) out.html_link = event.htmlLink;
  return out;
}

export async function scheduleTask(
  tasks: TasksClient,
  calendar: CalendarClient,
  args: ScheduleTaskArgs,
  now: number = Date.now(),
): Promise<ScheduleResult> {
  const { list, task } = await resolveTask(tasks, args);
  if (task.status === "completed") {
    throw new ToolError("That task is completed. Reopen it with update_task (status needsAction) before scheduling it.");
  }
  if (!hasTag(task.notes) && withTag(task.notes).length > NOTES_MAX) {
    throw new ToolError(
      `The task's notes are too long to take the ${SCHEDULED_TAG} line that marks it as scheduled. Shorten them first.`,
    );
  }

  const zone = args.time_zone ?? (await calendar.primaryTimeZone());
  if (!zone) throw new ToolError("Google Calendar didn't say which time zone the calendar uses. Pass time_zone.");

  const start = zonedTimeToInstant(args.start, zone);
  const end = start + args.duration_minutes * 60_000;
  const times = {
    start: { dateTime: toRfc3339(start), timeZone: zone },
    end: { dateTime: toRfc3339(end), timeZone: zone },
  };
  const link = { private: { [LINKED_TASK_KEY]: linkedTaskValue(task.id, start) } };
  const summary = task.title ?? "";

  const [existing] = await linkedEvents(calendar, task.id, now);
  const event = existing
    ? await calendar.patchEvent(existing.id, { summary, ...times, extendedProperties: link })
    : await calendar.insertEvent({
        summary,
        ...times,
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: ALERT_MINUTES }] },
        extendedProperties: link,
      });

  let updated = task;
  if (!hasTag(task.notes)) {
    try {
      updated = await tasks.patchTask(list.id, task.id, { notes: withTag(task.notes) });
    } catch (error) {
      // A new block with no tag on its task would be half a link, so take it back.
      if (!existing) await calendar.deleteEvent(event.id).catch(() => undefined);
      throw error;
    }
  }

  return { task: toTask(updated, list), event: summarizeEvent(event), moved: Boolean(existing) };
}

export async function unscheduleTask(
  tasks: TasksClient,
  calendar: CalendarClient,
  args: UnscheduleTaskArgs,
  now: number = Date.now(),
): Promise<UnscheduleResult> {
  const { list, task } = await resolveTask(tasks, args);
  const events = await linkedEvents(calendar, task.id, now);
  if (events.length === 0 && !hasTag(task.notes)) {
    throw new ToolError("That task isn't scheduled, so there is nothing to take off the calendar.");
  }

  for (const event of events) await calendar.deleteEvent(event.id);
  const updated = hasTag(task.notes)
    ? await tasks.patchTask(list.id, task.id, { notes: withoutTag(task.notes) })
    : task;
  return { task: toTask(updated, list), events_removed: events.length };
}
