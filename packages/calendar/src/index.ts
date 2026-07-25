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

export type CalendarPresetId = "standard-five-day" | "russia-2026-five-day" | "every-day";

export interface CalendarPreset extends CalendarDefinition {
  readonly id: CalendarPresetId;
  readonly coverage?: {
    readonly start: string;
    readonly due: string;
  };
  readonly source_url?: string;
}

const CALENDAR_PRESETS_BY_ID: Readonly<Record<CalendarPresetId, CalendarPreset>> = {
  "standard-five-day": {
    id: "standard-five-day",
    working_weekdays: [1, 2, 3, 4, 5],
    holidays: [],
  },
  "russia-2026-five-day": {
    id: "russia-2026-five-day",
    working_weekdays: [1, 2, 3, 4, 5],
    holidays: [
      "2026-01-01",
      "2026-01-02",
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
      "2026-01-09",
      "2026-02-23",
      "2026-03-09",
      "2026-05-01",
      "2026-05-11",
      "2026-06-12",
      "2026-11-04",
      "2026-12-31",
    ],
    coverage: {
      start: "2026-01-01",
      due: "2026-12-31",
    },
    source_url: "https://government.ru/news/56309/",
  },
  "every-day": {
    id: "every-day",
    working_weekdays: [1, 2, 3, 4, 5, 6, 7],
    holidays: [],
  },
};

export const CALENDAR_PRESETS: readonly CalendarPreset[] = Object.values(CALENDAR_PRESETS_BY_ID);

export function calendarPreset(id: CalendarPresetId): CalendarPreset {
  return CALENDAR_PRESETS_BY_ID[id];
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
