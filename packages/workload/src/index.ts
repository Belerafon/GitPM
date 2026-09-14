import { availabilityPercentOnDate, formatDateOnly, isoWeekday, parseDateOnly, workingDatesBetween, type AvailabilityException, type CalendarDefinition } from "@gitpm/calendar";
import { resolvePlanning, type ScheduleTracksConfig } from "@gitpm/scheduling";
import { activeProjectIds, DEFAULT_PERSON_NAME_FORMAT, formatPersonName, isOperationalTask, isPersonNameFormat } from "@gitpm/shared";

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

export interface WorkloadAvailabilityEvent extends AvailabilityException {
  readonly id: string;
  readonly person: string;
  readonly state: "planned" | "taken" | "cancelled";
  readonly lifecycle: "active" | "archived";
}

export interface PersonWeekWorkload {
  readonly person_id: string;
  readonly person_name: string;
  readonly week: string;
  readonly allocated_hours: number;
  readonly base_capacity_hours: number;
  readonly capacity_hours: number;
  readonly unavailable_hours: number;
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

export interface WorkloadPersonRef {
  readonly person_id: string;
  readonly person_name: string;
}

export interface WorkloadPersonCensus {
  readonly total_active: number;
  readonly scoped: number;
  readonly calculable: number;
  readonly without_calendar: readonly WorkloadPersonRef[];
}

export interface WorkloadReport {
  readonly formula: "equal-assignee-share/capacity-weighted-person-day/v2";
  readonly weeks: readonly string[];
  readonly rows: readonly PersonWeekWorkload[];
  readonly included_tasks: number;
  readonly exclusions: WorkloadExclusions;
  readonly person_census: WorkloadPersonCensus;
}

export interface WorkloadCalculationOptions {
  readonly rowPersonIds?: ReadonlySet<string>;
  readonly weeks?: readonly string[];
  readonly personCensus?: WorkloadPersonCensus;
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

function personExceptions(personId: string, events: readonly WorkloadAvailabilityEvent[]): readonly AvailabilityException[] {
  return events.filter((event) => event.person === personId && event.lifecycle === "active" && event.state !== "cancelled");
}

function calendarCapacity(week: string, person: WorkloadPerson, calendar: WorkloadCalendar, events: readonly WorkloadAvailabilityEvent[]): { readonly base: number; readonly effective: number } {
  if (calendar.working_weekdays.length === 0) return { base: 0, effective: 0 };
  const sunday = formatDateOnly(new Date(dayTime(week) + 6 * DAY_MS));
  const dates = workingDatesBetween(week, sunday, calendar);
  const dailyCapacity = person.weekly_capacity_hours / calendar.working_weekdays.length;
  const exceptions = personExceptions(person.id, events);
  return {
    base: round(dailyCapacity * dates.length),
    effective: round(dates.reduce((sum, date) => sum + dailyCapacity * availabilityPercentOnDate(date, exceptions) / 100, 0)),
  };
}

function personCensus(people: readonly WorkloadPerson[], activeCalendars: ReadonlyMap<string, WorkloadCalendar>, rowPersonIds?: ReadonlySet<string>): WorkloadPersonCensus {
  const active = people.filter((person) => person.lifecycle === "active");
  const scoped = rowPersonIds === undefined ? active : active.filter((person) => rowPersonIds.has(person.id));
  const withoutCalendar = scoped.filter((person) => !activeCalendars.has(person.calendar)).map((person) => ({ person_id: person.id, person_name: person.name }));
  return { total_active: active.length, scoped: scoped.length, calculable: scoped.length - withoutCalendar.length, without_calendar: withoutCalendar };
}

export function calculateWorkload(
  tasks: readonly WorkloadTask[],
  people: readonly WorkloadPerson[],
  calendars: readonly WorkloadCalendar[],
  projects: readonly WorkloadProject[],
  availabilityEvents: readonly WorkloadAvailabilityEvent[] = [],
  options: WorkloadCalculationOptions = {},
): WorkloadReport {
  const activeProjects = activeProjectIds(projects);
  const activeCalendars = new Map(calendars.filter((calendar) => calendar.lifecycle === "active").map((calendar) => [calendar.id, calendar]));
  const activePeople = new Map(people.filter((person) => person.lifecycle === "active" && activeCalendars.has(person.calendar)).map((person) => [person.id, person]));
  const rowPeople = [...(options.rowPersonIds === undefined ? activePeople.values() : [...activePeople.values()].filter((person) => options.rowPersonIds!.has(person.id)))]
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const census = options.personCensus ?? personCensus(people, activeCalendars, options.rowPersonIds);
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

  const taskWeeks = included.length === 0
    ? []
    : weekStartsBetween(
      included.reduce((value, item) => dayTime(item.task.start!) < dayTime(value) ? item.task.start! : value, included[0]!.task.start!),
      included.reduce((value, item) => dayTime(item.task.finish!) > dayTime(value) ? item.task.finish! : value, included[0]!.task.finish!),
    );
  const weeks = options.weeks ?? taskWeeks;
  if (weeks.length === 0) return { formula: "equal-assignee-share/capacity-weighted-person-day/v2", weeks: [], rows: [], included_tasks: included.length, exclusions, person_census: census };
  const allocations = new Map<string, { hours: number; taskHours: Map<string, number> }>();

  for (const { task, assignees, assigneeCount } of included) {
    const personShare = task.estimate_hours! / assigneeCount;
    for (const person of assignees) {
      const calendar = activeCalendars.get(person.calendar)!;
      const dates = workingDatesBetween(task.start!, task.finish!, calendar);
      if (dates.length === 0) continue;
      const exceptions = personExceptions(person.id, availabilityEvents);
      const weightedDates = dates.map((date) => ({ date, weight: availabilityPercentOnDate(date, exceptions) / 100 }));
      const totalWeight = weightedDates.reduce((sum, item) => sum + item.weight, 0);
      if (totalWeight === 0) continue;
      for (const date of dates) {
        const weight = weightedDates.find((item) => item.date === date)!.weight;
        if (weight === 0) continue;
        const dailyShare = personShare * weight / totalWeight;
        const key = `${person.id}:${isoWeekStart(date)}`;
        const allocation = allocations.get(key) ?? { hours: 0, taskHours: new Map<string, number>() };
        allocation.hours += dailyShare;
        allocation.taskHours.set(task.id, (allocation.taskHours.get(task.id) ?? 0) + dailyShare);
        allocations.set(key, allocation);
      }
    }
  }

  const rows = rowPeople.flatMap((person) => weeks.map((week): PersonWeekWorkload => {
    const allocation = allocations.get(`${person.id}:${week}`);
    const allocated = round(allocation?.hours ?? 0);
    const capacity = calendarCapacity(week, person, activeCalendars.get(person.calendar)!, availabilityEvents);
    const taskAllocations = [...(allocation?.taskHours ?? [])]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([taskId, hours]): TaskWeekAllocation => ({ task_id: taskId, allocated_hours: round(hours) }));
    return {
      person_id: person.id,
      person_name: person.name,
      week,
      allocated_hours: allocated,
      base_capacity_hours: capacity.base,
      capacity_hours: capacity.effective,
      unavailable_hours: round(capacity.base - capacity.effective),
      utilization_percent: capacity.effective === 0 ? null : round(allocated / capacity.effective * 100),
      task_ids: taskAllocations.map((item) => item.task_id),
      task_allocations: taskAllocations,
    };
  }));
  return { formula: "equal-assignee-share/capacity-weighted-person-day/v2", weeks, rows, included_tasks: included.length, exclusions, person_census: census };
}

export interface WorkloadEntityDocument extends Readonly<Record<string, unknown>> {
  readonly schema: string;
  readonly id?: string;
}

export interface WorkloadFilters {
  readonly project?: string;
  readonly milestone?: string;
  readonly team?: string;
  readonly person?: string;
  readonly from?: string;
  readonly weeks?: number;
  readonly end?: string;
}

export interface WorkloadWorkspaceInput {
  readonly tasks: readonly WorkloadEntityDocument[];
  readonly projects: readonly WorkloadEntityDocument[];
  readonly people: readonly WorkloadEntityDocument[];
  readonly calendars: readonly WorkloadEntityDocument[];
  readonly availabilityEvents?: readonly WorkloadEntityDocument[];
  readonly teams?: readonly WorkloadEntityDocument[];
  readonly scheduleTracks: WorkloadEntityDocument;
  readonly repository?: WorkloadEntityDocument;
  readonly filters?: WorkloadFilters;
}

const documentText = (document: Readonly<Record<string, unknown>>, key: string): string | undefined => typeof document[key] === "string" ? document[key] : undefined;
const documentNumber = (document: Readonly<Record<string, unknown>>, key: string): number | undefined => typeof document[key] === "number" ? document[key] : undefined;
const documentStrings = (document: Readonly<Record<string, unknown>>, key: string): readonly string[] => Array.isArray(document[key]) ? (document[key] as readonly unknown[]).filter((item): item is string => typeof item === "string") : [];
const documentNumbers = (document: Readonly<Record<string, unknown>>, key: string): readonly number[] => Array.isArray(document[key]) ? (document[key] as readonly unknown[]).filter((item): item is number => typeof item === "number") : [];
const lifecycle = (document: Readonly<Record<string, unknown>>): "active" | "archived" => document.lifecycle === "archived" ? "archived" : "active";
const entityId = (document: WorkloadEntityDocument): string => documentText(document, "id") ?? "";

export function weeksFromFilters(filters: WorkloadFilters): readonly string[] | undefined {
  if (filters.from === undefined || !DATE_PATTERN.test(filters.from)) return undefined;
  const start = isoWeekStart(filters.from);
  if (filters.end !== undefined && DATE_PATTERN.test(filters.end)) return weekStartsBetween(start, filters.end);
  const count = filters.weeks !== undefined && Number.isInteger(filters.weeks) && filters.weeks > 0 ? filters.weeks : 8;
  return Array.from({ length: count }, (_, index) => formatDateOnly(new Date(dayTime(start) + index * 7 * DAY_MS)));
}

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
  const configuredNameFormat = documentText(input.repository ?? {}, "default_person_name_format");
  const defaultNameFormat = isPersonNameFormat(configuredNameFormat) ? configuredNameFormat : DEFAULT_PERSON_NAME_FORMAT;
  const teamMembers = filters.team === undefined
    ? undefined
    : new Set(documentStrings(input.teams?.find((team) => entityId(team) === filters.team) ?? {}, "members"));
  const selectedTasks = input.tasks.filter((task) => {
    if (filters.project !== undefined && documentText(task, "project") !== filters.project) return false;
    if (filters.milestone !== undefined && documentText(task, "milestone") !== filters.milestone) return false;
    return true;
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
    id: entityId(person), name: formatPersonName(person, defaultNameFormat) || entityId(person), lifecycle: lifecycle(person),
    weekly_capacity_hours: documentNumber(person, "weekly_capacity_hours") ?? 0, calendar: documentText(person, "calendar") ?? "",
  }));
  const calendars = input.calendars.map((calendar): WorkloadCalendar => ({
    id: entityId(calendar), lifecycle: lifecycle(calendar), working_weekdays: documentNumbers(calendar, "working_weekdays"), holidays: documentStrings(calendar, "holidays"),
  }));
  const availabilityEvents = (input.availabilityEvents ?? []).map((event): WorkloadAvailabilityEvent => ({
    id: entityId(event), person: documentText(event, "person") ?? "", start: documentText(event, "start") ?? "",
    finish: documentText(event, "finish") ?? "", availability_percent: documentNumber(event, "availability_percent") ?? 100,
    state: documentText(event, "state") === "taken" ? "taken" : documentText(event, "state") === "cancelled" ? "cancelled" : "planned",
    lifecycle: lifecycle(event),
  }));
  const activeCalendarIds = new Set(calendars.filter((calendar) => calendar.lifecycle === "active").map((calendar) => calendar.id));
  const activePeople = people.filter((person) => person.lifecycle === "active");
  const scopedPeople = activePeople.filter((person) => {
    if (filters.person !== undefined && person.id !== filters.person) return false;
    if (teamMembers !== undefined && !teamMembers.has(person.id)) return false;
    return true;
  });
  const withoutCalendar = scopedPeople.filter((person) => !activeCalendarIds.has(person.calendar));
  const calculable = scopedPeople.filter((person) => activeCalendarIds.has(person.calendar));
  return calculateWorkload(tasks, people, calendars, projects, availabilityEvents, {
    rowPersonIds: new Set(calculable.map((person) => person.id)),
    weeks: weeksFromFilters(filters),
    personCensus: {
      total_active: activePeople.length,
      scoped: scopedPeople.length,
      calculable: calculable.length,
      without_calendar: withoutCalendar.map((person) => ({ person_id: person.id, person_name: person.name })),
    },
  });
}
