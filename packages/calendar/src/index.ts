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

export interface AvailabilityException {
  readonly start: string;
  readonly finish: string;
  readonly availability_percent: number;
}

export type CalendarPresetId =
  | "standard-five-day"
  | "russia-2026-five-day"
  | "united-states-federal-2026-2030-five-day"
  | "every-day";

export type CalendarPresetGroup = "custom" | "russia" | "united-states";

export interface CalendarPreset extends CalendarDefinition {
  readonly id: CalendarPresetId;
  readonly group: CalendarPresetGroup;
  readonly default_name: string;
  readonly coverage?: {
    readonly start: string;
    readonly due: string;
  };
  readonly source_url?: string;
}

const CALENDAR_PRESETS_BY_ID: Readonly<Record<CalendarPresetId, CalendarPreset>> = {
  "standard-five-day": {
    id: "standard-five-day",
    group: "custom",
    default_name: "Standard five-day week",
    working_weekdays: [1, 2, 3, 4, 5],
    holidays: [],
  },
  "russia-2026-five-day": {
    id: "russia-2026-five-day",
    group: "russia",
    default_name: "Russia — five-day week (2026)",
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
  "united-states-federal-2026-2030-five-day": {
    id: "united-states-federal-2026-2030-five-day",
    group: "united-states",
    default_name: "United States — federal holidays (2026–2030)",
    working_weekdays: [1, 2, 3, 4, 5],
    holidays: [
      "2026-01-01",
      "2026-01-19",
      "2026-02-16",
      "2026-05-25",
      "2026-06-19",
      "2026-07-03",
      "2026-09-07",
      "2026-10-12",
      "2026-11-11",
      "2026-11-26",
      "2026-12-25",
      "2027-01-01",
      "2027-01-18",
      "2027-02-15",
      "2027-05-31",
      "2027-06-18",
      "2027-07-05",
      "2027-09-06",
      "2027-10-11",
      "2027-11-11",
      "2027-11-25",
      "2027-12-24",
      "2027-12-31",
      "2028-01-17",
      "2028-02-21",
      "2028-05-29",
      "2028-06-19",
      "2028-07-04",
      "2028-09-04",
      "2028-10-09",
      "2028-11-10",
      "2028-11-23",
      "2028-12-25",
      "2029-01-01",
      "2029-01-15",
      "2029-02-19",
      "2029-05-28",
      "2029-06-19",
      "2029-07-04",
      "2029-09-03",
      "2029-10-08",
      "2029-11-12",
      "2029-11-22",
      "2029-12-25",
      "2030-01-01",
      "2030-01-21",
      "2030-02-18",
      "2030-05-27",
      "2030-06-19",
      "2030-07-04",
      "2030-09-02",
      "2030-10-14",
      "2030-11-11",
      "2030-11-28",
      "2030-12-25",
    ],
    coverage: {
      start: "2026-01-01",
      due: "2030-12-31",
    },
    source_url: "https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/",
  },
  "every-day": {
    id: "every-day",
    group: "custom",
    default_name: "Every day",
    working_weekdays: [1, 2, 3, 4, 5, 6, 7],
    holidays: [],
  },
};

export const CALENDAR_PRESETS: readonly CalendarPreset[] = Object.values(CALENDAR_PRESETS_BY_ID);

export function calendarPreset(id: string): CalendarPreset {
  const preset = CALENDAR_PRESETS_BY_ID[id as CalendarPresetId];
  if (preset === undefined) throw new CalendarError("CALENDAR_PRESET_UNKNOWN", `Unknown calendar preset: ${id}`);
  return preset;
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

/** Returns the effective availability for a date. Overlaps use the lowest value defensively. */
export function availabilityPercentOnDate(value: string, exceptions: readonly AvailabilityException[]): number {
  parseDateOnly(value);
  let percent = 100;
  for (const exception of exceptions) {
    parseDateOnly(exception.start);
    parseDateOnly(exception.finish);
    if (exception.start > exception.finish) throw new CalendarError("DATE_RANGE", "Availability start must not be after finish");
    if (!Number.isFinite(exception.availability_percent) || exception.availability_percent < 0 || exception.availability_percent > 100) {
      throw new CalendarError("AVAILABILITY_PERCENT_INVALID", "Availability percent must be between 0 and 100");
    }
    if (exception.start <= value && value <= exception.finish) percent = Math.min(percent, exception.availability_percent);
  }
  return percent;
}
