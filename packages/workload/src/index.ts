import { formatDateOnly, isoWeekday, parseDateOnly, workingDatesBetween, type CalendarDefinition } from "@gitpm/calendar";

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export interface WorkloadTask {
  readonly id: string;
  readonly title: string;
  readonly lifecycle: "active" | "archived";
  readonly estimate_hours?: number;
  readonly start?: string;
  readonly due?: string;
  readonly assignees?: readonly string[];
}

export interface WorkloadPerson {
  readonly id: string;
  readonly name: string;
  readonly lifecycle: "active" | "archived";
  readonly weekly_capacity_hours: number;
  readonly calendar: string;
}

export interface WorkloadCalendar extends CalendarDefinition {
  readonly id: string;
  readonly lifecycle: "active" | "archived";
}

export interface PersonWeekWorkload {
  readonly person_id: string;
  readonly person_name: string;
  readonly week: string;
  readonly allocated_hours: number;
  readonly capacity_hours: number;
  readonly utilization_percent: number | null;
  readonly task_ids: readonly string[];
}

export interface WorkloadExclusions {
  readonly archived: number;
  readonly undated: number;
  readonly unestimated: number;
  readonly unassigned: number;
  readonly unavailable_assignees: number;
}

export interface WorkloadReport {
  readonly formula: "equal-assignee-share/equal-person-working-day/v1";
  readonly weeks: readonly string[];
  readonly rows: readonly PersonWeekWorkload[];
  readonly included_tasks: number;
  readonly exclusions: WorkloadExclusions;
}

const round = (value: number): number => Math.round((value + Number.EPSILON) * 10_000) / 10_000;
const dayTime = (value: string): number => parseDateOnly(value).getTime();

export function isoWeekStart(value: string): string {
  const date = parseDateOnly(value);
  date.setUTCDate(date.getUTCDate() - (isoWeekday(value) - 1));
  return formatDateOnly(date);
}

function weekStartsBetween(start: string, due: string): string[] {
  const first = dayTime(isoWeekStart(start));
  const last = dayTime(isoWeekStart(due));
  const result: string[] = [];
  for (let time = first; time <= last; time += 7 * DAY_MS) result.push(formatDateOnly(new Date(time)));
  return result;
}

function calendarCapacity(week: string, person: WorkloadPerson, calendar: WorkloadCalendar): number {
  if (calendar.working_weekdays.length === 0) return 0;
  const sunday = formatDateOnly(new Date(dayTime(week) + 6 * DAY_MS));
  const availableDays = workingDatesBetween(week, sunday, calendar).length;
  return round(person.weekly_capacity_hours * availableDays / calendar.working_weekdays.length);
}

export function calculateWorkload(
  tasks: readonly WorkloadTask[],
  people: readonly WorkloadPerson[],
  calendars: readonly WorkloadCalendar[],
): WorkloadReport {
  const activeCalendars = new Map(calendars.filter((calendar) => calendar.lifecycle === "active").map((calendar) => [calendar.id, calendar]));
  const activePeople = new Map(people.filter((person) => person.lifecycle === "active" && activeCalendars.has(person.calendar)).map((person) => [person.id, person]));
  const exclusions = { archived: 0, undated: 0, unestimated: 0, unassigned: 0, unavailable_assignees: 0 };
  const included: { task: WorkloadTask; assignees: readonly WorkloadPerson[] }[] = [];

  for (const task of tasks) {
    if (task.lifecycle !== "active") { exclusions.archived += 1; continue; }
    if (task.start === undefined || task.due === undefined || !DATE_PATTERN.test(task.start) || !DATE_PATTERN.test(task.due) || dayTime(task.start) > dayTime(task.due)) { exclusions.undated += 1; continue; }
    if (task.estimate_hours === undefined || !Number.isFinite(task.estimate_hours) || task.estimate_hours < 0) { exclusions.unestimated += 1; continue; }
    if (task.assignees === undefined || task.assignees.length === 0) { exclusions.unassigned += 1; continue; }
    const assignees = task.assignees.flatMap((id) => { const person = activePeople.get(id); return person === undefined ? [] : [person]; });
    if (assignees.length === 0) { exclusions.unavailable_assignees += 1; continue; }
    included.push({ task, assignees });
  }

  if (included.length === 0) return { formula: "equal-assignee-share/equal-person-working-day/v1", weeks: [], rows: [], included_tasks: 0, exclusions };
  const first = included.reduce((value, item) => dayTime(item.task.start!) < dayTime(value) ? item.task.start! : value, included[0]!.task.start!);
  const last = included.reduce((value, item) => dayTime(item.task.due!) > dayTime(value) ? item.task.due! : value, included[0]!.task.due!);
  const weeks = weekStartsBetween(first, last);
  const allocations = new Map<string, { hours: number; taskIds: Set<string> }>();

  for (const { task, assignees } of included) {
    const personShare = task.estimate_hours! / assignees.length;
    for (const person of assignees) {
      const calendar = activeCalendars.get(person.calendar)!;
      const dates = workingDatesBetween(task.start!, task.due!, calendar);
      if (dates.length === 0) continue;
      const dailyShare = personShare / dates.length;
      for (const date of dates) {
        const key = `${person.id}:${isoWeekStart(date)}`;
        const allocation = allocations.get(key) ?? { hours: 0, taskIds: new Set<string>() };
        allocation.hours += dailyShare;
        allocation.taskIds.add(task.id);
        allocations.set(key, allocation);
      }
    }
  }

  const rows = [...activePeople.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)).flatMap((person) => weeks.map((week): PersonWeekWorkload => {
    const allocation = allocations.get(`${person.id}:${week}`);
    const allocated = round(allocation?.hours ?? 0);
    const capacity = calendarCapacity(week, person, activeCalendars.get(person.calendar)!);
    return {
      person_id: person.id,
      person_name: person.name,
      week,
      allocated_hours: allocated,
      capacity_hours: capacity,
      utilization_percent: capacity === 0 ? null : round(allocated / capacity * 100),
      task_ids: [...(allocation?.taskIds ?? [])].sort(),
    };
  }));
  return { formula: "equal-assignee-share/equal-person-working-day/v1", weeks, rows, included_tasks: included.length, exclusions };
}
