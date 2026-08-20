import { useCallback, useEffect, useMemo, useState } from "react";
import { availabilityPercentOnDate } from "@gitpm/calendar";
import { activeProjectIds, isOperationalTask } from "@gitpm/shared";
import { scheduleText, scheduleEffort, ScheduleResolver, scheduleTracksConfig } from "./schedules.js";
import { ApiError, deleteRestrictionLabels, type GitPmApi } from "./api.js";
import { AsyncBoundary, useAsyncLoad } from "./async-data.js";
import type { ConfigValue } from "./core-ui.js";
import { EditorDrawer } from "./editor-drawer.js";
import { formatDateOnly, formatNumber, message, type Locale, type MessageKey } from "./i18n.js";
import type { ConfigurationResult, DraftStatus, EntityResult, GitPmDocument, GitPmRole } from "./types.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";
import { draftReadOnlyReason } from "./draft-read-only.js";
import { isCompletedStatus } from "./status-categories.js";
import { availabilityKindLabel, PeopleAvailability } from "./people-availability-ui.js";

const strings = (document: GitPmDocument, key: string) => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
const numbers = (document: GitPmDocument, key: string) => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is number => typeof item === "number") : [];
const text = (document: GitPmDocument, key: string): string => typeof document[key] === "string" ? document[key] as string : "";
const number = (document: GitPmDocument, key: string): number => typeof document[key] === "number" ? document[key] as number : 0;
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/u.test(value);
const configValues = (document: GitPmDocument, key: "statuses" | "issue_types"): ConfigValue[] => Array.isArray(document[key])
  ? (document[key] as unknown[]).filter((item): item is ConfigValue => typeof item === "object" && item !== null && typeof (item as ConfigValue).slug === "string" && typeof (item as ConfigValue).title === "string" && (item as ConfigValue).active === true)
  : [];

interface ProfileData {
  readonly people: readonly EntityResult[];
  readonly calendars: readonly EntityResult[];
  readonly availabilityEvents: readonly EntityResult[];
  readonly teams: readonly EntityResult[];
  readonly projects: readonly EntityResult[];
  readonly tasks: readonly EntityResult[];
  readonly statuses: readonly ConfigValue[];
  readonly scheduling: ScheduleResolver;
}

const FILTERS_STORAGE_KEY = "gitpm.peopleProfile.taskFilters";
type StoredEntry = Readonly<{ statuses: readonly string[]; projects: readonly string[] }>;
type StoredFilters = Record<string, { statuses: readonly string[]; projects: readonly string[] }>;
const stringArray = (value: unknown): readonly string[] | undefined => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
const readStoredTaskFilters = (personId: string): Partial<StoredEntry> => {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY) ?? "{}") as StoredFilters;
    const entry = parsed[personId];
    if (entry === undefined || entry === null) return {};
    const statuses = stringArray(entry.statuses);
    const projects = stringArray(entry.projects);
    return { ...(statuses === undefined ? {} : { statuses }), ...(projects === undefined ? {} : { projects }) };
  } catch { return {}; }
};
const writeStoredTaskFilters = (personId: string, filters: StoredEntry) => {
  if (typeof localStorage === "undefined") return;
  try {
    const parsed = JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY) ?? "{}") as StoredFilters;
    parsed[personId] = { statuses: [...filters.statuses], projects: [...filters.projects] };
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(parsed));
  } catch { /* Browser storage may be unavailable. */ }
};

export function PeopleProfileWorkspace({ api, confirmAction = () => true, draft, locale, onChanged = async () => undefined, personId, role = "Reporter", onNavigate }: { readonly api: GitPmApi; readonly confirmAction?: (message: string) => boolean; readonly draft: DraftStatus; readonly locale: Locale; readonly onChanged?: () => Promise<void>; readonly personId: string; readonly role?: GitPmRole; readonly onNavigate: WorkspaceNavigate }) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [data, setData] = useState<ProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const loadRequest = useAsyncLoad();
  const load = useCallback(async () => {
    await loadRequest.run(async () => {
      const [people, calendars, availabilityEvents, teams, projects, tasks, statusConfig, tracksDocument] = await Promise.all([
        api.listEntities(draft.draft_id, "people"),
        api.listEntities(draft.draft_id, "calendars"),
        api.listEntities(draft.draft_id, "availability-events"),
        api.listEntities(draft.draft_id, "teams"),
        api.listEntities(draft.draft_id, "projects"),
        api.listEntities(draft.draft_id, "tasks"),
        api.getConfiguration(draft.draft_id, "statuses"),
        api.getConfiguration(draft.draft_id, "schedule-tracks"),
      ]);
      return { people, calendars, availabilityEvents, teams, projects, tasks, statuses: configValues(statusConfig.document, "statuses"), scheduling: new ScheduleResolver(scheduleTracksConfig(tracksDocument.document)) };
    }, setData);
  }, [api, draft.draft_id, draft.external_fingerprint, loadRequest.run]);
  useEffect(() => { void load(); }, [load]);
  const readOnly = role !== "Maintainer" || draftReadOnlyReason(draft) !== null;
  const person = data?.people.find((item) => item.document.id === personId);
  const updatePerson = async (document: GitPmDocument) => {
    if (person === undefined || readOnly) return false;
    setError(null);
    try {
      const result = await api.updateEntity(draft.draft_id, "people", person, person.draft_fingerprint, document);
      setData((current) => current === null ? current : { ...current, people: current.people.map((item) => item.document.id === result.document.id ? result : item) });
      await onChanged();
      return true;
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return false; }
  };
  const createAvailability = async (document: GitPmDocument) => {
    if (person === undefined || readOnly || data === null) return false;
    setError(null);
    const fingerprint = data.availabilityEvents[0]?.draft_fingerprint ?? person.draft_fingerprint;
    try {
      await api.createEntity(draft.draft_id, "availability-events", fingerprint, document);
      await load();
      await onChanged();
      return true;
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return false; }
  };
  const updateAvailability = async (event: EntityResult, document: GitPmDocument) => {
    if (person === undefined || readOnly || data === null) return false;
    setError(null);
    const fingerprint = data.availabilityEvents[0]?.draft_fingerprint ?? person.draft_fingerprint;
    try {
      await api.updateEntity(draft.draft_id, "availability-events", event, fingerprint, document);
      await load();
      await onChanged();
      return true;
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return false; }
  };
  const archivePerson = async () => {
    if (person === undefined || readOnly) return false;
    setError(null);
    try { await api.archiveEntity(draft.draft_id, "people", person, person.draft_fingerprint); await onChanged(); onNavigate("people"); return true; }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return false; }
  };
  const restorePerson = async () => {
    if (person === undefined || readOnly) return false;
    setError(null);
    try {
      const result = await api.restoreEntity(draft.draft_id, "people", person, person.draft_fingerprint);
      setData((current) => current === null ? current : { ...current, people: current.people.map((item) => item.document.id === result.document.id ? result : item) });
      await onChanged();
      return true;
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return false; }
  };
  const deletePerson = async () => {
    if (person === undefined || readOnly) return false;
    const name = text(person.document, "name");
    if (!confirmAction(t("core.deleteConfirm", { name }))) return false;
    setError(null);
    try {
      await api.deleteEntity(draft.draft_id, "people", person, person.draft_fingerprint);
    } catch (caught) {
      if (!(caught instanceof ApiError) || caught.code !== "DELETE_RESTRICTED") {
        setError(t("people.deleteFailed", { name, message: caught instanceof Error ? caught.message : String(caught) }));
        return false;
      }
      const references = deleteRestrictionLabels(caught.details);
      if (references.length === 0) {
        setError(t("people.deleteRestrictedUnknown", { name }));
        return false;
      }
      if (!confirmAction(t("people.deleteReferencesConfirm", { name, count: references.length, references: references.map((reference) => `• ${reference}`).join("\n") }))) return false;
      try {
        await api.deleteEntity(draft.draft_id, "people", person, person.draft_fingerprint, true);
      } catch (retryError) {
        const messageKey = retryError instanceof ApiError && retryError.code === "DELETE_RESTRICTED"
          ? "people.deleteRestrictedChanged"
          : "people.deleteFailed";
        setError(t(messageKey, { name, message: retryError instanceof Error ? retryError.message : String(retryError) }));
        return false;
      }
    }
    await onChanged();
    onNavigate("people");
    return true;
  };

  return <section className="people-profile-workspace">
    {role !== "Maintainer" && <div className="alert warning">{t("admin.maintainerOnly")}</div>}
    {error !== null && <div className="alert error">{error}</div>}
    <AsyncBoundary state={loadRequest.state} loading={t("status.loading")} retry={() => { void load(); }} error={(error, retry) => <div className="alert error">{error}<button onClick={retry}>{t("status.retry")}</button></div>}>
      {data !== null && <PeopleProfile archivePerson={archivePerson} createAvailability={createAvailability} data={data} deletePerson={deletePerson} editorOpen={editorOpen} locale={locale} onCloseEditor={() => setEditorOpen(false)} onEdit={() => setEditorOpen(true)} onNavigate={onNavigate} personId={personId} readOnly={readOnly} restorePerson={restorePerson} savePerson={updatePerson} t={t} updateAvailability={updateAvailability} />}
    </AsyncBoundary>
  </section>;
}

function PeopleProfile({ archivePerson, createAvailability, data, deletePerson, editorOpen, locale, onCloseEditor, onEdit, personId, readOnly, restorePerson, savePerson, onNavigate, t, updateAvailability }: { readonly archivePerson: () => Promise<boolean>; readonly createAvailability: (document: GitPmDocument) => Promise<boolean>; readonly data: ProfileData; readonly deletePerson: () => Promise<boolean>; readonly editorOpen: boolean; readonly locale: Locale; readonly onCloseEditor: () => void; readonly onEdit: () => void; readonly personId: string; readonly readOnly: boolean; readonly restorePerson: () => Promise<boolean>; readonly savePerson: (document: GitPmDocument) => Promise<boolean>; readonly onNavigate: WorkspaceNavigate; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string; readonly updateAvailability: (event: EntityResult, document: GitPmDocument) => Promise<boolean> }) {
  const primaryTrackByProject = useMemo(() => new Map(data.projects.map((item) => [item.document.id, data.scheduling.primaryTrack(item.document.planning)])), [data.projects, data.scheduling]);
  const trackOf = useCallback((document: Readonly<Record<string, unknown>>): string => primaryTrackByProject.get(typeof document.project === "string" ? document.project : "") ?? "", [primaryTrackByProject]);
  const text = useCallback((document: Readonly<Record<string, unknown>>, key: string): string => key === "start" || key === "due" ? scheduleText(document, key, trackOf(document)) : typeof document[key] === "string" ? document[key] as string : "", [trackOf]);
  const number = useCallback((document: Readonly<Record<string, unknown>>, key: string): number => key === "estimate_hours" ? scheduleEffort(document, trackOf(document)) ?? 0 : typeof document[key] === "number" ? document[key] as number : 0, [trackOf]);
  const person = data.people.find((item) => item.document.id === personId);
  const projectNames = new Map(data.projects.map((item) => [item.document.id, text(item.document, "name")]));
  const operationalProjects = activeProjectIds(data.projects.map((item) => item.document));
  const assignedTasks = data.tasks
    .filter((item) => isOperationalTask(item.document, operationalProjects) && strings(item.document, "assignees").includes(personId))
    .sort((left, right) => (text(left.document, "due") || "9999").localeCompare(text(right.document, "due") || "9999") || text(left.document, "title").localeCompare(text(right.document, "title"), locale));
  const statusOptions = (() => {
    const configured = data.statuses.map((status) => ({ slug: status.slug, title: status.title, category: status.category }));
    const known = new Set(configured.map((status) => status.slug));
    const extras = assignedTasks
      .map((task) => text(task.document, "status"))
      .filter((slug) => slug !== "" && !known.has(slug));
    return [...configured, ...[...new Set(extras)].map((slug) => ({ slug, title: slug }))];
  })();
  const projectOptions = [...new Set(assignedTasks.map((task) => text(task.document, "project")))]
    .map((projectId) => ({ id: projectId, name: projectNames.get(projectId) ?? projectId }))
    .sort((left, right) => left.name.localeCompare(right.name, locale));
  const initialStatusSelection = (): Set<string> => {
    const stored = readStoredTaskFilters(personId).statuses;
    const known = statusOptions.map((option) => option.slug);
    if (stored !== undefined) return new Set(stored.filter((slug) => known.includes(slug)));
    return new Set(known.filter((slug) => !isCompletedStatus(data.statuses, slug)));
  };
  const initialProjectSelection = (): Set<string> => {
    const stored = readStoredTaskFilters(personId).projects;
    const known = projectOptions.map((option) => option.id);
    if (stored !== undefined) return new Set(stored.filter((id) => known.includes(id)));
    return new Set(known);
  };
  const [statusSelection, setStatusSelection] = useState<Set<string>>(initialStatusSelection);
  const [projectSelection, setProjectSelection] = useState<Set<string>>(initialProjectSelection);
  const [filtersDirty, setFiltersDirty] = useState(false);
  useEffect(() => {
    if (!filtersDirty) return;
    writeStoredTaskFilters(personId, { statuses: [...statusSelection], projects: [...projectSelection] });
  }, [filtersDirty, personId, statusSelection, projectSelection]);
  const toggleStatus = (slug: string, checked: boolean) => {
    setFiltersDirty(true);
    setStatusSelection((current) => { const next = new Set(current); if (checked) next.add(slug); else next.delete(slug); return next; });
  };
  const toggleProject = (id: string, checked: boolean) => {
    setFiltersDirty(true);
    setProjectSelection((current) => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; });
  };
  const resetFilters = () => {
    setFiltersDirty(true);
    setStatusSelection(new Set(statusOptions.map((option) => option.slug).filter((slug) => !isCompletedStatus(data.statuses, slug))));
    setProjectSelection(new Set(projectOptions.map((option) => option.id)));
  };
  if (person === undefined) return <div className="card empty-workspace"><p>{t("people.notFound")}</p><button onClick={() => onNavigate("people")}>← {t("people.back")}</button></div>;

  const projectTaskCounts = new Map<string, number>();
  for (const task of assignedTasks) projectTaskCounts.set(text(task.document, "project"), (projectTaskCounts.get(text(task.document, "project")) ?? 0) + 1);
  const activeProjects = data.projects.filter((item) => item.document.lifecycle === "active");
  const ownedProjects = activeProjects.filter((item) => text(item.document, "owner") === personId).sort((left, right) => text(left.document, "name").localeCompare(text(right.document, "name"), locale));
  const contributingProjects = activeProjects.filter((item) => projectTaskCounts.has(item.document.id)).sort((left, right) => text(left.document, "name").localeCompare(text(right.document, "name"), locale));
  const teams = data.teams.filter((item) => item.document.lifecycle === "active" && strings(item.document, "members").includes(personId));
  const calendar = data.calendars.find((item) => item.document.id === text(person.document, "calendar"));
  const availabilityEvents = data.availabilityEvents.filter((item) => item.document.person === personId);
  const visibleAssignedTasks = assignedTasks.filter((task) => statusSelection.has(text(task.document, "status")) && projectSelection.has(text(task.document, "project")));
  const taskGroups = [...new Set(visibleAssignedTasks.map((task) => text(task.document, "project")))].map((projectId) => ({
    projectId,
    project: data.projects.find((item) => item.document.id === projectId),
    tasks: visibleAssignedTasks.filter((task) => text(task.document, "project") === projectId),
  })).sort((left, right) => (projectNames.get(left.projectId) ?? left.projectId).localeCompare(projectNames.get(right.projectId) ?? right.projectId, locale));
  const filtersActive = visibleAssignedTasks.length !== assignedTasks.length;
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
    {person.document.lifecycle === "archived" && <div className="alert warning"><span>{t("core.archived")}</span><button className="primary" disabled={readOnly} onClick={() => { void restorePerson(); }} type="button">{t("core.restore")}</button></div>}
    <button className="text-link back-link" onClick={() => onNavigate("people")}>← {t("people.back")}</button>
    <header className="card people-profile-header">
      <div className="people-avatar" aria-hidden="true">{initials}</div>
      <div className="people-profile-identity"><span className="eyebrow">{person.document.id}</span><h2>{name}</h2>{text(person.document, "email") !== "" && <a href={`mailto:${text(person.document, "email")}`}>{text(person.document, "email")}</a>}<div className="people-team-chips">{teams.map((team) => <span key={team.document.id}>{text(team.document, "name")}</span>)}</div></div>
      <div className="people-profile-controls"><dl className="people-profile-meta"><div><dt>{t("people.capacity")}</dt><dd>{t("people.hoursPerWeek", { count: formatNumber(locale, number(person.document, "weekly_capacity_hours")) })}</dd></div><div><dt>{t("people.calendar")}</dt><dd>{calendar === undefined ? "—" : text(calendar.document, "name")}</dd></div></dl><button className="primary" disabled={readOnly} onClick={onEdit} type="button">{t("admin.editPerson")}</button></div>
    </header>
    <PersonEditorDrawer archivePerson={archivePerson} calendars={data.calendars.filter((item) => item.document.lifecycle === "active")} close={onCloseEditor} deletePerson={deletePerson} open={editorOpen} person={person} readOnly={readOnly} restorePerson={restorePerson} savePerson={savePerson} t={t} />

    <dl className="people-profile-stats"><div className="card"><dt>{t("people.assignedTasks")}</dt><dd>{assignedTasks.length}</dd></div><div className="card"><dt>{t("people.responsibleProjects")}</dt><dd>{ownedProjects.length}</dd></div><div className="card"><dt>{t("people.participatingProjects")}</dt><dd>{contributingProjects.length}</dd></div><div className="card"><dt>{t("people.teams")}</dt><dd>{teams.length}</dd></div></dl>

    <TaskCalendar availabilityEvents={availabilityEvents} calendar={calendar} key={personId} locale={locale} onNavigate={onNavigate} projectNames={projectNames} tasks={assignedTasks} text={text} t={t} />

    <div className="people-profile-layout">
      <main className="people-profile-main">
        <PeopleAvailability events={availabilityEvents} locale={locale} onCreate={createAvailability} onUpdate={updateAvailability} personId={personId} readOnly={readOnly} t={t} />
        <section className="card people-profile-section"><div className="card-heading"><div><h3>{t("people.tasksByProject")}</h3><p>{t("people.tasksDescription")}</p></div>{assignedTasks.length > 0 && <span className="people-profile-count">{t("people.visibleTasksOfTotal", { count: visibleAssignedTasks.length, total: assignedTasks.length })}</span>}</div>
          {assignedTasks.length > 0 && <PeopleTaskFilters projectOptions={projectOptions} projectSelection={projectSelection} statusOptions={statusOptions} statusSelection={statusSelection} t={t} onReset={resetFilters} onToggleProject={toggleProject} onToggleStatus={toggleStatus} />}
          {assignedTasks.length === 0 ? <p className="people-empty">{t("people.noTasks")}</p>
            : taskGroups.length === 0 ? <p className="people-empty">{t("people.tasksFilteredOut")}{filtersActive && <> · <button className="text-link" onClick={resetFilters} type="button">{t("people.resetFilters")}</button></>}</p>
            : <div className="people-task-groups">{taskGroups.map((group) => <section className="people-task-group" key={group.projectId}><header><button onClick={() => onNavigate("projects", { projectId: group.projectId })}><strong>{projectNames.get(group.projectId) ?? group.projectId}</strong><small>{group.project?.document.owner === personId ? t("people.projectOwner") : t("people.projectContributor")}</small></button><span>{t("people.projectTaskCount", { count: group.tasks.length })}</span></header><div className="people-task-list">{group.tasks.map((task) => <button key={task.document.id} onClick={() => onNavigate("tasks", { projectId: group.projectId, taskId: task.document.id })}><span><strong>{text(task.document, "title")}</strong><small>{task.document.id}</small></span><span className="people-task-status">{statusOptions.find((option) => option.slug === text(task.document, "status"))?.title ?? text(task.document, "status")}</span><time>{dateLabel(task)}</time></button>)}</div></section>)}</div>}
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

function PeopleTaskFilters({ projectOptions, projectSelection, statusOptions, statusSelection, t, onReset, onToggleProject, onToggleStatus }: {
  readonly projectOptions: readonly { readonly id: string; readonly name: string }[];
  readonly projectSelection: ReadonlySet<string>;
  readonly statusOptions: readonly { readonly slug: string; readonly title: string }[];
  readonly statusSelection: ReadonlySet<string>;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
  readonly onReset: () => void;
  readonly onToggleProject: (id: string, checked: boolean) => void;
  readonly onToggleStatus: (slug: string, checked: boolean) => void;
}) {
  if (statusOptions.length === 0 && projectOptions.length === 0) return null;
  return <details className="people-task-filters">
    <summary>{t("people.taskFilters")}</summary>
    <div className="people-task-filters-body">
      {statusOptions.length > 0 && <fieldset className="people-task-filter-group">
        <legend data-field-hint={t("fieldHint.peopleTaskStatus")}>{t("core.status")}</legend>
        <div className="people-task-filter-options">
          {statusOptions.map((option) => <label key={option.slug}><input aria-label={option.title} checked={statusSelection.has(option.slug)} onChange={(event) => onToggleStatus(option.slug, event.target.checked)} type="checkbox" />{option.title}</label>)}
        </div>
      </fieldset>}
      {projectOptions.length > 1 && <fieldset className="people-task-filter-group">
        <legend data-field-hint={t("fieldHint.peopleTaskProject")}>{t("core.project")}</legend>
        <div className="people-task-filter-options">
          {projectOptions.map((option) => <label key={option.id}><input aria-label={option.name} checked={projectSelection.has(option.id)} onChange={(event) => onToggleProject(option.id, event.target.checked)} type="checkbox" />{option.name}</label>)}
        </div>
      </fieldset>}
      <button className="text-link people-task-filters-reset" onClick={onReset} type="button">{t("people.resetFilters")}</button>
    </div>
  </details>;
}

function PersonEditorDrawer({ archivePerson, calendars, close, deletePerson, open, person, readOnly, restorePerson, savePerson, t }: { readonly archivePerson: () => Promise<boolean>; readonly calendars: readonly EntityResult[]; readonly close: () => void; readonly deletePerson: () => Promise<boolean>; readonly open: boolean; readonly person: EntityResult; readonly readOnly: boolean; readonly restorePerson: () => Promise<boolean>; readonly savePerson: (document: GitPmDocument) => Promise<boolean>; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string }) {
  const name = text(person.document, "name");
  const save = async (form: HTMLFormElement) => {
    const data = new FormData(form); const email = String(data.get("email") ?? ""); const calendar = String(data.get("calendar") ?? "");
    return await savePerson({ ...person.document, name: String(data.get("name") ?? ""), email: email || undefined, weekly_capacity_hours: Number(data.get("capacity")), calendar: calendar || undefined });
  };
  return <EditorDrawer closeLabel={t("core.closeEditor")} onClose={close} open={open} title={`${t("admin.editPerson")}: ${name}`}><form className="editor-drawer-form" onSubmit={(event) => { event.preventDefault(); void save(event.currentTarget).then((success) => { if (success) close(); }); }}><label>{t("admin.personName")}<input name="name" defaultValue={name} required /></label><label>{t("admin.email")}<input name="email" defaultValue={text(person.document, "email")} type="email" /></label><label>{t("admin.capacity")}<span className="input-with-suffix"><input aria-label={t("admin.capacity")} name="capacity" type="number" min="0" step="0.25" defaultValue={number(person.document, "weekly_capacity_hours")} required /><span aria-hidden="true">{t("admin.hoursPerWeekUnit")}</span></span></label><label>{t("admin.calendar")}<select name="calendar" defaultValue={text(person.document, "calendar")}><option value="">{t("admin.defaultCalendar")}</option>{calendars.map((item) => <option key={item.document.id} value={item.document.id}>{text(item.document, "name")}</option>)}</select><small className="field-help">{t("admin.defaultCalendarHint")}</small></label><div className="editor-drawer-actions"><details className="more-actions"><summary>{t("core.moreActions")}</summary><div><button disabled={readOnly} onClick={() => { void archivePerson(); }} type="button">{t("core.archive")}</button><button className="danger" data-control-hint={t("controlHint.deleteEntity")} disabled={readOnly} onClick={() => { void deletePerson(); }} type="button">{t("core.delete")}</button></div></details><button onClick={close} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.save")}</button></div></form></EditorDrawer>;
}

function ProjectResponsibility({ title, empty, projects, projectTaskCounts, onNavigate, t }: { readonly title: string; readonly empty: string; readonly projects: readonly EntityResult[]; readonly projectTaskCounts: ReadonlyMap<string, number>; readonly onNavigate: WorkspaceNavigate; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string }) {
  return <section className="card people-profile-section people-project-section"><div className="people-project-heading"><h3>{title}</h3><strong>{projects.length}</strong></div>{projects.length === 0 ? <p className="people-empty">{empty}</p> : <div className="people-project-list">{projects.map((project) => <button key={project.document.id} onClick={() => onNavigate("projects", { projectId: project.document.id })}><strong>{text(project.document, "name")}</strong><span className="state open">{text(project.document, "status")}</span><small>{t("people.projectTaskCount", { count: projectTaskCounts.get(project.document.id) ?? 0 })}</small></button>)}</div>}</section>;
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const monthKey = (date: Date) => date.toISOString().slice(0, 7);
const monthDate = (value: string) => new Date(`${value}-01T00:00:00.000Z`);
const moveMonth = (value: string, offset: number) => { const date = monthDate(value); date.setUTCMonth(date.getUTCMonth() + offset); return monthKey(date); };
type TaskFieldReader = (document: Readonly<Record<string, unknown>>, key: string) => string;
const taskCoversDate = (task: EntityResult, date: string, text: TaskFieldReader) => {
  const start = text(task.document, "start"); const due = text(task.document, "due");
  if (validDate(start) && validDate(due)) return start <= due && start <= date && date <= due;
  return (validDate(start) && start === date) || (validDate(due) && due === date);
};
const initialTaskMonth = (tasks: readonly EntityResult[], text: TaskFieldReader) => {
  const today = new Date().toISOString().slice(0, 10);
  if (tasks.some((task) => taskCoversDate(task, today, text))) return today.slice(0, 7);
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

function TaskCalendar({ availabilityEvents, tasks, calendar, projectNames, locale, onNavigate, text, t }: { readonly availabilityEvents: readonly EntityResult[]; readonly tasks: readonly EntityResult[]; readonly calendar?: EntityResult; readonly projectNames: ReadonlyMap<string, string>; readonly locale: Locale; readonly onNavigate: WorkspaceNavigate; readonly text: (document: Readonly<Record<string, unknown>>, key: string) => string; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string }) {
  const [month, setMonth] = useState(() => initialTaskMonth(tasks, text));
  const dates = calendarDates(month);
  const workingWeekdays = new Set(calendar === undefined ? [1, 2, 3, 4, 5] : numbers(calendar.document, "working_weekdays"));
  const holidays = new Set(calendar === undefined ? [] : strings(calendar.document, "holidays").filter(validDate));
  const availabilityText = (event: EntityResult, key: string) => typeof event.document[key] === "string" ? event.document[key] as string : "";
  const activeAvailability = availabilityEvents.filter((event) => event.document.lifecycle === "active" && availabilityText(event, "state") !== "cancelled" && validDate(availabilityText(event, "start")) && validDate(availabilityText(event, "finish")));
  const exceptions = activeAvailability.map((event) => ({ start: availabilityText(event, "start"), finish: availabilityText(event, "finish"), availability_percent: number(event.document, "availability_percent") }));
  const monthDays = dates.filter((date) => monthKey(date) === month);
  const dayTasks = (date: Date) => tasks.filter((task) => taskCoversDate(task, isoDate(date), text));
  const dayAvailabilityEvents = (date: Date) => activeAvailability.filter((event) => availabilityText(event, "start") <= isoDate(date) && isoDate(date) <= availabilityText(event, "finish"));
  const availability = (date: Date) => availabilityPercentOnDate(isoDate(date), exceptions);
  const isWorking = (date: Date) => workingWeekdays.has(date.getUTCDay() === 0 ? 7 : date.getUTCDay()) && !holidays.has(isoDate(date));
  const workdays = monthDays.filter(isWorking);
  const freeDays = workdays.filter((date) => availability(date) > 0 && dayTasks(date).length === 0).length;
  const overlapDays = workdays.filter((date) => dayTasks(date).length > 1).length;
  const availabilityConflictDays = workdays.filter((date) => availability(date) < 100 && dayTasks(date).length > 0).length;
  const monthLabel = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(monthDate(month));
  const projectIds = [...new Set(tasks.map((task) => text(task.document, "project")))];

  return <section className="card people-task-calendar"><div className="people-calendar-heading"><div><h3>{t("people.schedule")}</h3><p>{t("people.scheduleDescription")}</p></div><div className="people-calendar-navigation"><button aria-label={t("people.previousMonth")} onClick={() => setMonth((current) => moveMonth(current, -1))} title={t("people.previousMonth")}>←</button><strong aria-live="polite">{monthLabel}</strong><button aria-label={t("people.nextMonth")} onClick={() => setMonth((current) => moveMonth(current, 1))} title={t("people.nextMonth")}>→</button></div></div>
    <div className="people-calendar-summary"><span className="calendar-summary-work">{t("people.workdayCount", { count: workdays.length })}</span><span className="calendar-summary-free">{t("people.freeDayCount", { count: freeDays })}</span><span className="calendar-summary-overlap">{t("people.overlapDayCount", { count: overlapDays })}</span><span className="calendar-summary-availability">{t("availability.conflictDayCount", { count: availabilityConflictDays })}</span></div>
    <div className="people-calendar-legend"><span className="free">{t("people.legendFree")}</span><span className="busy">{t("people.legendBusy")}</span><span className="overlap">{t("people.legendOverlap")}</span><span className="unavailable">{t("availability.legendUnavailable")}</span><span className="off">{t("people.legendOff")}</span></div>
    <div className="people-project-legend">{projectIds.map((projectId) => <span key={projectId}>{projectNames.get(projectId) ?? projectId}</span>)}</div>
    <div className="people-calendar-scroll"><div className="people-calendar-grid" aria-label={t("people.calendarGrid")}>
      {[1, 2, 3, 4, 5, 6, 7].map((day) => <div className="people-calendar-weekday" key={day}>{t(`admin.day${day}` as MessageKey)}</div>)}
      {dates.map((date) => { const dateValue = isoDate(date); const tasksForDay = dayTasks(date); const eventsForDay = dayAvailabilityEvents(date); const availablePercent = availability(date); const inMonth = monthKey(date) === month; const holiday = holidays.has(dateValue); const working = isWorking(date); const tone = !inMonth ? "outside" : !working ? "off" : availablePercent === 0 ? "unavailable" : availablePercent < 100 ? "partial" : tasksForDay.length > 1 ? "overlap" : tasksForDay.length === 1 ? "busy" : "free"; return <div aria-label={`${formatDateOnly(locale, dateValue)} · ${availablePercent < 100 ? t("availability.availablePercent", { percent: formatNumber(locale, availablePercent) }) : tasksForDay.length === 0 ? working ? t("people.free") : t(holiday ? "people.holiday" : "people.dayOff") : t("people.tasksOnDay", { count: tasksForDay.length })}`} className={`people-calendar-day ${tone}`} data-date={dateValue} key={dateValue}><div className="people-calendar-date"><time dateTime={dateValue}>{date.getUTCDate()}</time>{holiday && <span>{t("people.holiday")}</span>}{eventsForDay.map((event) => <span className="people-calendar-absence" key={event.document.id}>{availabilityKindLabel(t, availabilityText(event, "kind"))}</span>)}{inMonth && working && availablePercent === 100 && tasksForDay.length === 0 && <span>{t("people.free")}</span>}{inMonth && availablePercent === 100 && tasksForDay.length > 1 && <strong>{t("people.overlapCount", { count: tasksForDay.length })}</strong>}</div><div className="people-calendar-events">{tasksForDay.slice(0, 3).map((task) => <button key={task.document.id} onClick={() => onNavigate("tasks", { projectId: text(task.document, "project"), taskId: task.document.id })} title={`${projectNames.get(text(task.document, "project")) ?? text(task.document, "project")} · ${text(task.document, "title")}`}><strong>{text(task.document, "title")}</strong><small>{availablePercent === 0 ? t("availability.taskPaused") : projectNames.get(text(task.document, "project")) ?? text(task.document, "project")}</small></button>)}{tasksForDay.length > 3 && <span className="people-calendar-more">{t("people.moreTasks", { count: tasksForDay.length - 3 })}</span>}</div></div>; })}
    </div></div>
  </section>;
}
