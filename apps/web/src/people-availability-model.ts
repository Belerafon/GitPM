import { addDays, clipToWindow, DEFAULT_WORKING_CALENDAR, isIsoDate, workingDayCount, type WorkingCalendar } from "./vacation-calendar-model.js";

export const ANNUAL_VACATION_DAYS = 20;

export function annualVacationAllowance(extraDays = 0): number {
  return ANNUAL_VACATION_DAYS + (Number.isInteger(extraDays) && extraDays > 0 ? extraDays : 0);
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

export function isPastAbsence(finish: string, today: string): boolean {
  return finish < today;
}

export function currentAbsence(events: readonly AvailabilityRecord[], today: string): AvailabilityRecord | undefined {
  return events.find((event) => event.lifecycle === "active" && event.state !== "cancelled" && isIsoDate(event.start) && isIsoDate(event.finish) && event.start <= today && today <= event.finish);
}

export function vacationYearBalance(events: readonly AvailabilityRecord[], today: string, calendar: WorkingCalendar = DEFAULT_WORKING_CALENDAR, allowance = ANNUAL_VACATION_DAYS): VacationYearBalance {
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
