import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { CALENDAR_PRESETS, calendarPreset, workingDatesBetween, type CalendarPresetId } from "@gitpm/calendar";
import { resolvePlanning, type ScheduleTracksConfig, type TrackDefinition } from "@gitpm/scheduling";
import { activeProjectIds, ENTITY_ID_PREFIX, isOperationalTask, newUniqueEntityId } from "@gitpm/shared";
import { formatApiError, type GitPmApi } from "./api.js";
import { formatDateOnly, message, type Locale, type MessageKey } from "./i18n.js";
import type { ConfigurationDocument, ConfigurationImpactIssue, ConfigurationResult, DraftStatus, EntityResult, GitPmDocument, GitPmRole, ProjectPlanning, RepositoryDocument, RepositoryResult } from "./types.js";
import { AsyncBoundary, useAsyncLoad } from "./async-data.js";
import { EditorDrawer } from "./editor-drawer.js";
import { useExternalHighlights, useReducedMotion } from "./external-updates.js";
import { upsertEntity, useFlipList } from "./optimistic-ui.js";
import { PersonLink, PersonLinks } from "./person-link.js";
import { ProjectLinks } from "./project-link.js";
import { draftReadOnlyReason } from "./draft-read-only.js";
import { ProjectPlanningEditor } from "./project-planning-editor.js";
import { LifecycleFilter, matchesLifecycleFilter, type LifecycleFilterValue } from "./lifecycle-filter.js";

type AdminSurface = "people" | "calendar" | "settings";
type AdminCreateEditor = "calendar" | "person" | "team" | null;
const text = (document: GitPmDocument, key: string) => typeof document[key] === "string" ? document[key] as string : "";
const number = (document: GitPmDocument, key: string) => typeof document[key] === "number" ? document[key] as number : 0;
const strings = (document: GitPmDocument, key: string) => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
const numbers = (document: GitPmDocument, key: string) => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is number => typeof item === "number") : [];
const calendarDates = (data: FormData) => data.getAll("holidays").map(String).filter(Boolean);
const CALENDAR_PRESET_MESSAGES: Readonly<Record<CalendarPresetId, { readonly name: MessageKey; readonly description: MessageKey }>> = {
  "standard-five-day": { name: "admin.presetStandardName", description: "admin.presetStandardDescription" },
  "russia-2026-five-day": { name: "admin.presetRussia2026Name", description: "admin.presetRussia2026Description" },
  "every-day": { name: "admin.presetEveryDayName", description: "admin.presetEveryDayDescription" },
};

export function AdminWorkspace({ api, draft, role, locale, surface, confirmAction = () => true, onOpenPerson, onOpenProject, onOpenView, onChanged }: { readonly api: GitPmApi; readonly draft: DraftStatus; readonly role: GitPmRole; readonly locale: Locale; readonly surface: AdminSurface; readonly confirmAction?: (message: string) => boolean; readonly onOpenPerson?: (personId: string) => void; readonly onOpenProject?: (projectId: string) => void; readonly onOpenView?: (projectId: string, viewId: string) => void; readonly onChanged: () => Promise<void> }) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [calendars, setCalendars] = useState<readonly EntityResult[]>([]);
  const [people, setPeople] = useState<readonly EntityResult[]>([]);
  const [teams, setTeams] = useState<readonly EntityResult[]>([]);
  const [projects, setProjects] = useState<readonly EntityResult[]>([]);
  const [tasks, setTasks] = useState<readonly EntityResult[]>([]);
  const [statuses, setStatuses] = useState<ConfigurationResult | null>(null);
  const [issueTypes, setIssueTypes] = useState<ConfigurationResult | null>(null);
  const [workCategories, setWorkCategories] = useState<ConfigurationResult | null>(null);
  const [scheduleTracks, setScheduleTracks] = useState<ConfigurationResult | null>(null);
  const [repository, setRepository] = useState<RepositoryResult | null>(null);
  const [fingerprint, setFingerprint] = useState(draft.fingerprint);
  const [error, setError] = useState<string | null>(null);
  const [peopleQuery, setPeopleQuery] = useState("");
  const [teamQuery, setTeamQuery] = useState("");
  const [lifecycleFilter, setLifecycleFilter] = useState<LifecycleFilterValue>("active");
  const [createEditor, setCreateEditor] = useState<AdminCreateEditor>(null);
  const { highlights, mark } = useExternalHighlights(500);
  const loadRequest = useAsyncLoad();
  const readOnly = role !== "Maintainer" || draftReadOnlyReason(draft) !== null;

  const load = useCallback(async () => {
    await loadRequest.run(async () => {
      const [nextCalendars, nextPeople, nextTeams, nextProjects, nextTasks, nextStatuses, nextIssueTypes, nextWorkCategories, nextScheduleTracks, nextRepository] = await Promise.all([
        api.listEntities(draft.draft_id, "calendars"), api.listEntities(draft.draft_id, "people"), api.listEntities(draft.draft_id, "teams"), api.listEntities(draft.draft_id, "projects"), api.listEntities(draft.draft_id, "tasks"), api.getConfiguration(draft.draft_id, "statuses"), api.getConfiguration(draft.draft_id, "issue-types"), api.getConfiguration(draft.draft_id, "work-categories"), api.getConfiguration(draft.draft_id, "schedule-tracks"), api.getRepositoryConfiguration(draft.draft_id),
      ]);
      return { nextCalendars, nextPeople, nextTeams, nextProjects, nextTasks, nextStatuses, nextIssueTypes, nextWorkCategories, nextScheduleTracks, nextRepository };
    }, ({ nextCalendars, nextPeople, nextTeams, nextProjects, nextTasks, nextStatuses, nextIssueTypes, nextWorkCategories, nextScheduleTracks, nextRepository }) => {
      setCalendars(nextCalendars); setPeople(nextPeople); setTeams(nextTeams); setProjects(nextProjects); setTasks(nextTasks); setStatuses(nextStatuses); setIssueTypes(nextIssueTypes); setWorkCategories(nextWorkCategories); setScheduleTracks(nextScheduleTracks); setRepository(nextRepository);
      setFingerprint(nextCalendars[0]?.draft_fingerprint ?? nextPeople[0]?.draft_fingerprint ?? nextTeams[0]?.draft_fingerprint ?? nextProjects[0]?.draft_fingerprint ?? nextTasks[0]?.draft_fingerprint ?? nextStatuses.draft_fingerprint);
    });
  }, [api, draft.draft_id, draft.external_fingerprint, loadRequest.run]);
  useEffect(() => { void load(); }, [load]);

  const mutate = async <Result extends EntityResult | ConfigurationResult | RepositoryResult>(operation: () => Promise<Result>): Promise<Result | null> => { setError(null); try {
    const result = await operation(); setFingerprint(result.draft_fingerprint);
    if (result.document.schema === "gitpm/calendar@1") setCalendars((current) => upsertEntity(current, result as EntityResult));
    if (result.document.schema === "gitpm/person@1") setPeople((current) => upsertEntity(current, result as EntityResult));
    if (result.document.schema === "gitpm/team@1") setTeams((current) => upsertEntity(current, result as EntityResult));
    if (result.document.schema === "gitpm/statuses@2") setStatuses(result as ConfigurationResult);
    if (result.document.schema === "gitpm/issue-types@1") setIssueTypes(result as ConfigurationResult);
    if (result.document.schema === "gitpm/work-categories@1") setWorkCategories(result as ConfigurationResult);
    if (result.document.schema === "gitpm/schedule-tracks@1") setScheduleTracks(result as ConfigurationResult);
    if (result.document.schema === "gitpm/repository@1") setRepository(result as RepositoryResult);
    if ("id" in result.document && typeof result.document.id === "string") mark({ [result.document.id]: ["$local"] }); await onChanged(); await load(); return result;
  } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return null; } };
  const remove = async (operation: () => Promise<void>) => { setError(null); try { await operation(); await load(); await onChanged(); return true; } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return false; } };
  const activeCalendars = calendars.filter((item) => item.document.lifecycle === "active");
  const visibleCalendars = calendars.filter((item) => matchesLifecycleFilter(item.document.lifecycle === "active" ? "active" : "archived", lifecycleFilter));
  const repositoryDefaultCalendar = repository === null ? undefined : activeCalendars.find((item) => item.document.id === repository.document.default_calendar);
  const activePeople = people.filter((item) => item.document.lifecycle === "active");
  const visiblePeople = people.filter((item) => matchesLifecycleFilter(item.document.lifecycle === "active" ? "active" : "archived", lifecycleFilter) && `${text(item.document, "name")} ${text(item.document, "email")}`.toLocaleLowerCase(locale).includes(peopleQuery.trim().toLocaleLowerCase(locale)));
  const activeTeams = teams.filter((item) => item.document.lifecycle === "active");
  const peopleNames = new Map(people.map((item) => [item.document.id, text(item.document, "name")]));
  const visibleTeams = teams.filter((item) => matchesLifecycleFilter(item.document.lifecycle === "active" ? "active" : "archived", lifecycleFilter) && `${text(item.document, "name")} ${strings(item.document, "members").map((id) => peopleNames.get(id) ?? "").join(" ")}`.toLocaleLowerCase(locale).includes(teamQuery.trim().toLocaleLowerCase(locale)));
  const teamsByPerson = new Map(activePeople.map((person) => [person.document.id, activeTeams.filter((team) => strings(team.document, "members").includes(person.document.id))]));
  const activeProjects = projects.filter((item) => item.document.lifecycle === "active");
  const activeTasks = tasks.filter((item) => isOperationalTask(item.document, activeProjectIds(activeProjects.map((project) => project.document))));
  const projectsByPerson = new Map(activePeople.map((person) => {
    const ids = new Set<string>();
    for (const project of activeProjects) if (text(project.document, "owner") === person.document.id) ids.add(project.document.id);
    for (const task of activeTasks) if (strings(task.document, "assignees").includes(person.document.id)) ids.add(text(task.document, "project"));
    return [person.document.id, activeProjects.filter((project) => ids.has(project.document.id)).sort((left, right) => text(left.document, "name").localeCompare(text(right.document, "name"), locale))];
  }));
  const confirmDelete = (name: string) => confirmAction(t("core.deleteConfirm", { name }));
  const surfaceHeading: MessageKey = surface === "people" ? "nav.people" : surface === "calendar" ? "nav.calendar" : "nav.settings";

  const createCalendar = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); const document = { schema: "gitpm/calendar@1", id: newUniqueEntityId(ENTITY_ID_PREFIX.calendar, new Set(calendars.map((item) => item.document.id))), name: String(data.get("name")), working_weekdays: data.getAll("weekdays").map(Number), holidays: calendarDates(data), lifecycle: "active" } as GitPmDocument; void mutate(async () => await api.createEntity(draft.draft_id, "calendars", fingerprint, document)).then((result) => { if (result !== null) setCreateEditor(null); }); };
  const createPerson = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); const email = String(data.get("email") ?? ""); const calendar = String(data.get("calendar") ?? ""); const document = { schema: "gitpm/person@1", id: newUniqueEntityId(ENTITY_ID_PREFIX.person, new Set(people.map((item) => item.document.id))), name: String(data.get("name")), weekly_capacity_hours: Number(data.get("capacity")), calendar, lifecycle: "active", ...(email ? { email } : {}) } as GitPmDocument; void mutate(async () => await api.createEntity(draft.draft_id, "people", fingerprint, document)).then((result) => { if (result !== null) setCreateEditor(null); }); };
  const createTeam = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); const document = { schema: "gitpm/team@1", id: newUniqueEntityId(ENTITY_ID_PREFIX.team, new Set(teams.map((item) => item.document.id))), name: String(data.get("name")), members: data.getAll("members").map(String), lifecycle: "active" } as GitPmDocument; void mutate(async () => await api.createEntity(draft.draft_id, "teams", fingerprint, document)).then((result) => { if (result !== null) setCreateEditor(null); }); };

  return <section className="admin-workspace"><div className="section-heading"><span className="eyebrow draft-context-id">{draft.draft_id}</span><h2 aria-hidden="true">{t(surfaceHeading)}</h2></div>
    {role !== "Maintainer" && <div className="alert warning">{t("admin.maintainerOnly")}</div>}{error !== null && <div className="alert error">{error}</div>}
    <AsyncBoundary state={loadRequest.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{loadError}<button onClick={retry}>{t("status.retry")}</button></div>}>
    <>
    {(surface === "people" || surface === "calendar") && <LifecycleFilter onChange={setLifecycleFilter} t={t} value={lifecycleFilter} />}
    {surface === "calendar" && <section className="card"><button className="primary editor-trigger" disabled={readOnly} onClick={() => setCreateEditor("calendar")} type="button">+ {t("admin.createCalendar")}</button><EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setCreateEditor(null)} open={createEditor === "calendar"} title={t("admin.createCalendar")}><CalendarCreateForm disabled={readOnly} onCancel={() => setCreateEditor(null)} onSubmit={createCalendar} t={t} /></EditorDrawer><div className="admin-grid">{visibleCalendars.map((entity) => <div className={highlights[entity.document.id] ? "recently-changed" : ""} key={entity.document.id}><CalendarEditor {...{ api, draft, entity, fingerprint, readOnly, t, locale, mutate, remove, confirmDelete }} defaultCalendarId={repository?.document.default_calendar} /></div>)}</div></section>}
    {surface === "people" && <div className="people-admin-sections"><section className="card directory-card people-directory-card"><div className="card-heading"><h3>{t("admin.people")}</h3><label className="search-field">{t("admin.peopleSearch")}<input type="search" value={peopleQuery} onChange={(event) => setPeopleQuery(event.target.value)} /></label></div><button className="primary editor-trigger" disabled={readOnly || repositoryDefaultCalendar === undefined} onClick={() => setCreateEditor("person")} type="button">+ {t("admin.createPerson")}</button><EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setCreateEditor(null)} open={createEditor === "person"} title={t("admin.createPerson")}><form className="editor-drawer-form" onSubmit={createPerson}><label>{t("core.name")}<input name="name" required /></label><label>{t("admin.email")}<input name="email" type="email" /></label><label>{t("admin.capacity")}<input name="capacity" type="number" min="0" step="0.25" defaultValue="40" required /></label><label>{t("admin.calendar")}<select defaultValue={repositoryDefaultCalendar?.document.id} name="calendar" required>{activeCalendars.map((item) => <option value={item.document.id} key={item.document.id}>{item.document.id === repositoryDefaultCalendar?.document.id ? `${text(item.document, "name")} (${t("admin.defaultCalendar")})` : text(item.document, "name")}</option>)}</select></label><div className="editor-drawer-actions"><button onClick={() => setCreateEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly || repositoryDefaultCalendar === undefined}>{t("admin.createPerson")}</button></div></form></EditorDrawer><div className="directory-table-wrap"><table className="directory-table people-directory-table"><thead><tr><th>{t("admin.person")}</th><th>{t("people.projects")}</th><th>{t("admin.teams")}</th><th>{t("admin.capacity")}</th><th>{t("admin.calendar")}</th></tr></thead><tbody>{visiblePeople.map((entity) => { const calendar = activeCalendars.find((item) => item.document.id === text(entity.document, "calendar")); const personTeams = teamsByPerson.get(entity.document.id) ?? []; return <tr className={highlights[entity.document.id] ? "recently-changed" : ""} key={entity.document.id}><th><PersonLink name={text(entity.document, "name")} onOpen={onOpenPerson} personId={entity.document.id} /></th><td><ProjectLinks empty="—" onOpen={onOpenProject} projectIds={(projectsByPerson.get(entity.document.id) ?? []).map((project) => project.document.id)} projects={activeProjects} /></td><td>{personTeams.length === 0 ? "—" : personTeams.map((team) => text(team.document, "name")).join(", ")}</td><td>{t("people.hoursPerWeek", { count: number(entity.document, "weekly_capacity_hours") })}</td><td>{calendar === undefined ? "—" : text(calendar.document, "name")}</td></tr>; })}</tbody></table></div></section>
      <section className="card directory-card"><div className="card-heading"><h3>{t("admin.teams")}</h3><label className="search-field">{t("admin.teamSearch")}<input type="search" value={teamQuery} onChange={(event) => setTeamQuery(event.target.value)} /></label></div><button className="primary editor-trigger" disabled={readOnly} onClick={() => setCreateEditor("team")} type="button">+ {t("admin.createTeam")}</button><EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setCreateEditor(null)} open={createEditor === "team"} title={t("admin.createTeam")}><form className="editor-drawer-form" onSubmit={createTeam}><label>{t("core.name")}<input name="name" required /></label><MemberChecks people={activePeople} selected={[]} t={t} /><div className="editor-drawer-actions"><button onClick={() => setCreateEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("admin.createTeam")}</button></div></form></EditorDrawer><div className="directory-table-wrap"><table className="directory-table team-directory-table"><thead><tr><th>{t("admin.team")}</th><th>{t("admin.members")}</th><th>{t("admin.actions")}</th></tr></thead><tbody>{visibleTeams.map((entity) => <tr className={highlights[entity.document.id] ? "recently-changed" : ""} key={entity.document.id}><TeamEditor {...{ api, draft, entity, fingerprint, readOnly, t, people, mutate, remove, confirmDelete, onOpenPerson }} /></tr>)}</tbody></table></div></section></div>}
    {surface === "settings" && <section aria-label={t("admin.settings")} className="settings-config-grid">{repository !== null && <RepositoryConfigEditor api={api} calendars={activeCalendars} draft={draft} entity={repository} readOnly={readOnly} t={t} mutate={mutate} />}{statuses !== null && <ConfigEditor api={api} draft={draft} entity={statuses} kind="statuses" listKey="statuses" title={t("admin.statuses")} onOpenView={onOpenView} readOnly={readOnly} t={t} mutate={mutate} />}{issueTypes !== null && <ConfigEditor api={api} draft={draft} entity={issueTypes} kind="issue-types" listKey="issue_types" title={t("admin.issueTypes")} onOpenView={onOpenView} readOnly={readOnly} t={t} mutate={mutate} />}{workCategories !== null && <ConfigEditor api={api} draft={draft} entity={workCategories} kind="work-categories" listKey="categories" title={t("admin.workCategories")} showColor={false} onOpenView={onOpenView} readOnly={readOnly} t={t} mutate={mutate} />}{scheduleTracks !== null && <ScheduleTracksConfigEditor api={api} draft={draft} entity={scheduleTracks} locale={locale} readOnly={readOnly} t={t} mutate={mutate} />}</section>}
    </>
    </AsyncBoundary>
  </section>;
}

interface EditorProps { readonly api: GitPmApi; readonly draft: DraftStatus; readonly entity: EntityResult; readonly fingerprint: string; readonly readOnly: boolean; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string; readonly mutate: (operation: () => Promise<EntityResult>) => Promise<EntityResult | null>; readonly remove: (operation: () => Promise<void>) => Promise<boolean>; readonly confirmDelete: (name: string) => boolean }
const ActionButtons = ({ disabled, archiveDisabled = false, archived = false, save, archive, restore, remove, close, t }: { disabled: boolean; archiveDisabled?: boolean; archived?: boolean; save: (form: HTMLFormElement) => Promise<boolean>; archive: () => Promise<boolean>; restore: () => Promise<boolean>; remove: () => Promise<boolean>; close: () => void; t: (key: MessageKey) => string }) => <div className="editor-drawer-actions"><details className="more-actions"><summary>{t("core.moreActions")}</summary><div>{archived ? <button type="button" disabled={disabled} onClick={() => { void restore().then((success) => { if (success) close(); }); }}>{t("core.restore")}</button> : <button type="button" disabled={disabled || archiveDisabled} onClick={() => { void archive().then((success) => { if (success) close(); }); }}>{t("core.archive")}</button>}<button type="button" className="danger" disabled={disabled || archiveDisabled} onClick={() => { void remove().then((success) => { if (success) close(); }); }}>{t("core.delete")}</button></div></details><button onClick={close} type="button">{t("core.cancel")}</button><button type="button" className="primary" disabled={disabled} onClick={(event) => { if (event.currentTarget.form !== null) void save(event.currentTarget.form).then((success) => { if (success) close(); }); }}>{t("core.save")}</button></div>;

function CalendarEditor(props: EditorProps & { readonly locale: Locale; readonly defaultCalendarId?: string }) {
  const { api, draft, entity, fingerprint, readOnly, t, locale, mutate, remove, confirmDelete, defaultCalendarId } = props;
  const [open, setOpen] = useState(false);
  const name = text(entity.document, "name");
  const weekdays = numbers(entity.document, "working_weekdays");
  const holidays = strings(entity.document, "holidays").filter((date) => /^\d{4}-\d{2}-\d{2}$/u.test(date)).sort().slice(0, 3);
  const submit = async (form: HTMLFormElement) => { const data = new FormData(form); return await mutate(async () => await api.updateEntity(draft.draft_id, "calendars", entity, fingerprint, { ...entity.document, name: String(data.get("name")), working_weekdays: data.getAll("weekdays").map(Number), holidays: calendarDates(data) })) !== null; };
  const isDefault = entity.document.id === defaultCalendarId;
  return <article className="admin-card admin-card-summary"><strong>{name}{isDefault ? ` (${t("admin.defaultCalendar")})` : ""}</strong><div aria-label={t("admin.weekPreview")} className="calendar-week-preview">{[1, 2, 3, 4, 5, 6, 7].map((day) => <span className={weekdays.includes(day) ? "working" : "off"} key={day}>{t(`admin.day${day}` as MessageKey)}</span>)}</div><div className="calendar-exceptions"><span>{t("admin.nextHolidays")}</span>{holidays.length === 0 ? <small>{t("admin.noHolidays")}</small> : holidays.map((date) => <time dateTime={date} key={date}>{formatDateOnly(locale, date)}</time>)}</div><button className="editor-trigger" onClick={() => setOpen(true)} type="button">{t("admin.editCalendar")}</button><EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setOpen(false)} open={open} title={`${t("admin.editCalendar")}: ${name}`}><form className="editor-drawer-form" onSubmit={(event) => event.preventDefault()}><label>{t("core.name")}<input name="name" aria-label={`${t("core.name")} ${name}`} defaultValue={name} /></label><WeekdayChecks selected={weekdays} t={t} /><CalendarDateList selected={strings(entity.document, "holidays")} t={t} />{isDefault && <p className="config-hint">{t("admin.defaultCalendarArchiveBlocked")}</p>}<ActionButtons archiveDisabled={isDefault} archived={entity.document.lifecycle === "archived"} disabled={readOnly} t={t} close={() => setOpen(false)} save={submit} archive={async () => await mutate(async () => await api.archiveEntity(draft.draft_id, "calendars", entity, fingerprint)) !== null} restore={async () => await mutate(async () => await api.restoreEntity(draft.draft_id, "calendars", entity, fingerprint)) !== null} remove={async () => confirmDelete(name) && await remove(async () => await api.deleteEntity(draft.draft_id, "calendars", entity, fingerprint))} /></form></EditorDrawer></article>;
}

function CalendarCreateForm({ disabled, onCancel, onSubmit, t }: { readonly disabled: boolean; readonly onCancel: () => void; readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string }) {
  const [presetId, setPresetId] = useState<CalendarPresetId>("standard-five-day");
  const preset = calendarPreset(presetId);
  const messages = CALENDAR_PRESET_MESSAGES[presetId];
  const workingDays = preset.coverage === undefined ? null : workingDatesBetween(preset.coverage.start, preset.coverage.due, preset).length;
  return <form className="editor-drawer-form" onSubmit={onSubmit}>
    <label>{t("admin.calendarPreset")}<select name="preset" value={presetId} onChange={(event) => setPresetId(event.currentTarget.value as CalendarPresetId)}>{CALENDAR_PRESETS.map((item) => <option key={item.id} value={item.id}>{t(CALENDAR_PRESET_MESSAGES[item.id].name)}</option>)}</select></label>
    <div className="calendar-preset-summary"><strong>{t(messages.name)}</strong><p>{t(messages.description)}</p>{workingDays !== null && preset.coverage !== undefined && <span>{t("admin.presetCoverage", { year: preset.coverage.start.slice(0, 4), count: workingDays })}</span>}{preset.source_url !== undefined && <a href={preset.source_url} rel="noreferrer" target="_blank">{t("admin.presetSource")}</a>}</div>
    <label>{t("core.name")}<input key={`name:${presetId}`} name="name" defaultValue={t(messages.name)} required /></label>
    <WeekdayChecks key={`weekdays:${presetId}`} selected={preset.working_weekdays} t={t} />
    <CalendarDateList key={`holidays:${presetId}`} selected={preset.holidays} t={t} />
    <div className="editor-drawer-actions"><button onClick={onCancel} type="button">{t("core.cancel")}</button><button className="primary" disabled={disabled}>{t("admin.createCalendar")}</button></div>
  </form>;
}

function CalendarDateList({ selected, t }: { readonly selected: readonly string[]; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string }) {
  const [dates, setDates] = useState([...selected]);
  return <fieldset className="calendar-date-list"><legend>{t("admin.holidays")}</legend><p>{t("admin.holidaysHint")}</p><div>{dates.map((date, index) => <div className="calendar-date-row" key={index}><input aria-label={t("admin.holidayDate", { index: index + 1 })} name="holidays" onChange={(event) => { const value = event.currentTarget.value; setDates((current) => current.map((item, itemIndex) => itemIndex === index ? value : item)); }} required type="date" value={date} /><button aria-label={t("admin.removeHoliday", { date: date || index + 1 })} onClick={() => setDates((current) => current.filter((_item, itemIndex) => itemIndex !== index))} title={t("admin.removeHoliday", { date: date || index + 1 })} type="button">×</button></div>)}</div>{dates.length === 0 && <small>{t("admin.noHolidays")}</small>}<button className="calendar-date-add" onClick={() => setDates((current) => [...current, ""])} type="button">+ {t("admin.addHoliday")}</button></fieldset>;
}

function MemberChecks({ people, selected, t }: { people: readonly EntityResult[]; selected: readonly string[]; t: (key: MessageKey) => string }) { return <fieldset><legend>{t("admin.members")}</legend>{people.map((person) => <label key={person.document.id}><input type="checkbox" name="members" value={person.document.id} defaultChecked={selected.includes(person.document.id)} />{text(person.document, "name")}</label>)}</fieldset>; }
function WeekdayChecks({ selected, t }: { selected: readonly number[]; t: (key: MessageKey) => string }) { return <fieldset className="weekday-checks"><legend>{t("admin.weekdays")}</legend>{[1, 2, 3, 4, 5, 6, 7].map((day) => <label key={day}><input type="checkbox" name="weekdays" value={day} defaultChecked={selected.includes(day)} />{t(`admin.day${day}` as MessageKey)}</label>)}</fieldset>; }
function TeamEditor(props: EditorProps & { people: readonly EntityResult[]; readonly onOpenPerson?: (personId: string) => void }) {
  const { api, draft, entity, fingerprint, readOnly, t, people, mutate, remove, confirmDelete, onOpenPerson } = props;
  const [open, setOpen] = useState(false);
  const name = text(entity.document, "name");
  const selected = strings(entity.document, "members");
  const selectablePeople = people.filter((person) => person.document.lifecycle === "active" || selected.includes(person.document.id));
  const update = async (form: HTMLFormElement) => { const data = new FormData(form); return await mutate(async () => await api.updateEntity(draft.draft_id, "teams", entity, fingerprint, { ...entity.document, name: String(data.get("name")), members: data.getAll("members").map(String) })) !== null; };
  return <><th>{name}</th><td><PersonLinks empty={t("admin.noMembers")} onOpen={onOpenPerson} people={people} personIds={selected} /></td><td><button className="editor-trigger" onClick={() => setOpen(true)} type="button">{t("admin.editTeam")}</button><EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setOpen(false)} open={open} title={`${t("admin.editTeam")}: ${name}`}><form className="editor-drawer-form" onSubmit={(event) => event.preventDefault()}><label>{t("core.name")}<input name="name" aria-label={`${t("core.name")} ${name}`} defaultValue={name} /></label><MemberChecks people={selectablePeople} selected={selected} t={t} /><ActionButtons archived={entity.document.lifecycle === "archived"} disabled={readOnly} t={t} close={() => setOpen(false)} save={update} archive={async () => await mutate(async () => await api.archiveEntity(draft.draft_id, "teams", entity, fingerprint)) !== null} restore={async () => await mutate(async () => await api.restoreEntity(draft.draft_id, "teams", entity, fingerprint)) !== null} remove={async () => confirmDelete(name) && await remove(async () => await api.deleteEntity(draft.draft_id, "teams", entity, fingerprint))} /></form></EditorDrawer></td></>;
}

function RepositoryConfigEditor({ api, calendars, draft, entity, readOnly, t, mutate }: { readonly api: GitPmApi; readonly calendars: readonly EntityResult[]; readonly draft: DraftStatus; readonly entity: RepositoryResult; readonly readOnly: boolean; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string; readonly mutate: (operation: () => Promise<RepositoryResult>) => Promise<RepositoryResult | null> }) {
  const [open, setOpen] = useState(false);
  const [defaultCalendar, setDefaultCalendar] = useState(entity.document.default_calendar);
  const [pollInterval, setPollInterval] = useState(entity.document.ui_poll_interval_seconds);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDefaultCalendar(entity.document.default_calendar); setPollInterval(entity.document.ui_poll_interval_seconds); }, [entity]);
  const reset = () => { setDefaultCalendar(entity.document.default_calendar); setPollInterval(entity.document.ui_poll_interval_seconds); };
  const close = () => { reset(); setOpen(false); };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true);
    const document = { ...entity.document, default_calendar: defaultCalendar, ui_poll_interval_seconds: pollInterval } as RepositoryDocument;
    void mutate(async () => await api.updateRepositoryConfiguration(draft.draft_id, entity, entity.draft_fingerprint, document)).then((result) => {
      setBusy(false); if (result !== null) setOpen(false);
    });
  };
  const calendarName = calendars.find((calendar) => calendar.document.id === entity.document.default_calendar)?.document.name ?? entity.document.default_calendar;
  return <article className="config-editor config-summary repository-config-editor">
    <header className="config-summary-heading"><h3>{t("admin.repositoryConfiguration")}</h3><button className="editor-trigger" aria-label={t("admin.editConfig", { name: t("admin.repositoryConfiguration") })} disabled={readOnly} onClick={() => { reset(); setOpen(true); }} type="button">{t("core.edit")}</button></header>
    <dl><div><dt>{t("admin.defaultCalendar")}</dt><dd>{String(calendarName)}</dd></div><div><dt>{t("admin.pollInterval")}</dt><dd>{t("admin.pollIntervalSeconds", { count: entity.document.ui_poll_interval_seconds })}</dd></div></dl>
    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={close} open={open} title={`${t("core.edit")}: ${t("admin.repositoryConfiguration")}`}><form className="editor-drawer-form" onSubmit={submit}>
      <label>{t("admin.defaultCalendar")}<select disabled={readOnly || busy} onChange={(event) => setDefaultCalendar(event.currentTarget.value)} required value={defaultCalendar}>{calendars.map((calendar) => <option key={calendar.document.id} value={calendar.document.id}>{String(calendar.document.name ?? calendar.document.id)}</option>)}</select></label>
      <label>{t("admin.pollInterval")}<input disabled={readOnly || busy} max="10" min="2" onChange={(event) => setPollInterval(event.currentTarget.valueAsNumber)} required type="number" value={pollInterval} /></label>
      <div className="editor-drawer-actions"><button onClick={close} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly || busy || !Number.isInteger(pollInterval) || pollInterval < 2 || pollInterval > 10}>{t("core.save")}</button></div>
    </form></EditorDrawer>
  </article>;
}

const ConfigurationImpactNotice = ({ issues, onOpenView, t }: { readonly issues: readonly ConfigurationImpactIssue[]; readonly onOpenView?: (projectId: string, viewId: string) => void; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string }) => issues.length === 0 ? null : <div className="alert error configuration-impact"><strong>{t("admin.configurationBlocked")}</strong><ul>{issues.map((issue) => {
  const view = /^projects\/(P-[^/]+)\/views\/(V-[^/.]+)\.yaml$/u.exec(issue.path);
  return <li key={`${issue.code}:${issue.path}:${issue.field ?? ""}`}><code>{issue.path}{issue.field === undefined ? "" : `#${issue.field}`}</code>: {issue.message}{view !== null && onOpenView !== undefined && <button onClick={() => onOpenView(view[1]!, view[2]!)} type="button">{t("admin.openBlockingView")}</button>}</li>;
})}</ul></div>;

interface ConfigValue { readonly slug: string; readonly title: string; readonly color?: string; readonly active: boolean; readonly category?: "backlog" | "active" | "done" | "cancelled" }
const CONFIG_COLORS = {
  gray: { swatch: "#6b7280", soft: "#eef0f2", text: "#3f4650" },
  blue: { swatch: "#2563eb", soft: "#e9f0ff", text: "#244a99" },
  green: { swatch: "#15803d", soft: "#e5f4e9", text: "#25613a" },
  red: { swatch: "#dc2626", soft: "#fce9e8", text: "#8f302b" },
  orange: { swatch: "#d97706", soft: "#fff0dc", text: "#8a5109" },
  yellow: { swatch: "#ca8a04", soft: "#fff7d6", text: "#745a0b" },
  purple: { swatch: "#7c3aed", soft: "#f2eafd", text: "#6032a2" },
  teal: { swatch: "#0f766e", soft: "#e2f3f1", text: "#285f5a" },
} as const;
const CONFIG_COLOR_OPTIONS = [
  ["gray", "admin.colorGray"],
  ["blue", "admin.colorBlue"],
  ["green", "admin.colorGreen"],
  ["red", "admin.colorRed"],
  ["orange", "admin.colorOrange"],
  ["yellow", "admin.colorYellow"],
  ["purple", "admin.colorPurple"],
  ["teal", "admin.colorTeal"],
] as const satisfies readonly (readonly [keyof typeof CONFIG_COLORS, MessageKey])[];
const fallbackConfigColor = CONFIG_COLORS.gray;
const configColor = (token: string) => CONFIG_COLORS[token as keyof typeof CONFIG_COLORS] ?? fallbackConfigColor;
const configBadgeStyle = (token: string): CSSProperties => {
  const color = configColor(token);
  return { "--config-swatch": color.swatch, backgroundColor: color.soft, borderColor: color.swatch, color: color.text } as CSSProperties;
};
const ConfigBadge = ({ item, inactiveLabel }: { readonly item: ConfigValue; readonly inactiveLabel: string }) => <span className={`config-preview${item.active ? "" : " inactive"}`} style={configBadgeStyle(item.color ?? "gray")} title={item.active ? (item.color ?? "gray") : inactiveLabel}><span aria-hidden="true" className="config-preview-dot" />{item.title}</span>;
const ConfigColorPalette = ({ item, disabled, t, onChange }: { readonly item: ConfigValue; readonly disabled: boolean; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string; readonly onChange: (color: string) => void }) => {
  const color = item.color ?? "gray";
  const known = CONFIG_COLOR_OPTIONS.some(([token]) => token === color);
  const options: readonly { readonly token: string; readonly label?: MessageKey }[] = [
    ...(!known ? [{ token: color }] : []),
    ...CONFIG_COLOR_OPTIONS.map(([token, label]) => ({ token, label })),
  ];
  return <fieldset aria-label={`${t("admin.color")} ${item.slug}`} className="config-color-palette"><legend>{t("admin.color")}</legend><div className="config-color-options">{options.map(({ token, label }) => {
    const name = label === undefined ? token : t(label);
    return <button aria-label={t("admin.chooseColor", { color: name, name: item.title })} aria-pressed={item.color === token} disabled={disabled} key={token} onClick={() => onChange(token)} style={{ backgroundColor: configColor(token).swatch }} title={name} type="button"><span aria-hidden="true" className="config-color-check">✓</span></button>;
  })}</div></fieldset>;
};
function ConfigEditor({ api, draft, entity, kind, listKey, title, showColor = true, onOpenView, readOnly, t, mutate }: { readonly api: GitPmApi; readonly draft: DraftStatus; readonly entity: ConfigurationResult; readonly kind: "statuses" | "issue-types" | "work-categories"; readonly listKey: "statuses" | "issue_types" | "categories"; readonly title: string; readonly showColor?: boolean; readonly onOpenView?: (projectId: string, viewId: string) => void; readonly readOnly: boolean; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string; readonly mutate: <Result extends EntityResult | ConfigurationResult>(operation: () => Promise<Result>) => Promise<Result | null> }) {
  const [open, setOpen] = useState(false);
  const entityValues = Array.isArray(entity.document[listKey]) ? entity.document[listKey] as ConfigValue[] : [];
  const [values, setValues] = useState(entityValues);
  const [newSlug, setNewSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [impactIssues, setImpactIssues] = useState<readonly ConfigurationImpactIssue[]>([]);
  const formRef = useFlipList<HTMLFormElement>(useReducedMotion());
  useEffect(() => setValues(entityValues), [entity]);
  const updateValue = (index: number, changes: Partial<Pick<ConfigValue, "title" | "color" | "active" | "category">>) => setValues((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item));
  const persist = async (next: readonly ConfigValue[], onPersisted?: () => void) => {
    const previous = values; setValues([...next]); setBusy(true);
    const document = { ...entity.document, [listKey]: next } as ConfigurationDocument;
    try {
      const impact = await api.getConfigurationImpact(draft.draft_id, kind, document);
      setImpactIssues(impact.issues);
      if (impact.blocking) { setBusy(false); return null; }
    } catch (caught) {
      setImpactIssues([{ code: "CONFIGURATION_IMPACT_UNAVAILABLE", path: entity.path, message: formatApiError(caught) }]); setBusy(false); return null;
    }
    const result = await mutate(async () => { const saved = await api.updateConfiguration(draft.draft_id, kind, entity, entity.draft_fingerprint, document); setBusy(false); onPersisted?.(); return saved; });
    if (result === null) setValues(previous);
    setBusy(false); return result;
  };
  const close = () => { setValues(entityValues); setNewSlug(""); setImpactIssues([]); setOpen(false); };
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void persist(values).then((result) => { if (result !== null) setOpen(false); }); };
  const move = (index: number, offset: number) => setValues((current) => { const next = [...current]; const target = index + offset; if (target < 0 || target >= next.length) return current; [next[index], next[target]] = [next[target]!, next[index]!]; return next; });
  const addValue = () => {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(newSlug) || values.some((item) => item.slug === newSlug)) return;
    const next = { slug: newSlug, title: newSlug, active: true, ...(kind === "work-categories" ? {} : { color: "gray" }), ...(kind === "statuses" ? { category: "backlog" as const } : {}) };
    setValues((current) => [...current, next]); setNewSlug("");
  };
  const removeValue = (index: number) => setValues((current) => current.filter((_, itemIndex) => itemIndex !== index));
  const canAdd = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(newSlug) && !values.some((item) => item.slug === newSlug);
  return <article className="config-editor config-summary">
    <header className="config-summary-heading"><h3>{title}</h3><button className="editor-trigger" aria-label={t("admin.editConfig", { name: title })} disabled={readOnly} onClick={() => { setValues(entityValues); setOpen(true); }} type="button">{t("core.edit")}</button></header>
    <div className="config-summary-values">{values.map((item) => <ConfigBadge inactiveLabel={t("admin.inactive")} item={item} key={item.slug} />)}</div>
    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={close} open={open} title={`${t("core.edit")}: ${title}`}><form className="editor-drawer-form config-editor-form" onSubmit={submit} ref={formRef}>
      <p className="config-hint">{t("admin.slugHint")}</p>
      <ConfigurationImpactNotice issues={impactIssues} onOpenView={onOpenView} t={t} />
      <div className="config-list">{values.map((item, index) => <section className="config-row" data-flip-key={`config:${kind}:${item.slug}`} key={item.slug}>
        <header className="config-row-heading">
          <div className="config-identity"><ConfigBadge inactiveLabel={t("admin.inactive")} item={item} /><span className="config-technical-id"><span>{t("admin.technicalId")}</span><code>{item.slug}</code></span></div>
          <label className="config-active-switch"><input aria-label={t("admin.activeLabel", { name: item.title })} checked={item.active} disabled={readOnly || busy} name={`active-${index}`} onChange={(event) => updateValue(index, { active: event.currentTarget.checked })} role="switch" type="checkbox" /><span aria-hidden="true" className="config-switch-track" /><span>{t("admin.active")}</span></label>
        </header>
        <div className="config-row-fields">
           <label className="config-field"><span>{t("core.name")}</span><input aria-label={`${title} ${item.slug}`} disabled={readOnly || busy} name={`title-${index}`} onChange={(event) => updateValue(index, { title: event.currentTarget.value })} required value={item.title} /></label>
           {showColor && <ConfigColorPalette disabled={readOnly || busy} item={item} onChange={(color) => updateValue(index, { color })} t={t} />}
           {kind === "statuses" && <label className="config-field"><span>{t("admin.statusCategory")}</span><select aria-label={`${t("admin.statusCategory")} ${item.slug}`} disabled={readOnly || busy} onChange={(event) => updateValue(index, { category: event.currentTarget.value as ConfigValue["category"] })} value={item.category ?? "backlog"}><option value="backlog">{t("admin.categoryBacklog")}</option><option value="active">{t("admin.categoryActive")}</option><option value="done">{t("admin.categoryDone")}</option><option value="cancelled">{t("admin.categoryCancelled")}</option></select></label>}
        </div>
        <footer className="config-row-footer"><span>{t("admin.orderPosition", { position: index + 1, count: values.length })}</span><div className="config-order"><button aria-label={t("admin.moveUp", { name: item.title })} disabled={readOnly || busy || index === 0} onClick={() => move(index, -1)} type="button"><span aria-hidden="true">↑</span>{t("admin.higher")}</button><button aria-label={t("admin.moveDown", { name: item.title })} disabled={readOnly || busy || index === values.length - 1} onClick={() => move(index, 1)} type="button"><span aria-hidden="true">↓</span>{t("admin.lower")}</button><button aria-label={t("admin.removeConfigValue", { name: item.title })} className="danger" disabled={readOnly || busy || values.length === 1} onClick={() => removeValue(index)} type="button">{t("core.delete")}</button></div></footer>
      </section>)}</div>
      <div className="config-add-row"><label className="config-field"><span>{t("admin.newTechnicalId")}</span><input aria-label={t("admin.newTechnicalId")} disabled={readOnly || busy} onChange={(event) => setNewSlug(event.currentTarget.value)} pattern="[a-z][a-z0-9]*(?:-[a-z0-9]+)*" value={newSlug} /></label><button disabled={readOnly || busy || !canAdd} onClick={addValue} type="button">{t("admin.addConfigValue")}</button></div>
      <div className="editor-drawer-actions"><button onClick={close} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly || busy}>{t("core.save")}</button></div>
    </form></EditorDrawer>
  </article>;
}

function ScheduleTracksConfigEditor({ api, draft, entity, locale, readOnly, t, mutate }: { readonly api: GitPmApi; readonly draft: DraftStatus; readonly entity: ConfigurationResult; readonly locale: Locale; readonly readOnly: boolean; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string; readonly mutate: <Result extends EntityResult | ConfigurationResult>(operation: () => Promise<Result>) => Promise<Result | null> }) {
  const title = t("admin.scheduleTracks");
  const entityTracks = (Array.isArray(entity.document.tracks) ? entity.document.tracks : []) as unknown as readonly TrackDefinition[];
  const entityDefaults = (typeof entity.document.defaults === "object" && entity.document.defaults !== null ? entity.document.defaults : {}) as ProjectPlanning;
  const resolvedDefaults = resolvePlanning({ schema: "gitpm/schedule-tracks@1", tracks: entityTracks, defaults: entityDefaults } as ScheduleTracksConfig);
  const [open, setOpen] = useState(false);
  const [tracks, setTracks] = useState(entityTracks);
  const [defaults, setDefaults] = useState<ProjectPlanning>(resolvedDefaults);
  const [defaultsTouched, setDefaultsTouched] = useState(false);
  const [newTrackSlug, setNewTrackSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [impactIssues, setImpactIssues] = useState<readonly ConfigurationImpactIssue[]>([]);
  const formRef = useFlipList<HTMLFormElement>(useReducedMotion());
  useEffect(() => {
    setTracks(entityTracks);
    setDefaults(resolvedDefaults);
    setDefaultsTouched(false);
  }, [entity]);
  const reset = () => { setTracks(entityTracks); setDefaults(resolvedDefaults); setDefaultsTouched(false); setNewTrackSlug(""); setImpactIssues([]); };
  const close = () => { reset(); setOpen(false); };
  const updateTitle = (index: number, nextTitle: string) => setTracks((current) => current.map((track, trackIndex) => trackIndex === index ? { ...track, title: nextTitle } : track));
  const move = (index: number, offset: number) => setTracks((current) => {
    const next = [...current]; const target = index + offset;
    if (target < 0 || target >= next.length) return current;
    [next[index], next[target]] = [next[target]!, next[index]!];
    return next;
  });
  const updateTrack = (index: number, changes: Readonly<Record<string, unknown>>) => setTracks((current) => current.map((track, trackIndex) => trackIndex === index ? { ...track, ...changes } as TrackDefinition : track));
  const toggleCapability = (index: number, capability: "dates" | "effort" | "dependencies") => setTracks((current) => current.map((track, trackIndex) => {
    if (trackIndex !== index || track.kind !== "manual") return track;
    const capabilities = track.capabilities?.includes(capability) ? track.capabilities.filter((item) => item !== capability) : [...(track.capabilities ?? []), capability];
    return capabilities.length === 0 ? track : { ...track, capabilities };
  }));
  const changeKind = (index: number, kind: "manual" | "actual") => updateTrack(index, kind === "manual" ? { kind, capabilities: ["dates"], source: undefined } : { kind, source: "time_entries", capabilities: undefined });
  const addTrack = () => {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(newTrackSlug) || tracks.some((track) => track.slug === newTrackSlug)) return;
    setTracks((current) => [...current, { slug: newTrackSlug, title: newTrackSlug, kind: "manual", capabilities: ["dates"] }]); setNewTrackSlug("");
  };
  const removeTrack = (index: number) => {
    const removed = tracks[index]; if (removed === undefined) return;
    setTracks((current) => current.filter((_, trackIndex) => trackIndex !== index));
    setDefaults((current) => {
      const next = { ...current, enabled_tracks: current.enabled_tracks?.filter((slug) => slug !== removed.slug), dashboard_tracks: current.dashboard_tracks?.filter((slug) => slug !== removed.slug) };
      if (next.primary_track === removed.slug) delete (next as { primary_track?: string }).primary_track;
      if (next.workload_track === removed.slug) delete (next as { workload_track?: string }).workload_track;
      if (next.comparison_track === removed.slug) delete (next as { comparison_track?: string }).comparison_track;
      return next;
    });
    setDefaultsTouched(true);
  };
  const canAddTrack = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(newTrackSlug) && !tracks.some((track) => track.slug === newTrackSlug);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true);
    const document = { ...entity.document, tracks, defaults: defaultsTouched ? defaults : entityDefaults } as ConfigurationDocument;
    void (async () => {
      try {
        const impact = await api.getConfigurationImpact(draft.draft_id, "schedule-tracks", document);
        setImpactIssues(impact.issues);
        if (impact.blocking) { setBusy(false); return; }
      } catch (caught) {
        setImpactIssues([{ code: "CONFIGURATION_IMPACT_UNAVAILABLE", path: entity.path, message: formatApiError(caught) }]); setBusy(false); return;
      }
      const result = await mutate(async () => await api.updateConfiguration(draft.draft_id, "schedule-tracks", entity, entity.draft_fingerprint, document));
      setBusy(false); if (result !== null) setOpen(false);
    })();
  };
  return <article className="config-editor config-summary schedule-tracks-config-editor">
    <header className="config-summary-heading"><h3>{title}</h3><button className="editor-trigger" aria-label={t("admin.editConfig", { name: title })} disabled={readOnly} onClick={() => { reset(); setOpen(true); }} type="button">{t("core.edit")}</button></header>
    <div className="config-summary-values">{tracks.map((track) => <span className="config-preview schedule-track-preview" key={track.slug}><span aria-hidden="true" className="config-preview-dot" />{track.title}<small>{track.kind === "manual" ? t("admin.manualTrack") : t("admin.actualTrack")}</small></span>)}</div>
    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={close} open={open} title={`${t("core.edit")}: ${title}`}><form className="editor-drawer-form config-editor-form" onSubmit={submit} ref={formRef}>
      <p className="config-hint">{t("admin.scheduleTracksHint")}</p>
      <ConfigurationImpactNotice issues={impactIssues} t={t} />
      <div className="config-list">{tracks.map((track, index) => <section className="config-row schedule-track-row" data-flip-key={`config:schedule-tracks:${track.slug}`} key={track.slug}>
        <header className="config-row-heading"><div className="config-identity"><strong>{track.title}</strong><span className="config-technical-id"><span>{t("admin.technicalId")}</span><code>{track.slug}</code></span></div><span className={`schedule-track-kind ${track.kind}`}>{track.kind === "manual" ? t("admin.manualTrack") : t("admin.actualTrack")}</span></header>
        <div className="config-row-fields"><label className="config-field"><span>{t("core.name")}</span><input aria-label={`${title} ${track.slug}`} disabled={readOnly || busy} onChange={(event) => updateTitle(index, event.currentTarget.value)} required value={track.title} /></label><label className="config-field"><span>{t("admin.trackKind")}</span><select aria-label={`${t("admin.trackKind")} ${track.slug}`} disabled={readOnly || busy} onChange={(event) => changeKind(index, event.currentTarget.value as "manual" | "actual")} value={track.kind}><option value="manual">{t("admin.manualTrack")}</option><option value="actual">{t("admin.actualTrack")}</option></select></label><fieldset className="config-field schedule-track-capabilities"><legend>{track.kind === "manual" ? t("admin.capabilities") : t("admin.trackSource")}</legend><div>{track.kind === "manual" ? (["dates", "effort", "dependencies"] as const).map((capability) => <label key={capability}><input checked={track.capabilities?.includes(capability) ?? false} disabled={readOnly || busy || (track.capabilities?.length === 1 && track.capabilities[0] === capability)} onChange={() => toggleCapability(index, capability)} type="checkbox" />{t(`admin.capability${capability[0]!.toUpperCase()}${capability.slice(1)}` as MessageKey)}</label>) : <span>{t("admin.timeEntriesSource")}</span>}</div></fieldset></div>
        <footer className="config-row-footer"><span>{t("admin.orderPosition", { position: index + 1, count: tracks.length })}</span><div className="config-order"><button aria-label={t("admin.moveUp", { name: track.title })} disabled={readOnly || busy || index === 0} onClick={() => move(index, -1)} type="button"><span aria-hidden="true">↑</span>{t("admin.higher")}</button><button aria-label={t("admin.moveDown", { name: track.title })} disabled={readOnly || busy || index === tracks.length - 1} onClick={() => move(index, 1)} type="button"><span aria-hidden="true">↓</span>{t("admin.lower")}</button><button aria-label={t("admin.removeConfigValue", { name: track.title })} className="danger" disabled={readOnly || busy || tracks.length === 1} onClick={() => removeTrack(index)} type="button">{t("core.delete")}</button></div></footer>
      </section>)}</div>
      <div className="config-add-row"><label className="config-field"><span>{t("admin.newTrackTechnicalId")}</span><input aria-label={t("admin.newTrackTechnicalId")} disabled={readOnly || busy} onChange={(event) => setNewTrackSlug(event.currentTarget.value)} pattern="[a-z][a-z0-9]*(?:-[a-z0-9]+)*" value={newTrackSlug} /></label><button disabled={readOnly || busy || !canAddTrack} onClick={addTrack} type="button">{t("admin.addTrack")}</button></div>
      <ProjectPlanningEditor disabled={readOnly || busy} locale={locale} onChange={(next) => { setDefaults(next); setDefaultsTouched(true); }} planning={defaults} tracks={tracks} />
      <div className="editor-drawer-actions"><button onClick={close} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly || busy}>{t("core.save")}</button></div>
    </form></EditorDrawer>
  </article>;
}
