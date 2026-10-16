/**
 * The office calendar, held where the synchronous deadline arithmetic can
 * read it - the same arrangement as `workflowPolicy.ts`, and for the same
 * reason: `dueAtFor` runs on every queue row and cannot afford a database
 * read, and a holiday added this morning has to count this morning.
 *
 * Agreed after the fit-gap review: a deadline ends at the end of the working
 * day in the office's time zone, and public holidays are not working days.
 * Pushed in at boot and after every change. Imports nothing, like its twin.
 */

export type OfficeCalendar = {
  /** An IANA zone, "Asia/Karachi". "UTC" keeps the arithmetic as it was. */
  timeZone: string;
  /** Holiday dates as YYYY-MM-DD, in the office's own calendar. */
  holidays: ReadonlySet<string>;
};

/** What a deployment with nothing stored gets: OFFICE_TIME_ZONE, or UTC. */
export function environmentTimeZone(): string {
  const configured = process.env.OFFICE_TIME_ZONE?.trim();
  return configured && isTimeZone(configured) ? configured : "UTC";
}

let stored: { timeZone: string | null; holidays: ReadonlySet<string> } = {
  timeZone: null,
  holidays: new Set(),
};

export function useOfficeCalendar(next: {
  timeZone: string | null;
  holidays: Iterable<string>;
}): void {
  stored = { timeZone: next.timeZone, holidays: new Set(next.holidays) };
}

export function officeCalendar(): OfficeCalendar {
  return {
    timeZone: stored.timeZone ?? environmentTimeZone(),
    holidays: stored.holidays,
  };
}

/** Whether this runtime knows the zone. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * The wall clock in `timeZone` at `instant`, as a Date whose UTC fields read
 * that wall clock. The arithmetic below works on these, so weekdays and
 * holidays are the office's and not Greenwich's.
 */
export function wallClock(instant: Date, timeZone: string): Date {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;

  return new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      instant.getUTCMilliseconds()
    )
  );
}

/** The real instant a wall-clock reading in `timeZone` names. */
export function instantOf(wall: Date, timeZone: string): Date {
  // Guess with the offset at the wall time read as UTC, then correct once
  // with the offset at the guess - which settles every zone, DST included.
  const offsetAt = (instant: Date) => wallClock(instant, timeZone).getTime() - instant.getTime();
  const guess = new Date(wall.getTime() - offsetAt(wall));
  return new Date(wall.getTime() - offsetAt(guess));
}
