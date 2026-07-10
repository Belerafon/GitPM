const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DAY_MS = 86_400_000;

export class CalendarError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CalendarError";
  }
}

export interface CalendarDefinition {
  readonly working_weekdays: readonly number[];
  readonly holidays: readonly string[];
}

export function parseDateOnly(value: string): Date {
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new CalendarError("DATE_INVALID", `Invalid date-only value: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new CalendarError("DATE_INVALID", `Invalid calendar date: ${value}`);
  }
  return date;
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isoWeekday(value: string): number {
  const weekday = parseDateOnly(value).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function validateCalendar(calendar: CalendarDefinition): void {
  if (calendar.working_weekdays.some((weekday) => !Number.isInteger(weekday) || weekday < 1 || weekday > 7)) {
    throw new CalendarError("CALENDAR_WEEKDAY_INVALID", "Working weekdays must be ISO values 1-7");
  }
  if (new Set(calendar.working_weekdays).size !== calendar.working_weekdays.length) {
    throw new CalendarError("CALENDAR_WEEKDAY_DUPLICATE", "Working weekdays must be unique");
  }
  for (const holiday of calendar.holidays) parseDateOnly(holiday);
  if (new Set(calendar.holidays).size !== calendar.holidays.length) {
    throw new CalendarError("CALENDAR_HOLIDAY_DUPLICATE", "Holidays must be unique");
  }
}

export function isWorkingDate(value: string, calendar: CalendarDefinition): boolean {
  validateCalendar(calendar);
  return calendar.working_weekdays.includes(isoWeekday(value)) && !calendar.holidays.includes(value);
}

export function workingDatesBetween(start: string, due: string, calendar: CalendarDefinition): string[] {
  validateCalendar(calendar);
  const startDate = parseDateOnly(start);
  const dueDate = parseDateOnly(due);
  if (startDate.getTime() > dueDate.getTime()) {
    throw new CalendarError("DATE_RANGE", "Start must not be after due");
  }
  const result: string[] = [];
  for (let time = startDate.getTime(); time <= dueDate.getTime(); time += DAY_MS) {
    const value = formatDateOnly(new Date(time));
    if (calendar.working_weekdays.includes(isoWeekday(value)) && !calendar.holidays.includes(value)) result.push(value);
  }
  return result;
}
