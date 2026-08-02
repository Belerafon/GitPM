import { formatDateOnly, isoWeekday, parseDateOnly, workingDatesBetween, type CalendarDefinition } from "@gitpm/calendar";
import { resolvePlanning, type ScheduleTracksConfig } from "@gitpm/scheduling";
import { activeProjectIds, isOperationalTask } from "@gitpm/shared";

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export interface WorkloadTask {
  readonly id: string;
  readonly project: string;
  readonly title: string;
  readonly lifecycle: "active" | "archived";
  readonly estimate_hours?: number;
  readonly start?: string;
  readonly finish?: string;
  readonly assignees?: readonly string[];
}

export interface WorkloadProject {
  readonly id: string;
  readonly lifecycle: "active" | "archived";
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
  readonly task_allocations: readonly TaskWeekAllocation[];
}

export interface TaskWeekAllocation {
  readonly task_id: string;
  readonly allocated_hours: number;
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

function weekStartsBetween(start: string, finish: string): string[] {
  const first = dayTime(isoWeekStart(start));
  const last = dayTime(isoWeekStart(finish));
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
  projects: readonly WorkloadProject[],
): WorkloadReport {
  const activeProjects = activeProjectIds(projects);
  const activeCalendars = new Map(calendars.filter((calendar) => calendar.lifecycle === "active").map((calendar) => [calendar.id, calendar]));
  const activePeople = new Map(people.filter((person) => person.lifecycle === "active" && activeCalendars.has(person.calendar)).map((person) => [person.id, person]));
  const exclusions = { archived: 0, undated: 0, unestimated: 0, unassigned: 0, unavailable_assignees: 0 };
  const included: { task: WorkloadTask; assignees: readonly WorkloadPerson[]; assigneeCount: number }[] = [];

  for (const task of tasks) {
    if (!isOperationalTask(task, activeProjects)) { exclusions.archived += 1; continue; }
    if (task.start === undefined || task.finish === undefined || !DATE_PATTERN.test(task.start) || !DATE_PATTERN.test(task.finish) || dayTime(task.start) > dayTime(task.finish)) { exclusions.undated += 1; continue; }
    if (task.estimate_hours === undefined || !Number.isFinite(task.estimate_hours) || task.estimate_hours < 0) { exclusions.unestimated += 1; continue; }
    if (task.assignees === undefined || task.assignees.length === 0) { exclusions.unassigned += 1; continue; }
    const assignees = task.assignees.flatMap((id) => { const person = activePeople.get(id); return person === undefined ? [] : [person]; });
    if (assignees.length !== task.assignees.length) exclusions.unavailable_assignees += 1;
    if (assignees.length === 0) continue;
    included.push({ task, assignees, assigneeCount: task.assignees.length });
  }

  if (included.length === 0) return { formula: "equal-assignee-share/equal-person-working-day/v1", weeks: [], rows: [], included_tasks: 0, exclusions };
  const first = included.reduce((value, item) => dayTime(item.task.start!) < dayTime(value) ? item.task.start! : value, included[0]!.task.start!);
  const last = included.reduce((value, item) => dayTime(item.task.finish!) > dayTime(value) ? item.task.finish! : value, included[0]!.task.finish!);
  const weeks = weekStartsBetween(first, last);
  const allocations = new Map<string, { hours: number; taskHours: Map<string, number> }>();

  for (const { task, assignees, assigneeCount } of included) {
    const personShare = task.estimate_hours! / assigneeCount;
    for (const person of assignees) {
      const calendar = activeCalendars.get(person.calendar)!;
      const dates = workingDatesBetween(task.start!, task.finish!, calendar);
      if (dates.length === 0) continue;
      const dailyShare = personShare / dates.length;
      for (const date of dates) {
        const key = `${person.id}:${isoWeekStart(date)}`;
        const allocation = allocations.get(key) ?? { hours: 0, taskHours: new Map<string, number>() };
        allocation.hours += dailyShare;
        allocation.taskHours.set(task.id, (allocation.taskHours.get(task.id) ?? 0) + dailyShare);
        allocations.set(key, allocation);
      }
    }
  }

  const rows = [...activePeople.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)).flatMap((person) => weeks.map((week): PersonWeekWorkload => {
    const allocation = allocations.get(`${person.id}:${week}`);
    const allocated = round(allocation?.hours ?? 0);
    const capacity = calendarCapacity(week, person, activeCalendars.get(person.calendar)!);
    const taskAllocations = [...(allocation?.taskHours ?? [])]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([taskId, hours]): TaskWeekAllocation => ({ task_id: taskId, allocated_hours: round(hours) }));
    return {
      person_id: person.id,
      person_name: person.name,
      week,
      allocated_hours: allocated,
      capacity_hours: capacity,
      utilization_percent: capacity === 0 ? null : round(allocated / capacity * 100),
      task_ids: taskAllocations.map((item) => item.task_id),
      task_allocations: taskAllocations,
    };
  }));
  return { formula: "equal-assignee-share/equal-person-working-day/v1", weeks, rows, included_tasks: included.length, exclusions };
}

export interface WorkloadEntityDocument extends Readonly<Record<string, unknown>> {
  readonly schema: string;
  readonly id?: string;
}

export interface WorkloadFilters {
  readonly project?: string;
  readonly milestone?: string;
  readonly team?: string;
}

export interface WorkloadWorkspaceInput {
  readonly tasks: readonly WorkloadEntityDocument[];
  readonly projects: readonly WorkloadEntityDocument[];
  readonly people: readonly WorkloadEntityDocument[];
  readonly calendars: readonly WorkloadEntityDocument[];
  readonly teams?: readonly WorkloadEntityDocument[];
  readonly scheduleTracks: WorkloadEntityDocument;
  readonly filters?: WorkloadFilters;
}

const documentText = (document: Readonly<Record<string, unknown>>, key: string): string | undefined => typeof document[key] === "string" ? document[key] : undefined;
const documentNumber = (document: Readonly<Record<string, unknown>>, key: string): number | undefined => typeof document[key] === "number" ? document[key] : undefined;
const documentStrings = (document: Readonly<Record<string, unknown>>, key: string): readonly string[] => Array.isArray(document[key]) ? (document[key] as readonly unknown[]).filter((item): item is string => typeof item === "string") : [];
const documentNumbers = (document: Readonly<Record<string, unknown>>, key: string): readonly number[] => Array.isArray(document[key]) ? (document[key] as readonly unknown[]).filter((item): item is number => typeof item === "number") : [];
const lifecycle = (document: Readonly<Record<string, unknown>>): "active" | "archived" => document.lifecycle === "archived" ? "archived" : "active";
const entityId = (document: WorkloadEntityDocument): string => documentText(document, "id") ?? "";

function scheduleWindow(document: WorkloadEntityDocument, track: string): Readonly<Record<string, unknown>> {
  const schedules = typeof document.schedules === "object" && document.schedules !== null ? document.schedules as Readonly<Record<string, unknown>> : {};
  const window = schedules[track];
  return typeof window === "object" && window !== null ? window as Readonly<Record<string, unknown>> : {};
}

/** Builds the repository-level workload read model used by the HTTP API, CLI and GUI. */
export function buildWorkloadReport(input: WorkloadWorkspaceInput): WorkloadReport {
  const filters = input.filters ?? {};
  const projectById = new Map(input.projects.map((project) => [entityId(project), project]));
  const config = input.scheduleTracks as unknown as ScheduleTracksConfig;
  const teamMembers = filters.team === undefined
    ? undefined
    : new Set(documentStrings(input.teams?.find((team) => entityId(team) === filters.team) ?? {}, "members"));
  const selectedTasks = input.tasks.filter((task) => {
    if (filters.project !== undefined && documentText(task, "project") !== filters.project) return false;
    if (filters.milestone !== undefined && documentText(task, "milestone") !== filters.milestone) return false;
    return teamMembers === undefined || documentStrings(task, "assignees").some((id) => teamMembers.has(id));
  });
  const tasks = selectedTasks.map((task): WorkloadTask => {
    const project = documentText(task, "project") ?? "";
    const projectDocument = projectById.get(project);
    const planning = typeof projectDocument?.planning === "object" && projectDocument.planning !== null
      ? projectDocument.planning as Parameters<typeof resolvePlanning>[1]
      : undefined;
    const track = resolvePlanning(config, planning).workload_track;
    const window = scheduleWindow(task, track);
    return {
      id: entityId(task), project, title: documentText(task, "title") ?? entityId(task), lifecycle: lifecycle(task),
      estimate_hours: documentNumber(window, "effort_hours"), start: documentText(window, "start"), finish: documentText(window, "finish"), assignees: documentStrings(task, "assignees"),
    };
  });
  const projects = input.projects.map((project): WorkloadProject => ({ id: entityId(project), lifecycle: lifecycle(project) }));
  const people = input.people.map((person): WorkloadPerson => ({
    id: entityId(person), name: documentText(person, "name") ?? entityId(person), lifecycle: lifecycle(person),
    weekly_capacity_hours: documentNumber(person, "weekly_capacity_hours") ?? 0, calendar: documentText(person, "calendar") ?? "",
  }));
  const calendars = input.calendars.map((calendar): WorkloadCalendar => ({
    id: entityId(calendar), lifecycle: lifecycle(calendar), working_weekdays: documentNumbers(calendar, "working_weekdays"), holidays: documentStrings(calendar, "holidays"),
  }));
  return calculateWorkload(tasks, people, calendars, projects);
}
