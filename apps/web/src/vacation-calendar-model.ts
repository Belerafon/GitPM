export const VACATION_CALENDAR_MONTHS = [3, 6, 12] as const;
export type VacationCalendarMonths = (typeof VACATION_CALENDAR_MONTHS)[number];
export const VACATION_CALENDAR_DAY_WIDTH: Readonly<Record<VacationCalendarMonths, number>> = { 3: 14, 6: 10, 12: 7 };
export const VACATION_CALENDAR_ROW_HEIGHT = 44;
export const VACATION_CALENDAR_HEADER_HEIGHT = 42;

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export interface VacationPerson {
  readonly id: string;
  readonly name: string;
  readonly lifecycle: string;
}

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

export function vacationCalendarWindow(today: string, months: VacationCalendarMonths): VacationCalendarWindow {
  const start = monthStart(today);
  const finish = lastDayOfMonth(addMonths(start, months - 1));
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
  const dayWidth = VACATION_CALENDAR_DAY_WIDTH[months];
  return { start, finish, days, months: segments, dayWidth, timelineWidth: days.length * dayWidth };
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

export function vacationBars(events: readonly VacationEvent[], people: readonly VacationPerson[], window: VacationCalendarWindow, filters: VacationCalendarFilters): readonly VacationCalendarBar[] {
  const visible = new Set(people.map((person) => person.id));
  return events.flatMap((event) => {
    if (!visible.has(event.personId) || !isCountableEvent(event, filters)) return [];
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
      days: inclusiveDayCount(event.start, event.finish),
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
