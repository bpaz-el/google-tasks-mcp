import { CalendarApiError } from "@/lib/google/calendar";
import { TasksApiError } from "@/lib/google/tasks";

/** A problem with what the tool was asked to do. Its message goes to Claude as written. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export const RECONNECT_MESSAGE =
  "Google no longer accepts this connector's access to Google Tasks. " +
  "Reconnect the Google Tasks connector in Claude (Customize, then Connectors) and try again.";

export const CALENDAR_ACCESS_MESSAGE =
  "This connector isn't allowed to change Google Calendar events, which scheduling a task needs. " +
  "Reconnect the Google Tasks connector in Claude (Customize, then Connectors) and leave the Google Calendar box ticked on Google's page.";

export const CALENDAR_API_OFF_MESSAGE =
  "The Google Calendar API is switched off for this server's Google Cloud project, which scheduling a task needs. " +
  "Whoever runs the server can enable it under APIs & Services, Library, in the Google Cloud console.";

function describeCalendarError(error: CalendarApiError): string {
  switch (error.status) {
    case 401:
      return RECONNECT_MESSAGE;
    case 403:
      if (/has not been used|is disabled|not enabled/i.test(error.message)) return CALENDAR_API_OFF_MESSAGE;
      if (/insufficient|scope|permission/i.test(error.message)) return CALENDAR_ACCESS_MESSAGE;
      return `Google Calendar refused the request (403): ${error.message}`;
    case 404:
    case 410:
      return "Google Calendar could not find that event. It may have been deleted already.";
    case 429:
      return "Google Calendar is limiting requests right now. Wait a minute and try again.";
    default:
      if (error.status >= 500) {
        return `Google Calendar is not answering properly right now (${error.status}: ${error.message}). Try again in a moment.`;
      }
      return `Google Calendar refused the request (${error.status}): ${error.message}`;
  }
}

/** The plain message a tool error carries back to Claude. */
export function describeError(error: unknown): string {
  if (error instanceof ToolError) return error.message;
  if (error instanceof CalendarApiError) return describeCalendarError(error);
  if (error instanceof TasksApiError) {
    switch (error.status) {
      case 401:
        return RECONNECT_MESSAGE;
      case 404:
        return "Google Tasks could not find that task or task list. list_task_lists and list_tasks show the current ids.";
      case 429:
        return "Google Tasks is limiting requests right now. Wait a minute and try again.";
      default:
        if (error.status >= 500) {
          return `Google Tasks is not answering properly right now (${error.status}: ${error.message}). Try again in a moment.`;
        }
        return `Google Tasks refused the request (${error.status}): ${error.message}`;
    }
  }
  return "Something went wrong on the Google Tasks connector's server. Try again in a moment.";
}
