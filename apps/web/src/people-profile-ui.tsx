import { useCallback, useEffect, useState } from "react";
import type { GitPmApi } from "./api.js";
import { AsyncBoundary, useAsyncLoad } from "./async-data.js";
import { formatDateOnly, formatNumber, message, type Locale, type MessageKey } from "./i18n.js";
import type { DraftStatus, EntityResult, GitPmDocument } from "./types.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";

const text = (document: GitPmDocument, key: string) => typeof document[key] === "string" ? document[key] as string : "";
const number = (document: GitPmDocument, key: string) => typeof document[key] === "number" ? document[key] as number : 0;
const strings = (document: GitPmDocument, key: string) => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
const numbers = (document: GitPmDocument, key: string) => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is number => typeof item === "number") : [];
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/u.test(value);

interface ProfileData {
  readonly people: readonly EntityResult[];
  readonly calendars: readonly EntityResult[];
  readonly teams: readonly EntityResult[];
  readonly projects: readonly EntityResult[];
  readonly tasks: readonly EntityResult[];
}

export function PeopleProfileWorkspace({ api, draft, locale, personId, onNavigate }: { readonly api: GitPmApi; readonly draft: DraftStatus; readonly locale: Locale; readonly personId: string; readonly onNavigate: WorkspaceNavigate }) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [data, setData] = useState<ProfileData | null>(null);
  const loadRequest = useAsyncLoad();
  const load = useCallback(async () => {
    await loadRequest.run(async () => {
      const [people, calendars, teams, projects, tasks] = await Promise.all([
        api.listEntities(draft.draft_id, "people"),
        api.listEntities(draft.draft_id, "calendars"),
        api.listEntities(draft.draft_id, "teams"),
        api.listEntities(draft.draft_id, "projects"),
        api.listEntities(draft.draft_id, "tasks"),
      ]);
      return { people, calendars, teams, projects, tasks };
    }, setData);
  }, [api, draft.draft_id, draft.external_fingerprint, loadRequest.run]);
  useEffect(() => { void load(); }, [load]);

  return <section className="people-profile-workspace">
    <AsyncBoundary state={loadRequest.state} loading={t("status.loading")} retry={() => { void load(); }} error={(error, retry) => <div className="alert error">{error}<button onClick={retry}>{t("status.retry")}</button></div>}>
      {data !== null && <PeopleProfile data={data} locale={locale} onNavigate={onNavigate} personId={personId} t={t} />}
    </AsyncBoundary>
  </section>;
}

function PeopleProfile({ data, locale, personId, onNavigate, t }: { readonly data: ProfileData; readonly locale: Locale; readonly personId: string; readonly onNavigate: WorkspaceNavigate; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string }) {
  const person = data.people.find((item) => item.document.id === personId);
  if (person === undefined) return <div className="card empty-workspace"><p>{t("people.notFound")}</p><button onClick={() => onNavigate("people")}>← {t("people.back")}</button></div>;

  const assignedTasks = data.tasks
    .filter((item) => item.document.lifecycle === "active" && strings(item.document, "assignees").includes(personId))
    .sort((left, right) => (text(left.document, "due") || "9999").localeCompare(text(right.document, "due") || "9999") || text(left.document, "title").localeCompare(text(right.document, "title"), locale));
  const projectTaskCounts = new Map<string, number>();
  for (const task of assignedTasks) projectTaskCounts.set(text(task.document, "project"), (projectTaskCounts.get(text(task.document, "project")) ?? 0) + 1);
  const activeProjects = data.projects.filter((item) => item.document.lifecycle === "active");
  const ownedProjects = activeProjects.filter((item) => text(item.document, "owner") === personId).sort((left, right) => text(left.document, "name").localeCompare(text(right.document, "name"), locale));
  const contributingProjects = activeProjects.filter((item) => text(item.document, "owner") !== personId && projectTaskCounts.has(item.document.id)).sort((left, right) => text(left.document, "name").localeCompare(text(right.document, "name"), locale));
  const teams = data.teams.filter((item) => item.document.lifecycle === "active" && strings(item.document, "members").includes(personId));
  const calendar = data.calendars.find((item) => item.document.id === text(person.document, "calendar"));
  const projectNames = new Map(data.projects.map((item) => [item.document.id, text(item.document, "name")]));
  const taskGroups = [...new Set(assignedTasks.map((task) => text(task.document, "project")))].map((projectId) => ({
    projectId,
    project: data.projects.find((item) => item.document.id === projectId),
    tasks: assignedTasks.filter((task) => text(task.document, "project") === projectId),
  })).sort((left, right) => (projectNames.get(left.projectId) ?? left.projectId).localeCompare(projectNames.get(right.projectId) ?? right.projectId, locale));
  const name = text(person.document, "name");
  const initials = name.split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => [...part][0] ?? "").join("").toLocaleUpperCase(locale);
  const dateLabel = (task: EntityResult) => {
    const start = text(task.document, "start"); const due = text(task.document, "due");
    if (validDate(start) && validDate(due)) return t("people.dateRange", { start: formatDateOnly(locale, start), due: formatDateOnly(locale, due) });
    if (validDate(start)) return t("people.starts", { date: formatDateOnly(locale, start) });
    if (validDate(due)) return t("people.due", { date: formatDateOnly(locale, due) });
    return t("people.noDates");
  };

  return <>
    <button className="text-link back-link" onClick={() => onNavigate("people")}>← {t("people.back")}</button>
    <header className="card people-profile-header">
      <div className="people-avatar" aria-hidden="true">{initials}</div>
      <div className="people-profile-identity"><span className="eyebrow">{person.document.id}</span><h2>{name}</h2>{text(person.document, "email") !== "" && <a href={`mailto:${text(person.document, "email")}`}>{text(person.document, "email")}</a>}<div className="people-team-chips">{teams.map((team) => <span key={team.document.id}>{text(team.document, "name")}</span>)}</div></div>
      <dl className="people-profile-meta"><div><dt>{t("people.capacity")}</dt><dd>{t("people.hoursPerWeek", { count: formatNumber(locale, number(person.document, "weekly_capacity_hours")) })}</dd></div><div><dt>{t("people.calendar")}</dt><dd>{calendar === undefined ? "—" : text(calendar.document, "name")}</dd></div></dl>
    </header>

    <dl className="people-profile-stats"><div className="card"><dt>{t("people.assignedTasks")}</dt><dd>{assignedTasks.length}</dd></div><div className="card"><dt>{t("people.responsibleProjects")}</dt><dd>{ownedProjects.length}</dd></div><div className="card"><dt>{t("people.participatingProjects")}</dt><dd>{contributingProjects.length}</dd></div><div className="card"><dt>{t("people.teams")}</dt><dd>{teams.length}</dd></div></dl>

    <TaskCalendar calendar={calendar} key={personId} locale={locale} onNavigate={onNavigate} projectNames={projectNames} tasks={assignedTasks} t={t} />

    <div className="people-profile-layout">
      <main className="people-profile-main">
        <section className="card people-profile-section"><div className="card-heading"><div><h3>{t("people.tasksByProject")}</h3><p>{t("people.tasksDescription")}</p></div></div>
          {taskGroups.length === 0 ? <p className="people-empty">{t("people.noTasks")}</p> : <div className="people-task-groups">{taskGroups.map((group) => <section className="people-task-group" key={group.projectId}><header><button onClick={() => onNavigate("projects", { projectId: group.projectId })}><strong>{projectNames.get(group.projectId) ?? group.projectId}</strong><small>{group.project?.document.owner === personId ? t("people.projectOwner") : t("people.projectContributor")}</small></button><span>{t("people.projectTaskCount", { count: group.tasks.length })}</span></header><div className="people-task-list">{group.tasks.map((task) => <button key={task.document.id} onClick={() => onNavigate("tasks", { projectId: group.projectId, taskId: task.document.id })}><span><strong>{text(task.document, "title")}</strong><small>{task.document.id}</small></span><span className="people-task-status">{text(task.document, "status")}</span><time>{dateLabel(task)}</time></button>)}</div></section>)}</div>}
        </section>
      </main>

      <aside className="people-profile-aside">
        <section className="card people-profile-section"><h3>{t("people.workCalendar")}</h3>{calendar === undefined ? <p className="people-empty">{t("people.noCalendar")}</p> : <><p className="people-calendar-capacity">{t("people.calendarCapacity", { count: formatNumber(locale, number(person.document, "weekly_capacity_hours")) })}</p><div className="calendar-week-preview" aria-label={t("admin.weekPreview")}>{[1, 2, 3, 4, 5, 6, 7].map((day) => <span className={numbers(calendar.document, "working_weekdays").includes(day) ? "working" : "off"} key={day}>{t(`admin.day${day}` as MessageKey)}</span>)}</div><h4>{t("people.holidays")}</h4><div className="people-holidays">{strings(calendar.document, "holidays").filter(validDate).sort().slice(0, 8).map((date) => <time dateTime={date} key={date}>{formatDateOnly(locale, date)}</time>)}{strings(calendar.document, "holidays").filter(validDate).length === 0 && <span>{t("admin.noHolidays")}</span>}</div></>}
        </section>

        <ProjectResponsibility title={t("people.responsibleProjects")} empty={t("people.noResponsibleProjects")} projects={ownedProjects} projectTaskCounts={projectTaskCounts} onNavigate={onNavigate} t={t} />
        <ProjectResponsibility title={t("people.participatingProjects")} empty={t("people.noParticipatingProjects")} projects={contributingProjects} projectTaskCounts={projectTaskCounts} onNavigate={onNavigate} t={t} />
      </aside>
    </div>
  </>;
}

function ProjectResponsibility({ title, empty, projects, projectTaskCounts, onNavigate, t }: { readonly title: string; readonly empty: string; readonly projects: readonly EntityResult[]; readonly projectTaskCounts: ReadonlyMap<string, number>; readonly onNavigate: WorkspaceNavigate; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string }) {
  return <section className="card people-profile-section people-project-section"><div className="people-project-heading"><h3>{title}</h3><strong>{projects.length}</strong></div>{projects.length === 0 ? <p className="people-empty">{empty}</p> : <div className="people-project-list">{projects.map((project) => <button key={project.document.id} onClick={() => onNavigate("projects", { projectId: project.document.id })}><strong>{text(project.document, "name")}</strong><span className="state open">{text(project.document, "status")}</span><small>{t("people.projectTaskCount", { count: projectTaskCounts.get(project.document.id) ?? 0 })}</small></button>)}</div>}</section>;
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const monthKey = (date: Date) => date.toISOString().slice(0, 7);
const monthDate = (value: string) => new Date(`${value}-01T00:00:00.000Z`);
const moveMonth = (value: string, offset: number) => { const date = monthDate(value); date.setUTCMonth(date.getUTCMonth() + offset); return monthKey(date); };
const taskCoversDate = (task: EntityResult, date: string) => {
  const start = text(task.document, "start"); const due = text(task.document, "due");
  if (validDate(start) && validDate(due)) return start <= due && start <= date && date <= due;
  return (validDate(start) && start === date) || (validDate(due) && due === date);
};
const initialTaskMonth = (tasks: readonly EntityResult[]) => {
  const today = new Date().toISOString().slice(0, 10);
  if (tasks.some((task) => taskCoversDate(task, today))) return today.slice(0, 7);
  const dates = tasks.flatMap((task) => [text(task.document, "start"), text(task.document, "due")]).filter(validDate).sort();
  return (dates.find((date) => date >= today) ?? dates.at(-1) ?? today).slice(0, 7);
};
const calendarDates = (value: string) => {
  const first = monthDate(value); const firstWeekday = (first.getUTCDay() + 6) % 7; first.setUTCDate(first.getUTCDate() - firstWeekday);
  const last = monthDate(moveMonth(value, 1)); last.setUTCDate(0); const trailing = 6 - ((last.getUTCDay() + 6) % 7); last.setUTCDate(last.getUTCDate() + trailing);
  const result: Date[] = [];
  for (const current = new Date(first); current <= last; current.setUTCDate(current.getUTCDate() + 1)) result.push(new Date(current));
  return result;
};

function TaskCalendar({ tasks, calendar, projectNames, locale, onNavigate, t }: { readonly tasks: readonly EntityResult[]; readonly calendar?: EntityResult; readonly projectNames: ReadonlyMap<string, string>; readonly locale: Locale; readonly onNavigate: WorkspaceNavigate; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string }) {
  const [month, setMonth] = useState(() => initialTaskMonth(tasks));
  const dates = calendarDates(month);
  const workingWeekdays = new Set(calendar === undefined ? [1, 2, 3, 4, 5] : numbers(calendar.document, "working_weekdays"));
  const holidays = new Set(calendar === undefined ? [] : strings(calendar.document, "holidays").filter(validDate));
  const monthDays = dates.filter((date) => monthKey(date) === month);
  const dayTasks = (date: Date) => tasks.filter((task) => taskCoversDate(task, isoDate(date)));
  const isWorking = (date: Date) => workingWeekdays.has(date.getUTCDay() === 0 ? 7 : date.getUTCDay()) && !holidays.has(isoDate(date));
  const workdays = monthDays.filter(isWorking);
  const freeDays = workdays.filter((date) => dayTasks(date).length === 0).length;
  const overlapDays = workdays.filter((date) => dayTasks(date).length > 1).length;
  const monthLabel = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(monthDate(month));
  const projectIds = [...new Set(tasks.map((task) => text(task.document, "project")))];

  return <section className="card people-task-calendar"><div className="people-calendar-heading"><div><h3>{t("people.schedule")}</h3><p>{t("people.scheduleDescription")}</p></div><div className="people-calendar-navigation"><button aria-label={t("people.previousMonth")} onClick={() => setMonth((current) => moveMonth(current, -1))}>←</button><strong aria-live="polite">{monthLabel}</strong><button aria-label={t("people.nextMonth")} onClick={() => setMonth((current) => moveMonth(current, 1))}>→</button></div></div>
    <div className="people-calendar-summary"><span className="calendar-summary-work">{t("people.workdayCount", { count: workdays.length })}</span><span className="calendar-summary-free">{t("people.freeDayCount", { count: freeDays })}</span><span className="calendar-summary-overlap">{t("people.overlapDayCount", { count: overlapDays })}</span></div>
    <div className="people-calendar-legend"><span className="free">{t("people.legendFree")}</span><span className="busy">{t("people.legendBusy")}</span><span className="overlap">{t("people.legendOverlap")}</span><span className="off">{t("people.legendOff")}</span></div>
    <div className="people-project-legend">{projectIds.map((projectId) => <span key={projectId}>{projectNames.get(projectId) ?? projectId}</span>)}</div>
    <div className="people-calendar-scroll"><div className="people-calendar-grid" aria-label={t("people.calendarGrid")}>
      {[1, 2, 3, 4, 5, 6, 7].map((day) => <div className="people-calendar-weekday" key={day}>{t(`admin.day${day}` as MessageKey)}</div>)}
      {dates.map((date) => { const dateValue = isoDate(date); const tasksForDay = dayTasks(date); const inMonth = monthKey(date) === month; const holiday = holidays.has(dateValue); const working = isWorking(date); const tone = !inMonth ? "outside" : !working ? "off" : tasksForDay.length > 1 ? "overlap" : tasksForDay.length === 1 ? "busy" : "free"; return <div aria-label={`${formatDateOnly(locale, dateValue)} · ${tasksForDay.length === 0 ? working ? t("people.free") : t(holiday ? "people.holiday" : "people.dayOff") : t("people.tasksOnDay", { count: tasksForDay.length })}`} className={`people-calendar-day ${tone}`} data-date={dateValue} key={dateValue}><div className="people-calendar-date"><time dateTime={dateValue}>{date.getUTCDate()}</time>{holiday && <span>{t("people.holiday")}</span>}{inMonth && working && tasksForDay.length === 0 && <span>{t("people.free")}</span>}{inMonth && tasksForDay.length > 1 && <strong>{t("people.overlapCount", { count: tasksForDay.length })}</strong>}</div><div className="people-calendar-events">{tasksForDay.slice(0, 3).map((task) => <button key={task.document.id} onClick={() => onNavigate("tasks", { projectId: text(task.document, "project"), taskId: task.document.id })} title={`${projectNames.get(text(task.document, "project")) ?? text(task.document, "project")} · ${text(task.document, "title")}`}><strong>{text(task.document, "title")}</strong><small>{projectNames.get(text(task.document, "project")) ?? text(task.document, "project")}</small></button>)}{tasksForDay.length > 3 && <span className="people-calendar-more">{t("people.moreTasks", { count: tasksForDay.length - 3 })}</span>}</div></div>; })}
    </div></div>
  </section>;
}
