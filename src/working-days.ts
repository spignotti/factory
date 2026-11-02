/**
 * Working-day arithmetic for operator timeouts. Weekends are Sat/Sun in the given
 * timezone; public holidays are not special. Europe/Berlin is the factory default.
 */

export const BERLIN = "Europe/Berlin";

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

export interface ZonedClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

/** Wall clock in `timeZone` (en-US weekday abbreviations: Mon … Sun). */
export function zonedParts(date: Date, timeZone: string): ZonedClock {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const bag: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== "literal") bag[p.type] = p.value;
  const hour = bag.hour === "24" ? 0 : Number(bag.hour);
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
    weekday: bag.weekday ?? "",
  };
}

/** Milliseconds to add to UTC to get the clock in `timeZone` at `date`. */
function offsetMs(date: Date, timeZone: string): number {
  const z = zonedParts(date, timeZone);
  return Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second) - date.getTime();
}

function zonedTimeToUtc(z: Omit<ZonedClock, "weekday">, timeZone: string): Date {
  const utcGuess = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  const off1 = offsetMs(new Date(utcGuess), timeZone);
  let t = utcGuess - off1;
  const off2 = offsetMs(new Date(t), timeZone);
  if (off2 !== off1) t = utcGuess - off2;
  return new Date(t);
}

function addCalendarDay(z: ZonedClock): ZonedClock {
  const utc = new Date(Date.UTC(z.year, z.month - 1, z.day + 1));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][utc.getUTCDay()]!;
  return { ...z, year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate(), weekday };
}

/**
 * The instant `workingDays` Mon–Fri days after `from`, same clock time in `timeZone`.
 * A weekend start does not count until the next weekday (Saturday + 2 = Tuesday).
 */
export function addWorkingDays(from: Date, workingDays: number, timeZone = BERLIN): Date {
  if (workingDays <= 0) return new Date(from.getTime());
  let z = zonedParts(from, timeZone);
  let left = Math.floor(workingDays);
  while (left > 0) {
    z = addCalendarDay(z);
    if (WEEKDAYS.has(z.weekday)) left--;
  }
  return zonedTimeToUtc(z, timeZone);
}

/** True once `workingDays` Mon–Fri days have passed since `from` (the deadline instant is included). */
export function workingDaysElapsed(from: Date, now: Date, workingDays: number, timeZone = BERLIN): boolean {
  return now.getTime() >= addWorkingDays(from, workingDays, timeZone).getTime();
}
