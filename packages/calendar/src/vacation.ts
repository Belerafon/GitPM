const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MS = 86_400_000;

export const ANNUAL_VACATION_DAYS = 20;

export interface WorkingCalendar {
  readonly workingWeekdays: readonly number[];
  readonly holidays: readonly string[];
}

export const DEFAULT_WORKING_CALENDAR: WorkingCalendar = { workingWeekdays: [1, 2, 3, 4, 5], holidays: [] };

export interface VacationPerson {
  readonly id: string;
  readonly name: string;
  readonly lifecycle: string;
  readonly calendarId: string;
  readonly extraDays: number;
  readonly extraDaysReason: string;
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

export interface VacationCalendarSummary {
  readonly absentToday: number;
  readonly leavingSoon: number;
  readonly maxOverlap: number;
}

export interface AvailabilityRecord {
  readonly start: string;
  readonly finish: string;
  readonly kind: string;
  readonly state: string;
  readonly lifecycle: string;
}

export interface VacationYearBalance {
  readonly taken: number;
  readonly planned: number;
  readonly remaining: number;
  readonly allowance: number;
}

export const emptyVacationFilters = (): VacationCalendarFilters => ({ teamId: "", personId: "", kind: "", state: "", search: "" });

export function annualVacationAllowance(extraDays = 0): number {
  return ANNUAL_VACATION_DAYS + (Number.isInteger(extraDays) && extraDays > 0 ? extraDays : 0);
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

export function isoWeekdayUtc(value: string): number {
  const weekday = new Date(`${value}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function isWorkingDay(value: string, calendar: WorkingCalendar = DEFAULT_WORKING_CALENDAR): boolean {
  return calendar.workingWeekdays.includes(isoWeekdayUtc(value)) && !calendar.holidays.includes(value);
}

export function workingDayCount(start: string, finish: string, calendar: WorkingCalendar = DEFAULT_WORKING_CALENDAR): number {
  if (start > finish) return 0;
  let count = 0;
  for (let day = dayNumber(start); day <= dayNumber(finish); day += 1) {
    if (isWorkingDay(isoDate(day), calendar)) count += 1;
  }
  return count;
}

export function isPastAbsence(finish: string, today: string): boolean {
  return finish < today;
}

export function currentAbsence(events: readonly AvailabilityRecord[], today: string): AvailabilityRecord | undefined {
  return events.find((event) => event.lifecycle === "active" && event.state !== "cancelled" && isIsoDate(event.start) && isIsoDate(event.finish) && event.start <= today && today <= event.finish);
}

export function vacationYearBalance(
  events: readonly AvailabilityRecord[],
  today: string,
  calendar: WorkingCalendar = DEFAULT_WORKING_CALENDAR,
  allowance = ANNUAL_VACATION_DAYS,
): VacationYearBalance {
  const year = today.slice(0, 4);
  const yearStart = `${year}-01-01`;
  const yearFinish = `${year}-12-31`;
  let taken = 0;
  let planned = 0;
  for (const event of events) {
    if (event.lifecycle !== "active" || event.kind !== "vacation" || event.state === "cancelled") continue;
    if (!isIsoDate(event.start) || !isIsoDate(event.finish) || event.start > event.finish) continue;
    const clipped = clipToWindow(event.start, event.finish, yearStart, yearFinish);
    if (clipped === undefined) continue;
    if (clipped.finish < today) {
      taken += workingDayCount(clipped.start, clipped.finish, calendar);
      continue;
    }
    if (clipped.start >= today) {
      planned += workingDayCount(clipped.start, clipped.finish, calendar);
      continue;
    }
    taken += workingDayCount(clipped.start, addDays(today, -1), calendar);
    planned += workingDayCount(today, clipped.finish, calendar);
  }
  return { taken, planned, remaining: Math.max(0, allowance - taken), allowance };
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

export function vacationSummary(
  events: readonly VacationEvent[],
  people: readonly VacationPerson[],
  window: { readonly start: string; readonly finish: string; readonly days: readonly string[] },
  filters: VacationCalendarFilters,
  today: string,
): VacationCalendarSummary {
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
