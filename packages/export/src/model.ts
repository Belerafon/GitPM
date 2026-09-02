import {
  annualVacationAllowance,
  emptyVacationFilters,
  vacationSummary,
  vacationYearBalance,
  type VacationEvent,
  type VacationPerson,
  type VacationYearBalance,
  type WorkingCalendar,
} from "@gitpm/calendar";
import type { GitHistoryEntry } from "@gitpm/git-client";
import type { GitPmDocument } from "@gitpm/repository-format";
import { windowEffort, type GanttModel } from "@gitpm/scheduling";
import { activeProjectIds, DEFAULT_PERSON_NAME_FORMAT, formatPersonName, isOperationalTask, isPersonNameFormat, type PersonNameFormat } from "@gitpm/shared";
import { buildTaskHierarchy } from "@gitpm/task-hierarchy";
import { groupByCategory, groupByDate, groupByPerson, type TimeEntryRecord } from "@gitpm/time-entries";
import { buildWorkloadReport, type WorkloadReport } from "@gitpm/workload";
import { absenceKindLabel, absenceStateLabel, COPY, type CopyText } from "./copy.js";
import {
  categoryTitles,
  compactDescription,
  completedStatusSlugs,
  documentGroups,
  localizedDate,
  namesById,
  number,
  projectRisk,
  statusTitles,
  strings,
  text,
  timeEntry,
  type ExportDocument,
} from "./documents.js";
import { buildExportScheduling, projectGantt, trackTitle, windowField, type ExportScheduling } from "./scheduling.js";
import {
  EXPORT_REPORTS,
  ISO_DATE,
  type ExportDensity,
  type ExportLifecycle,
  type ExportLocale,
  type ExportPageSize,
  type ExportReport,
  type ExportRequest,
  type ExportScope,
  type ExportSection,
  type ExportTimeEntryState,
} from "./types.js";

export interface ExportSnapshot {
  readonly commit: string;
  readonly shortCommit: string;
  readonly commitDate: string;
  readonly generatedAt: string;
  readonly root: string;
  readonly documents: readonly ExportDocument[];
  readonly history: readonly GitHistoryEntry[];
}

export interface NormalizedExportOptions {
  readonly locale: ExportLocale;
  readonly reports: ReadonlySet<ExportReport>;
  readonly includeLegacyGantt: boolean;
  readonly includeLegacyPeople: boolean;
  readonly includeLegacyProjects: boolean;
  readonly includeLegacyDetails: boolean;
  readonly scope: ExportScope;
  readonly project?: string;
  readonly person?: string;
  readonly team?: string;
  readonly asOf: string;
  readonly periodStart: string;
  readonly periodFinish: string;
  readonly lifecycle: ExportLifecycle;
  readonly timeEntryState: ExportTimeEntryState;
  readonly includeIds: boolean;
  readonly includeEmail: boolean;
  readonly includeNotes: boolean;
  readonly includeComments: boolean;
  readonly hidePersonalData: boolean;
  readonly pageSize: ExportPageSize;
  readonly density: ExportDensity;
  readonly reportTitle: string;
}

export interface PortfolioProjectRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly statusTitle: string;
  readonly ownerName: string;
  readonly taskCount: number;
  readonly milestoneCount: number;
  readonly finish: string;
  readonly finishLabel: string;
  readonly risk: "onTrack" | "near" | "overdue" | "unknown";
  readonly riskLabel: string;
}

export interface PortfolioReport {
  readonly metrics: readonly { readonly label: string; readonly value: number }[];
  readonly groups: readonly { readonly title: string; readonly projects: readonly PortfolioProjectRow[] }[];
  readonly people: readonly {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly projects: string;
    readonly teams: string;
    readonly capacity: string;
    readonly calendar: string;
  }[];
}

export interface ProjectPlanTaskRow {
  readonly id: string;
  readonly title: string;
  readonly depth: number;
  readonly statusTitle: string;
  readonly assignees: string;
  readonly schedule: string;
  readonly actual: string;
  readonly archived: boolean;
}

export interface ProjectPlanReport {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly milestones: readonly { readonly name: string; readonly finish: string }[];
  readonly tasks: readonly ProjectPlanTaskRow[];
  readonly archive: readonly ProjectPlanTaskRow[];
  readonly gantt?: GanttModel;
  readonly board: readonly { readonly status: string; readonly titles: readonly string[] }[];
}

export interface PlanFactSlice {
  readonly label: string;
  readonly hours: number;
}

export interface PlanFactReport {
  readonly projectId: string;
  readonly projectName: string;
  readonly trackTitle: string;
  readonly budget?: number;
  readonly plan?: number;
  readonly actual: number;
  readonly variance?: number;
  readonly rows: readonly {
    readonly id: string;
    readonly title: string;
    readonly depth: number;
    readonly plan?: number;
    readonly actual: number;
    readonly variance?: number;
    readonly archived: boolean;
  }[];
  readonly byPerson: readonly PlanFactSlice[];
  readonly byCategory: readonly PlanFactSlice[];
  readonly byDate: readonly PlanFactSlice[];
}

export interface VacationReport {
  readonly summary: { readonly absentToday: number; readonly leavingSoon: number; readonly maxOverlap: number };
  readonly events: readonly {
    readonly person: string;
    readonly kind: string;
    readonly state: string;
    readonly start: string;
    readonly finish: string;
    readonly note: string;
  }[];
  readonly balances: readonly {
    readonly person: string;
    readonly taken: number;
    readonly planned: number;
    readonly remaining: number;
    readonly allowance: number;
  }[];
}

export interface PersonProfileReport {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly capacity: string;
  readonly calendar: string;
  readonly teams: string;
  readonly ownedProjects: string;
  readonly contributingProjects: string;
  readonly tasks: readonly { readonly title: string; readonly project: string; readonly schedule: string }[];
  readonly absences: readonly { readonly kind: string; readonly state: string; readonly start: string; readonly finish: string }[];
  readonly balance?: VacationYearBalance;
}

export interface AuditReport {
  readonly archived: readonly { readonly type: string; readonly id: string; readonly name: string }[];
  readonly comments: readonly { readonly project: string; readonly task: string; readonly author: string; readonly body: string }[];
  readonly voided: readonly { readonly id: string; readonly task: string; readonly person: string; readonly date: string; readonly hours: number }[];
  readonly history: readonly { readonly commit: string; readonly authoredAt: string; readonly author: string; readonly subject: string }[];
}

export interface ExportReportModel {
  readonly snapshot: ExportSnapshot;
  readonly options: NormalizedExportOptions;
  readonly labels: CopyText;
  readonly portfolio?: PortfolioReport;
  readonly projectPlans: readonly ProjectPlanReport[];
  readonly planFacts: readonly PlanFactReport[];
  readonly workload?: WorkloadReport;
  readonly vacations?: VacationReport;
  readonly profiles: readonly PersonProfileReport[];
  readonly audit?: AuditReport;
}

const LEGACY_TO_REPORT: Readonly<Record<string, ExportReport>> = {
  projects: "portfolio",
  people: "portfolio",
  "project-details": "project-plan",
  gantt: "project-plan",
};

function asOfDate(value: string | undefined, generatedAt: string): string {
  if (value !== undefined && ISO_DATE.test(value)) return value;
  return generatedAt.slice(0, 10);
}

function periodDays(start: string, finish: string): readonly string[] {
  if (!ISO_DATE.test(start) || !ISO_DATE.test(finish) || start > finish) return [];
  const days: string[] = [];
  for (let time = Date.parse(`${start}T00:00:00Z`); time <= Date.parse(`${finish}T00:00:00Z`); time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

export function normalizeExportOptions(request: ExportRequest, snapshot: ExportSnapshot): NormalizedExportOptions {
  const locale = request.locale ?? "en";
  const sections = request.sections ?? [];
  const reports = new Set<ExportReport>();
  const htmlOrSheet = request.format === "html" || request.format === "csv" || request.format === "xlsx";
  if (sections.length === 0) {
    if (htmlOrSheet) EXPORT_REPORTS.forEach((report) => reports.add(report));
    else {
      reports.add("portfolio");
    }
  } else {
    for (const section of sections) {
      if ((EXPORT_REPORTS as readonly string[]).includes(section)) reports.add(section as ExportReport);
      else {
        const mapped = LEGACY_TO_REPORT[section];
        if (mapped !== undefined) reports.add(mapped);
      }
    }
  }
  const asOf = asOfDate(request.as_of, snapshot.generatedAt);
  const hidePersonalData = request.hide_personal_data ?? true;
  const includeEmail = hidePersonalData ? false : request.include_email === true;
  return {
    locale,
    reports,
    includeLegacyGantt: sections.includes("gantt") || sections.length === 0,
    includeLegacyPeople: sections.includes("people") || sections.length === 0 || reports.has("portfolio"),
    includeLegacyProjects: sections.includes("projects") || sections.length === 0 || reports.has("portfolio"),
    includeLegacyDetails: sections.includes("project-details") || reports.has("project-plan"),
    scope: request.scope ?? "portfolio",
    ...(request.project === undefined ? {} : { project: request.project }),
    ...(request.person === undefined ? {} : { person: request.person }),
    ...(request.team === undefined ? {} : { team: request.team }),
    asOf,
    periodStart: request.period_start && ISO_DATE.test(request.period_start) ? request.period_start : `${asOf.slice(0, 4)}-01-01`,
    periodFinish: request.period_finish && ISO_DATE.test(request.period_finish) ? request.period_finish : `${asOf.slice(0, 4)}-12-31`,
    lifecycle: request.lifecycle ?? "active",
    timeEntryState: request.time_entry_state ?? "active",
    includeIds: request.include_ids ?? true,
    includeEmail,
    includeNotes: hidePersonalData ? false : request.include_notes === true,
    includeComments: request.include_comments === true || reports.has("audit"),
    hidePersonalData,
    pageSize: request.page_size ?? "A4",
    density: request.density ?? "detailed",
    reportTitle: request.report_title?.trim() || COPY[locale].title,
  };
}

function matchesLifecycle(document: GitPmDocument, lifecycle: ExportLifecycle): boolean {
  if (lifecycle === "all") return true;
  return text(document, "lifecycle") === lifecycle;
}

function filterEntries(entries: readonly TimeEntryRecord[], state: ExportTimeEntryState, start: string, finish: string): readonly TimeEntryRecord[] {
  return entries.filter((entry) => {
    if (state === "active" && entry.state === "voided") return false;
    if (state === "voided" && entry.state !== "voided") return false;
    if (entry.performed_on < start || entry.performed_on > finish) return false;
    return true;
  });
}

function calendarOf(document: GitPmDocument): WorkingCalendar {
  return {
    workingWeekdays: Array.isArray(document.working_weekdays) ? document.working_weekdays.filter((item): item is number => typeof item === "number") : [1, 2, 3, 4, 5],
    holidays: strings(document.holidays),
  };
}

export function buildExportReportModel(snapshot: ExportSnapshot, request: ExportRequest): ExportReportModel {
  const options = normalizeExportOptions(request, snapshot);
  const labels = COPY[options.locale];
  const groups = documentGroups(snapshot.documents);
  const configuredNameFormat = groups.repository[0]?.default_person_name_format;
  const defaultPersonNameFormat = isPersonNameFormat(configuredNameFormat) ? configuredNameFormat : DEFAULT_PERSON_NAME_FORMAT;
  const allEntries = groups.timeEntries.map(timeEntry).filter((entry): entry is TimeEntryRecord => entry !== undefined);
  const entries = filterEntries(allEntries, options.timeEntryState, options.periodStart, options.periodFinish);
  const scheduling = buildExportScheduling(snapshot.documents, entries);
  const titlesByStatus = statusTitles(groups.statuses);
  const doneSlugs = completedStatusSlugs(groups.statuses);
  const categoryNames = categoryTitles(groups.workCategories);
  const peopleNames = namesById(groups.people, defaultPersonNameFormat);
  const projectNames = namesById(groups.projects);
  const calendarNames = namesById(groups.calendars);
  const teamMembers = options.team === undefined
    ? undefined
    : new Set(strings(groups.teams.find((team) => text(team, "id") === options.team)?.members));

  const scopedProjects = groups.projects.filter((project) => {
    if (options.scope === "project" && options.project !== undefined) return text(project, "id") === options.project;
    return true;
  });
  const visibleProjects = scopedProjects.filter((project) => matchesLifecycle(project, options.lifecycle));
  const operationalIds = activeProjectIds(options.lifecycle === "archived" ? [] : groups.projects.filter((project) => text(project, "lifecycle") === "active"));
  const visibleTasks = groups.tasks.filter((task) => {
    if (!visibleProjects.some((project) => text(project, "id") === text(task, "project"))) return false;
    if (options.lifecycle === "active") return isOperationalTask(task, operationalIds);
    if (options.lifecycle === "archived") return text(task, "lifecycle") === "archived";
    return true;
  });
  const visibleMilestones = groups.milestones.filter((milestone) => visibleProjects.some((project) => text(project, "id") === text(milestone, "project")) && matchesLifecycle(milestone, options.lifecycle));
  const visiblePeople = groups.people.filter((person) => {
    if (!matchesLifecycle(person, options.lifecycle === "archived" ? "all" : options.lifecycle)) return false;
    if (options.scope === "person" && options.person !== undefined) return text(person, "id") === options.person;
    if (teamMembers !== undefined) return teamMembers.has(text(person, "id"));
    return true;
  });
  const visibleTeams = groups.teams.filter((team) => matchesLifecycle(team, options.lifecycle === "archived" ? "all" : options.lifecycle));

  let portfolio: PortfolioReport | undefined;
  let projectPlans: readonly ProjectPlanReport[] = [];
  let planFacts: readonly PlanFactReport[] = [];
  let workload: WorkloadReport | undefined;
  let vacations: VacationReport | undefined;
  let profiles: readonly PersonProfileReport[] = [];
  let audit: AuditReport | undefined;

  if (options.reports.has("portfolio")) {
    const people = options.includeLegacyPeople ? visiblePeople.filter((person) => text(person, "lifecycle") === "active" || options.lifecycle !== "active") : [];
    const projects = options.includeLegacyProjects ? visibleProjects : [];
    const grouped = projectGroups(projects, options.locale, labels.ungrouped);
    portfolio = {
      metrics: [
        { label: labels.activeProjects, value: projects.filter((project) => text(project, "lifecycle") === "active").length },
        { label: labels.activeTasks, value: visibleTasks.filter((task) => isOperationalTask(task, operationalIds)).length },
        { label: labels.activeMilestones, value: visibleMilestones.filter((milestone) => text(milestone, "lifecycle") === "active").length },
        { label: labels.completedTasks, value: visibleTasks.filter((task) => doneSlugs.has(text(task, "status"))).length },
      ],
      groups: grouped.map((group) => ({
        title: group.title,
        projects: group.projects.map((project) => {
          const projectId = text(project, "id");
          const finish = windowField(scheduling, project, "finish");
          const risk = projectRisk(finish, snapshot.generatedAt);
          return {
            id: projectId,
            name: text(project, "name"),
            description: compactDescription(project),
            statusTitle: titlesByStatus.get(text(project, "status")) ?? text(project, "status"),
            ownerName: (peopleNames.get(text(project, "owner")) ?? text(project, "owner")) || labels.unassigned,
            taskCount: visibleTasks.filter((task) => text(task, "project") === projectId).length,
            milestoneCount: visibleMilestones.filter((milestone) => text(milestone, "project") === projectId).length,
            finish,
            finishLabel: localizedDate(options.locale, finish),
            risk,
            riskLabel: risk === "onTrack" ? labels.riskOnTrack : risk === "near" ? labels.riskNear : risk === "overdue" ? labels.riskOverdue : labels.riskUnknown,
          };
        }),
      })),
      people: people.map((person) => personRow(person, visibleProjects, visibleTasks, visibleTeams, projectNames, calendarNames, options, labels, defaultPersonNameFormat)),
    };
  }

  if (options.reports.has("project-plan")) {
    projectPlans = visibleProjects.map((project) => {
      const projectId = text(project, "id");
      const projectTasks = visibleTasks.filter((task) => text(task, "project") === projectId);
      const activeTasks = projectTasks.filter((task) => text(task, "lifecycle") === "active");
      const archivedTasks = projectTasks.filter((task) => text(task, "lifecycle") === "archived");
      const projectMilestones = visibleMilestones.filter((milestone) => text(milestone, "project") === projectId);
      return {
        id: projectId,
        name: text(project, "name"),
        description: text(project, "description_markdown"),
        milestones: projectMilestones.map((milestone) => ({ name: text(milestone, "name"), finish: windowField(scheduling, milestone, "finish") || "-" })),
        tasks: flattenTasks(activeTasks, scheduling, peopleNames, titlesByStatus, false),
        archive: flattenTasks(archivedTasks, scheduling, peopleNames, titlesByStatus, true),
        ...(options.includeLegacyGantt ? { gantt: projectGantt(activeTasks, projectId, scheduling) } : {}),
        board: boardColumns(activeTasks, titlesByStatus),
      };
    });
  }

  if (options.reports.has("plan-fact")) {
    planFacts = visibleProjects.map((project) => buildPlanFact(
      project,
      visibleTasks.filter((task) => text(task, "project") === text(project, "id")),
      entries.filter((entry) => entry.project === text(project, "id")),
      scheduling,
      peopleNames,
      categoryNames,
    ));
  }

  if (options.reports.has("workload")) {
    const scheduleTracks = groups.scheduleTracks[0];
    if (scheduleTracks !== undefined) {
      workload = buildWorkloadReport({
        tasks: visibleTasks,
        projects: visibleProjects,
        people: visiblePeople,
        calendars: groups.calendars,
        availabilityEvents: groups.availability,
        teams: visibleTeams,
        scheduleTracks,
        repository: groups.repository[0],
        filters: {
          ...(options.project === undefined ? {} : { project: options.project }),
          ...(options.team === undefined ? {} : { team: options.team }),
        },
      });
    }
  }

  if (options.reports.has("vacations")) {
    vacations = buildVacationReport(
      visiblePeople,
      visibleTeams,
      groups.availability,
      groups.calendars,
      options,
      defaultPersonNameFormat,
    );
  }

  if (options.reports.has("person-profile")) {
    profiles = visiblePeople.map((person) => buildPersonProfile(
      person,
      visibleProjects,
      visibleTasks,
      visibleTeams,
      groups.availability,
      groups.calendars,
      scheduling,
      projectNames,
      calendarNames,
      options,
      labels,
      defaultPersonNameFormat,
    ));
  }

  if (options.reports.has("audit")) {
    audit = {
      archived: [
        ...groups.projects.filter((item) => text(item, "lifecycle") === "archived").map((item) => ({ type: "project", id: text(item, "id"), name: text(item, "name") })),
        ...groups.tasks.filter((item) => text(item, "lifecycle") === "archived").map((item) => ({ type: "task", id: text(item, "id"), name: text(item, "title") })),
        ...groups.milestones.filter((item) => text(item, "lifecycle") === "archived").map((item) => ({ type: "milestone", id: text(item, "id"), name: text(item, "name") })),
      ],
      comments: options.includeComments ? groups.comments.filter((item) => text(item, "state") !== "deleted").map((item) => ({
        project: projectNames.get(text(item, "project")) ?? text(item, "project"),
        task: text(item, "task"),
        author: options.hidePersonalData ? "—" : (peopleNames.get(text(item, "author")) ?? text(item, "author")),
        body: options.hidePersonalData ? "—" : text(item, "body_markdown"),
      })) : [],
      voided: allEntries.filter((entry) => entry.state === "voided").map((entry) => ({
        id: entry.id,
        task: text(groups.tasks.find((task) => text(task, "id") === entry.task), "title") || entry.task,
        person: peopleNames.get(entry.person) ?? entry.person,
        date: entry.performed_on,
        hours: entry.hours,
      })),
      history: snapshot.history.map((item) => ({
        commit: item.commit.slice(0, 8),
        authoredAt: item.authored_at,
        author: options.hidePersonalData ? "—" : item.author_name,
        subject: item.subject,
      })),
    };
  }

  return {
    snapshot,
    options,
    labels,
    ...(portfolio === undefined ? {} : { portfolio }),
    projectPlans,
    planFacts,
    ...(workload === undefined ? {} : { workload }),
    ...(vacations === undefined ? {} : { vacations }),
    profiles,
    ...(audit === undefined ? {} : { audit }),
  };
}

function projectGroups(projects: readonly GitPmDocument[], locale: ExportLocale, ungrouped: string) {
  const named = new Map<string, GitPmDocument[]>();
  const withoutGroup: GitPmDocument[] = [];
  for (const project of projects) {
    const group = text(project, "group").trim();
    if (group === "") withoutGroup.push(project);
    else named.set(group, [...(named.get(group) ?? []), project]);
  }
  const byName = (left: GitPmDocument, right: GitPmDocument) => text(left, "name").localeCompare(text(right, "name"), locale);
  const groups = [...named.entries()]
    .sort(([left], [right]) => left.localeCompare(right, locale))
    .map(([title, items]) => ({ title, projects: [...items].sort(byName) }));
  if (withoutGroup.length > 0) groups.push({ title: ungrouped, projects: [...withoutGroup].sort(byName) });
  return groups;
}

function personRow(
  person: GitPmDocument,
  projects: readonly GitPmDocument[],
  tasks: readonly GitPmDocument[],
  teams: readonly GitPmDocument[],
  projectNames: ReadonlyMap<string, string>,
  calendarNames: ReadonlyMap<string, string>,
  options: NormalizedExportOptions,
  labels: CopyText,
  defaultPersonNameFormat: PersonNameFormat,
) {
  const personId = text(person, "id");
  const personProjectIds = new Set(projects.filter((project) => text(project, "owner") === personId).map((project) => text(project, "id")));
  for (const task of tasks) {
    if (strings(task.assignees).includes(personId) && projectNames.has(text(task, "project"))) personProjectIds.add(text(task, "project"));
  }
  const capacity = number(person, "weekly_capacity_hours");
  return {
    id: personId,
    name: formatPersonName(person, defaultPersonNameFormat),
    email: options.includeEmail ? text(person, "email") : "",
    projects: [...personProjectIds].map((id) => projectNames.get(id) ?? id).sort((left, right) => left.localeCompare(right, options.locale)).join(", ") || "-",
    teams: teams.filter((team) => strings(team.members).includes(personId)).map((team) => text(team, "name")).sort((left, right) => left.localeCompare(right, options.locale)).join(", ") || "-",
    capacity: capacity === undefined ? "-" : `${capacity.toLocaleString(options.locale === "ru" ? "ru-RU" : "en-US", { maximumFractionDigits: 2 })} ${labels.hoursPerWeek}`,
    calendar: calendarNames.get(text(person, "calendar")) ?? "-",
  };
}

function flattenTasks(
  tasks: readonly GitPmDocument[],
  scheduling: ExportScheduling,
  peopleNames: ReadonlyMap<string, string>,
  titlesByStatus: ReadonlyMap<string, string>,
  archived: boolean,
): readonly ProjectPlanTaskRow[] {
  const hierarchy = buildTaskHierarchy(tasks.map((task) => {
    const parent = text(task, "parent");
    return { id: text(task, "id"), ...(parent === "" ? {} : { parent }), task };
  }));
  return hierarchy.flatten().map((entry) => {
    const task = (entry.task as { readonly task: GitPmDocument }).task;
    const actual = scheduling.actualWindows.get(text(task, "id"));
    return {
      id: text(task, "id"),
      title: `${"  ".repeat(entry.depth)}${text(task, "title")}`,
      depth: entry.depth,
      statusTitle: titlesByStatus.get(text(task, "status")) ?? text(task, "status"),
      assignees: strings(task.assignees).map((id) => peopleNames.get(id) ?? id).join(", ") || "-",
      schedule: formatSchedule(scheduling, task),
      actual: actual === undefined ? "-" : `${actual.effort_hours}h (${actual.start ?? ""} - ${actual.finish ?? ""})`,
      archived,
    };
  });
}

function formatSchedule(scheduling: ExportScheduling, task: GitPmDocument): string {
  const start = windowField(scheduling, task, "start");
  const finish = windowField(scheduling, task, "finish");
  return start && finish ? `${start} - ${finish}` : start || finish || "-";
}

function boardColumns(tasks: readonly GitPmDocument[], titlesByStatus: ReadonlyMap<string, string>) {
  const slugs = [...new Set(tasks.map((task) => text(task, "status")))];
  return slugs.map((slug) => ({
    status: titlesByStatus.get(slug) ?? slug ?? "—",
    titles: tasks.filter((task) => text(task, "status") === slug).map((task) => text(task, "title")),
  }));
}

function buildPlanFact(
  project: GitPmDocument,
  tasks: readonly GitPmDocument[],
  entries: readonly TimeEntryRecord[],
  scheduling: ExportScheduling,
  peopleNames: ReadonlyMap<string, string>,
  categoryNames: ReadonlyMap<string, string>,
): PlanFactReport {
  const projectId = text(project, "id");
  const plan = scheduling.plans.get(projectId);
  const workload = plan?.workload ?? plan?.primary ?? "";
  const hierarchy = buildTaskHierarchy(tasks.map((task) => {
    const parent = text(task, "parent");
    return { id: text(task, "id"), ...(parent === "" ? {} : { parent }), task };
  }));
  const actualByTask = new Map<string, number>();
  for (const entry of entries) actualByTask.set(entry.task, (actualByTask.get(entry.task) ?? 0) + entry.hours);
  const rows = hierarchy.flatten().map((entry) => {
    const task = (entry.task as { readonly task: GitPmDocument }).task;
    const model = scheduling.readModels.get(text(task, "id"));
    const summary = model?.tracks.find((item) => item.track === workload);
    const declared = windowEffort(summary?.declared);
    const rolled = windowEffort(summary?.rolled);
    const planned = declared ?? (entry.hasChildren ? rolled : undefined);
    const actual = roundHours(sumBranch(actualByTask, hierarchy.descendantsOf(text(task, "id")).map((item) => item.id), text(task, "id")));
    return {
      id: text(task, "id"),
      title: `${"  ".repeat(entry.depth)}${text(task, "title")}`,
      depth: entry.depth,
      ...(planned === undefined ? {} : { plan: planned }),
      actual,
      ...(planned === undefined ? {} : { variance: roundHours(actual - planned) }),
      archived: text(task, "lifecycle") === "archived",
    };
  });
  const roots = rows.filter((row) => row.depth === 0);
  const planTotal = roots.some((row) => row.plan !== undefined) ? roundHours(roots.reduce((sum, row) => sum + (row.plan ?? 0), 0)) : undefined;
  const actualTotal = roundHours(entries.reduce((sum, entry) => sum + entry.hours, 0));
  const projectBudget = windowEffort(scheduling.readModels.get(projectId)?.tracks.find((item) => item.track === workload)?.declared);
  return {
    projectId,
    projectName: text(project, "name"),
    trackTitle: trackTitle(scheduling, projectId, workload),
    ...(projectBudget === undefined ? {} : { budget: projectBudget }),
    ...(planTotal === undefined ? {} : { plan: planTotal }),
    actual: actualTotal,
    ...(planTotal === undefined ? {} : { variance: roundHours(actualTotal - planTotal) }),
    rows,
    byPerson: [...groupByPerson(entries).entries()].map(([id, hours]) => ({ label: peopleNames.get(id) ?? id, hours })).sort((left, right) => right.hours - left.hours),
    byCategory: [...groupByCategory(entries).entries()].map(([id, hours]) => ({ label: categoryNames.get(id) ?? id, hours })).sort((left, right) => right.hours - left.hours),
    byDate: [...groupByDate(entries).entries()].map(([label, hours]) => ({ label, hours })).sort((left, right) => left.label.localeCompare(right.label)),
  };
}

function sumBranch(actualByTask: ReadonlyMap<string, number>, descendants: readonly string[], taskId: string): number {
  return (actualByTask.get(taskId) ?? 0) + descendants.reduce((sum, id) => sum + (actualByTask.get(id) ?? 0), 0);
}

function roundHours(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function buildVacationReport(
  people: readonly GitPmDocument[],
  _teams: readonly GitPmDocument[],
  availability: readonly GitPmDocument[],
  calendars: readonly GitPmDocument[],
  options: NormalizedExportOptions,
  defaultPersonNameFormat: PersonNameFormat,
): VacationReport {
  const vacationPeople: VacationPerson[] = people.map((person) => ({
    id: text(person, "id"),
    name: formatPersonName(person, defaultPersonNameFormat),
    lifecycle: text(person, "lifecycle") || "active",
    calendarId: text(person, "calendar"),
    extraDays: number(person, "annual_vacation_extra_days") ?? 0,
    extraDaysReason: text(person, "annual_vacation_extra_days_reason"),
  }));
  const events: VacationEvent[] = availability.map((event) => ({
    id: text(event, "id"),
    personId: text(event, "person"),
    start: text(event, "start"),
    finish: text(event, "finish"),
    kind: text(event, "kind"),
    state: text(event, "state"),
    note: options.includeNotes ? text(event, "note_markdown") : "",
    lifecycle: text(event, "lifecycle") || "active",
  }));
  const filters = {
    ...emptyVacationFilters(),
    ...(options.person === undefined ? {} : { personId: options.person }),
    ...(options.team === undefined ? {} : { teamId: options.team }),
  };
  const window = { start: options.periodStart, finish: options.periodFinish, days: periodDays(options.periodStart, options.periodFinish) };
  const calendarById = new Map(calendars.map((calendar) => [text(calendar, "id"), calendarOf(calendar)]));
  return {
    summary: vacationSummary(events, vacationPeople, window, filters, options.asOf),
    events: events
      .filter((event) => vacationPeople.some((person) => person.id === event.personId) && event.state !== "cancelled")
      .filter((event) => event.finish >= options.periodStart && event.start <= options.periodFinish)
      .map((event) => ({
        person: vacationPeople.find((person) => person.id === event.personId)?.name ?? event.personId,
        kind: absenceKindLabel(options.locale, event.kind),
        state: absenceStateLabel(options.locale, event.state),
        start: event.start,
        finish: event.finish,
        note: event.note,
      })),
    balances: vacationPeople.map((person) => {
      const balance = vacationYearBalance(
        events.filter((event) => event.personId === person.id),
        options.asOf,
        calendarById.get(person.calendarId),
        annualVacationAllowance(person.extraDays),
      );
      return { person: person.name, ...balance };
    }),
  };
}

function buildPersonProfile(
  person: GitPmDocument,
  projects: readonly GitPmDocument[],
  tasks: readonly GitPmDocument[],
  teams: readonly GitPmDocument[],
  availability: readonly GitPmDocument[],
  calendars: readonly GitPmDocument[],
  scheduling: ExportScheduling,
  projectNames: ReadonlyMap<string, string>,
  calendarNames: ReadonlyMap<string, string>,
  options: NormalizedExportOptions,
  labels: CopyText,
  defaultPersonNameFormat: PersonNameFormat,
): PersonProfileReport {
  const personId = text(person, "id");
  const owned = projects.filter((project) => text(project, "owner") === personId);
  const assigned = tasks.filter((task) => strings(task.assignees).includes(personId));
  const contributing = [...new Set(assigned.map((task) => text(task, "project")))].filter((id) => !owned.some((project) => text(project, "id") === id));
  const events = availability.filter((event) => text(event, "person") === personId);
  const calendar = calendars.find((item) => text(item, "id") === text(person, "calendar"));
  const capacity = number(person, "weekly_capacity_hours");
  return {
    id: personId,
    name: formatPersonName(person, defaultPersonNameFormat),
    email: options.includeEmail ? text(person, "email") : "",
    capacity: capacity === undefined ? "-" : `${capacity} ${labels.hoursPerWeek}`,
    calendar: calendarNames.get(text(person, "calendar")) ?? "-",
    teams: teams.filter((team) => strings(team.members).includes(personId)).map((team) => text(team, "name")).join(", ") || "-",
    ownedProjects: owned.map((project) => text(project, "name")).join(", ") || "-",
    contributingProjects: contributing.map((id) => projectNames.get(id) ?? id).join(", ") || "-",
    tasks: assigned.map((task) => ({ title: text(task, "title"), project: projectNames.get(text(task, "project")) ?? text(task, "project"), schedule: formatSchedule(scheduling, task) })),
    absences: events.filter((event) => text(event, "state") !== "cancelled").map((event) => ({
      kind: absenceKindLabel(options.locale, text(event, "kind")),
      state: absenceStateLabel(options.locale, text(event, "state")),
      start: text(event, "start"),
      finish: text(event, "finish"),
    })),
    balance: vacationYearBalance(
      events.map((event) => ({
        start: text(event, "start"),
        finish: text(event, "finish"),
        kind: text(event, "kind"),
        state: text(event, "state"),
        lifecycle: text(event, "lifecycle") || "active",
      })),
      options.asOf,
      calendar === undefined ? undefined : calendarOf(calendar),
      annualVacationAllowance(number(person, "annual_vacation_extra_days") ?? 0),
    ),
  };
}

export function selectedSections(request: ExportRequest): ReadonlySet<ExportSection> {
  return new Set(request.sections?.length ? request.sections : ["projects", "people"]);
}
