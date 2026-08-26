export {
  DEFAULT_WORKING_CALENDAR,
  addDays,
  addMonths,
  clipToWindow,
  dayNumber,
  emptyVacationFilters,
  inclusiveDayCount,
  isCountableEvent,
  isIsoDate,
  isWorkingDay,
  isoDate,
  lastDayOfMonth,
  monthStart,
  rangesOverlap,
  vacationSummary,
  visiblePeople,
  workingDayCount,
  type VacationCalendarFilters,
  type VacationCalendarSummary,
  type VacationEvent,
  type VacationPerson,
  type VacationTeam,
  type WorkingCalendar,
} from "@gitpm/calendar";
import {
  DEFAULT_WORKING_CALENDAR,
  addMonths,
  clipToWindow,
  dayNumber,
  inclusiveDayCount,
  isCountableEvent,
  isoDate,
  isWorkingDay,
  lastDayOfMonth,
  monthStart,
  workingDayCount,
  type VacationCalendarFilters,
  type VacationEvent,
  type VacationPerson,
  type WorkingCalendar,
} from "@gitpm/calendar";

export const VACATION_CALENDAR_PERIODS = [3, 6, 12, "year"] as const;
export type VacationCalendarPeriod = (typeof VACATION_CALENDAR_PERIODS)[number];
export const VACATION_CALENDAR_DAY_WIDTH: Readonly<Record<VacationCalendarPeriod, number>> = { 3: 14, 6: 10, 12: 7, year: 7 };
export const VACATION_CALENDAR_ROW_HEIGHT = 58;
export const VACATION_CALENDAR_MONTH_HEADER_HEIGHT = 36;
export const VACATION_CALENDAR_DAY_HEADER_HEIGHT = 24;
export const VACATION_CALENDAR_HEADER_HEIGHT = VACATION_CALENDAR_MONTH_HEADER_HEIGHT + VACATION_CALENDAR_DAY_HEADER_HEIGHT;

export interface VacationCalendarBar {
  readonly id: string;
  readonly personId: string;
  readonly kind: string;
  readonly state: string;
  readonly start: string;
  readonly finish: string;
  readonly note: string;
  readonly days: number;
  readonly offset: number;
  readonly duration: number;
  readonly left: number;
  readonly width: number;
}

export interface VacationMonthSegment {
  readonly key: string;
  readonly days: number;
}

export interface VacationCalendarWindow {
  readonly start: string;
  readonly finish: string;
  readonly days: readonly string[];
  readonly months: readonly VacationMonthSegment[];
  readonly dayWidth: number;
  readonly timelineWidth: number;
}

export function localCalendarDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function barGeometry(start: string, finish: string, windowStart: string, dayWidth: number): { readonly offset: number; readonly duration: number; readonly left: number; readonly width: number } {
  const offset = dayNumber(start) - dayNumber(windowStart);
  const duration = inclusiveDayCount(start, finish);
  return { offset, duration, left: offset * dayWidth, width: duration * dayWidth };
}

export function isoWeekday(value: string): number {
  const weekday = new Date(`${value}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function isWeekend(value: string, calendar: WorkingCalendar = DEFAULT_WORKING_CALENDAR): boolean {
  return !isWorkingDay(value, calendar);
}

export function weekendBands(days: readonly string[], dayWidth: number, calendar: WorkingCalendar = DEFAULT_WORKING_CALENDAR): readonly { readonly start: string; readonly finish: string; readonly left: number; readonly width: number }[] {
  const bands: { start: string; finish: string; left: number; width: number }[] = [];
  for (let index = 0; index < days.length; index += 1) {
    const day = days[index]!;
    if (isWorkingDay(day, calendar)) continue;
    const last = bands.at(-1);
    if (last !== undefined && dayNumber(day) === dayNumber(last.finish) + 1) {
      last.finish = day;
      last.width += dayWidth;
      continue;
    }
    bands.push({ start: day, finish: day, left: index * dayWidth, width: dayWidth });
  }
  return bands;
}

export function hoverDayIndex(x: number, dayWidth: number, dayCount: number): number | undefined {
  if (dayWidth <= 0 || dayCount <= 0) return undefined;
  const index = Math.floor(x / dayWidth);
  if (index < 0 || index >= dayCount) return undefined;
  return index;
}

function buildWindow(start: string, finish: string, dayWidth: number): VacationCalendarWindow {
  const first = dayNumber(start);
  const last = dayNumber(finish);
  const days = Array.from({ length: last - first + 1 }, (_, index) => isoDate(first + index));
  const segments: { key: string; days: number }[] = [];
  for (const day of days) {
    const key = day.slice(0, 7);
    const current = segments.at(-1);
    if (current?.key === key) current.days += 1;
    else segments.push({ key, days: 1 });
  }
  return { start, finish, days, months: segments, dayWidth, timelineWidth: days.length * dayWidth };
}

export function vacationCalendarWindow(today: string, period: VacationCalendarPeriod): VacationCalendarWindow {
  if (period === "year") {
    const year = today.slice(0, 4);
    return buildWindow(`${year}-01-01`, `${year}-12-31`, VACATION_CALENDAR_DAY_WIDTH.year);
  }
  const start = monthStart(today);
  return buildWindow(start, lastDayOfMonth(addMonths(start, period - 1)), VACATION_CALENDAR_DAY_WIDTH[period]);
}

export function vacationBars(events: readonly VacationEvent[], people: readonly VacationPerson[], window: VacationCalendarWindow, filters: VacationCalendarFilters, calendars: ReadonlyMap<string, WorkingCalendar> = new Map()): readonly VacationCalendarBar[] {
  const visible = new Map(people.map((person) => [person.id, person]));
  return events.flatMap((event) => {
    const person = visible.get(event.personId);
    if (person === undefined || !isCountableEvent(event, filters)) return [];
    const clipped = clipToWindow(event.start, event.finish, window.start, window.finish);
    if (clipped === undefined) return [];
    const geometry = barGeometry(clipped.start, clipped.finish, window.start, window.dayWidth);
    return [{
      id: event.id,
      personId: event.personId,
      kind: event.kind,
      state: event.state,
      start: event.start,
      finish: event.finish,
      note: event.note,
      days: workingDayCount(event.start, event.finish, calendars.get(person.calendarId) ?? DEFAULT_WORKING_CALENDAR),
      ...geometry,
    }];
  });
}
