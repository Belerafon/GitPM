import { addDays, clipToWindow, inclusiveDayCount, isIsoDate } from "./vacation-calendar-model.js";

export const ANNUAL_VACATION_DAYS = 28;

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

export function vacationYearBalance(events: readonly AvailabilityRecord[], today: string, allowance = ANNUAL_VACATION_DAYS): VacationYearBalance {
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
      taken += inclusiveDayCount(clipped.start, clipped.finish);
      continue;
    }
    if (clipped.start >= today) {
      planned += inclusiveDayCount(clipped.start, clipped.finish);
      continue;
    }
    taken += inclusiveDayCount(clipped.start, addDays(today, -1));
    planned += inclusiveDayCount(today, clipped.finish);
  }
  return { taken, planned, remaining: Math.max(0, allowance - taken), allowance };
}
