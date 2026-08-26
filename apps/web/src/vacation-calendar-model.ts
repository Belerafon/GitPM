export const VACATION_CALENDAR_PERIODS = [3, 6, 12, "year"] as const;
export type VacationCalendarPeriod = (typeof VACATION_CALENDAR_PERIODS)[number];
export const VACATION_CALENDAR_DAY_WIDTH: Readonly<Record<VacationCalendarPeriod, number>> = { 3: 14, 6: 10, 12: 7, year: 7 };
export const VACATION_CALENDAR_ROW_HEIGHT = 58;
export const VACATION_CALENDAR_MONTH_HEADER_HEIGHT = 36;
export const VACATION_CALENDAR_DAY_HEADER_HEIGHT = 24;
export const VACATION_CALENDAR_HEADER_HEIGHT = VACATION_CALENDAR_MONTH_HEADER_HEIGHT + VACATION_CALENDAR_DAY_HEADER_HEIGHT;

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export interface VacationPerson {
  readonly id: string;
  readonly name: string;
  readonly lifecycle: string;
  readonly calendarId: string;
}

export interface WorkingCalendar {
  readonly workingWeekdays: readonly number[];
  readonly holidays: readonly string[];
}

export const DEFAULT_WORKING_CALENDAR: WorkingCalendar = { workingWeekdays: [1, 2, 3, 4, 5], holidays: [] };

export interface VacationTeam {
  readonly id: string;
  readonly name: string;
  readonly members: readonly string[];
  readonly lifecycle: string;
}

export interface VacationEvent {
  readonly id: string;
  readonly personId: string;
  readonly start: string;
  readonly finish: string;
  readonly kind: string;
  readonly state: string;
  readonly note: string;
  readonly lifecycle: string;
}

export interface VacationCalendarFilters {
  readonly teamId: string;
  readonly personId: string;
  readonly kind: string;
  readonly state: string;
  readonly search: string;
}

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

export interface VacationCalendarSummary {
  readonly absentToday: number;
  readonly leavingSoon: number;
  readonly maxOverlap: number;
}

export const emptyVacationFilters = (): VacationCalendarFilters => ({ teamId: "", personId: "", kind: "", state: "", search: "" });

export function localCalendarDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isIsoDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return parsed.toISOString().slice(0, 10) === value;
}

export function dayNumber(value: string): number {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / DAY_MS);
}

export function isoDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function inclusiveDayCount(start: string, finish: string): number {
  return dayNumber(finish) - dayNumber(start) + 1;
}

export function addDays(value: string, days: number): string {
  return isoDate(dayNumber(value) + days);
}

export function monthStart(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

export function addMonths(value: string, months: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

export function lastDayOfMonth(value: string): string {
  const date = new Date(`${monthStart(value)}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

export function rangesOverlap(start: string, finish: string, otherStart: string, otherFinish: string): boolean {
  return start <= otherFinish && otherStart <= finish;
}

export function clipToWindow(start: string, finish: string, windowStart: string, windowFinish: string): { readonly start: string; readonly finish: string } | undefined {
  if (finish < windowStart || start > windowFinish) return undefined;
  return { start: start < windowStart ? windowStart : start, finish: finish > windowFinish ? windowFinish : finish };
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

export function isWorkingDay(value: string, calendar: WorkingCalendar = DEFAULT_WORKING_CALENDAR): boolean {
  return calendar.workingWeekdays.includes(isoWeekday(value)) && !calendar.holidays.includes(value);
}

export function isWeekend(value: string, calendar: WorkingCalendar = DEFAULT_WORKING_CALENDAR): boolean {
  return !isWorkingDay(value, calendar);
}

export function workingDayCount(start: string, finish: string, calendar: WorkingCalendar = DEFAULT_WORKING_CALENDAR): number {
  if (start > finish) return 0;
  let count = 0;
  for (let day = dayNumber(start); day <= dayNumber(finish); day += 1) {
    if (isWorkingDay(isoDate(day), calendar)) count += 1;
  }
  return count;
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

export function isCountableEvent(event: VacationEvent, filters: VacationCalendarFilters): boolean {
  if (event.lifecycle !== "active" || !isIsoDate(event.start) || !isIsoDate(event.finish) || event.start > event.finish) return false;
  if (filters.kind !== "" && event.kind !== filters.kind) return false;
  if (filters.state !== "") return event.state === filters.state;
  return event.state !== "cancelled";
}

export function visiblePeople(people: readonly VacationPerson[], teams: readonly VacationTeam[], filters: VacationCalendarFilters): readonly VacationPerson[] {
  const team = filters.teamId === "" ? undefined : teams.find((item) => item.id === filters.teamId && item.lifecycle === "active");
  const members = team === undefined ? undefined : new Set(team.members);
  const query = filters.search.trim().toLowerCase();
  return people
    .filter((person) => person.lifecycle === "active")
    .filter((person) => members === undefined || members.has(person.id))
    .filter((person) => filters.personId === "" || person.id === filters.personId)
    .filter((person) => query === "" || person.name.toLowerCase().includes(query))
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
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

export function vacationSummary(events: readonly VacationEvent[], people: readonly VacationPerson[], window: VacationCalendarWindow, filters: VacationCalendarFilters, today: string): VacationCalendarSummary {
  const visible = new Set(people.map((person) => person.id));
  const countable = events.filter((event) => visible.has(event.personId) && isCountableEvent(event, filters));
  const absent = new Set<string>();
  const leaving = new Set<string>();
  const until = addDays(today, 30);
  for (const event of countable) {
    if (event.start <= today && today <= event.finish) absent.add(event.personId);
    if (event.start > today && event.start <= until) leaving.add(event.personId);
  }
  let maxOverlap = 0;
  const overlapping = countable.filter((event) => rangesOverlap(event.start, event.finish, window.start, window.finish));
  for (const day of window.days) {
    const present = new Set<string>();
    for (const event of overlapping) {
      if (event.start <= day && day <= event.finish) present.add(event.personId);
    }
    if (present.size > maxOverlap) maxOverlap = present.size;
  }
  return { absentToday: absent.size, leavingSoon: leaving.size, maxOverlap };
}
