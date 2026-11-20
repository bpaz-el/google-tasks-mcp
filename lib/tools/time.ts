/**
 * Clock times for scheduling. schedule_task takes a wall-clock time such as
 * 2026-11-21T14:00 and a time zone, and needs the instant it names.
 */

export const LOCAL_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Seconds between the Unix epoch and 2001-01-01T00:00:00Z, the reference date Apple's frameworks count from. */
const APPLE_EPOCH_OFFSET = 978_307_200;

/** True when Intl knows this IANA zone name. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** True for a real wall-clock time in YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS form. */
export function isLocalTime(value: string): boolean {
  const match = LOCAL_TIME_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  if (hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** What the clock in `zone` reads at `instant`, as if that reading were UTC. */
function wallClockAsUtc(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second"));
}

/**
 * The instant, in milliseconds since the Unix epoch, when the clock in `zone`
 * reads `local`. A time skipped by a daylight-saving jump moves forward by
 * the size of the jump, and a time that happens twice takes the first one.
 */
export function zonedTimeToInstant(local: string, zone: string): number {
  const match = LOCAL_TIME_PATTERN.exec(local);
  if (!match) throw new RangeError(`Not a local time: ${local}`);
  const [year, month, day, hour, minute, seconds] = match.slice(1).map((part) => Number(part ?? 0));
  const wanted = Date.UTC(year, month - 1, day, hour, minute, seconds);

  // Guess that the zone is UTC, then correct by how far off its clock was.
  // The second guess uses the offset at the first, which settles times next
  // to a daylight-saving change.
  const first = wanted - (wallClockAsUtc(wanted, zone) - wanted);
  const second = wanted - (wallClockAsUtc(first, zone) - first);
  const firstFits = wallClockAsUtc(first, zone) === wanted;
  const secondFits = wallClockAsUtc(second, zone) === wanted;
  if (firstFits && secondFits) return Math.min(first, second);
  if (secondFits) return second;
  // Either it fits, or the time was skipped and this is the moved-forward reading.
  return first;
}

/** Whole seconds since 2001-01-01T00:00:00Z. */
export function toAppleSeconds(instant: number): number {
  return Math.floor(instant / 1000) - APPLE_EPOCH_OFFSET;
}

/** 2026-11-21T20:00:00.000Z becomes 2026-11-21T20:00:00Z, the shortest form Google accepts. */
export function toRfc3339(instant: number): string {
  return new Date(instant).toISOString().replace(".000Z", "Z");
}
