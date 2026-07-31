import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { CALENDAR_PRESETS, calendarPreset, workingDatesBetween, type CalendarPresetId } from "@gitpm/calendar";
import { ENTITY_ID_PREFIX, newUniqueEntityId } from "@gitpm/shared";
import type { GitPmApi } from "./api.js";
import { formatDateOnly, message, type Locale, type MessageKey } from "./i18n.js";
import type { ConfigurationResult, DraftStatus, EntityResult, GitPmDocument, GitPmRole } from "./types.js";
import { AsyncBoundary, useAsyncLoad } from "./async-data.js";
import { EditorDrawer } from "./editor-drawer.js";
import { useExternalHighlights, useReducedMotion } from "./external-updates.js";
import { upsertEntity, useFlipList } from "./optimistic-ui.js";
import { PersonLink, PersonLinks } from "./person-link.js";
import { ProjectLinks } from "./project-link.js";
import { draftReadOnlyReason } from "./draft-read-only.js";

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

export function AdminWorkspace({ api, draft, role, locale, surface, confirmAction = () => true, onOpenPerson, onOpenProject, onChanged }: { readonly api: GitPmApi; readonly draft: DraftStatus; readonly role: GitPmRole; readonly locale: Locale; readonly surface: AdminSurface; readonly confirmAction?: (message: string) => boolean; readonly onOpenPerson?: (personId: string) => void; readonly onOpenProject?: (projectId: string) => void; readonly onChanged: () => Promise<void> }) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [calendars, setCalendars] = useState<readonly EntityResult[]>([]);
  const [people, setPeople] = useState<readonly EntityResult[]>([]);
  const [teams, setTeams] = useState<readonly EntityResult[]>([]);
  const [projects, setProjects] = useState<readonly EntityResult[]>([]);
  const [tasks, setTasks] = useState<readonly EntityResult[]>([]);
  const [statuses, setStatuses] = useState<ConfigurationResult | null>(null);
  const [issueTypes, setIssueTypes] = useState<ConfigurationResult | null>(null);
  const [workCategories, setWorkCategories] = useState<ConfigurationResult | null>(null);
  const [fingerprint, setFingerprint] = useState(draft.fingerprint);
  const [error, setError] = useState<string | null>(null);
  const [peopleQuery, setPeopleQuery] = useState("");
  const [teamQuery, setTeamQuery] = useState("");
  const [createEditor, setCreateEditor] = useState<AdminCreateEditor>(null);
  const { highlights, mark } = useExternalHighlights(500);
  const loadRequest = useAsyncLoad();
  const readOnly = role !== "Maintainer" || draftReadOnlyReason(draft) !== null;

  const load = useCallback(async () => {
    await loadRequest.run(async () => {
      const [nextCalendars, nextPeople, nextTeams, nextProjects, nextTasks, nextStatuses, nextIssueTypes, nextWorkCategories] = await Promise.all([
        api.listEntities(draft.draft_id, "calendars"), api.listEntities(draft.draft_id, "people"), api.listEntities(draft.draft_id, "teams"), api.listEntities(draft.draft_id, "projects"), api.listEntities(draft.draft_id, "tasks"), api.getConfiguration(draft.draft_id, "statuses"), api.getConfiguration(draft.draft_id, "issue-types"), api.getConfiguration(draft.draft_id, "work-categories"),
      ]);
      return { nextCalendars, nextPeople, nextTeams, nextProjects, nextTasks, nextStatuses, nextIssueTypes, nextWorkCategories };
    }, ({ nextCalendars, nextPeople, nextTeams, nextProjects, nextTasks, nextStatuses, nextIssueTypes, nextWorkCategories }) => {
      setCalendars(nextCalendars); setPeople(nextPeople); setTeams(nextTeams); setProjects(nextProjects); setTasks(nextTasks); setStatuses(nextStatuses); setIssueTypes(nextIssueTypes); setWorkCategories(nextWorkCategories);
      setFingerprint(nextCalendars[0]?.draft_fingerprint ?? nextPeople[0]?.draft_fingerprint ?? nextTeams[0]?.draft_fingerprint ?? nextProjects[0]?.draft_fingerprint ?? nextTasks[0]?.draft_fingerprint ?? nextStatuses.draft_fingerprint);
    });
  }, [api, draft.draft_id, draft.external_fingerprint, loadRequest.run]);
  useEffect(() => { void load(); }, [load]);

  const mutate = async <Result extends EntityResult | ConfigurationResult>(operation: () => Promise<Result>): Promise<Result | null> => { setError(null); try {
    const result = await operation(); setFingerprint(result.draft_fingerprint);
    if (result.document.schema === "gitpm/calendar@1") setCalendars((current) => upsertEntity(current, result as EntityResult));
    if (result.document.schema === "gitpm/person@1") setPeople((current) => upsertEntity(current, result as EntityResult));
    if (result.document.schema === "gitpm/team@1") setTeams((current) => upsertEntity(current, result as EntityResult));
    if (result.document.schema === "gitpm/statuses@2") setStatuses(result as ConfigurationResult);
    if (result.document.schema === "gitpm/issue-types@1") setIssueTypes(result as ConfigurationResult);
    if (result.document.schema === "gitpm/work-categories@1") setWorkCategories(result as ConfigurationResult);
    if ("id" in result.document && typeof result.document.id === "string") mark({ [result.document.id]: ["$local"] }); await onChanged(); await load(); return result;
  } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return null; } };
  const remove = async (operation: () => Promise<void>) => { setError(null); try { await operation(); await load(); await onChanged(); return true; } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return false; } };
  const activeCalendars = calendars.filter((item) => item.document.lifecycle === "active");
  const activePeople = people.filter((item) => item.document.lifecycle === "active");
  const visiblePeople = activePeople.filter((item) => `${text(item.document, "name")} ${text(item.document, "email")}`.toLocaleLowerCase(locale).includes(peopleQuery.trim().toLocaleLowerCase(locale)));
  const activeTeams = teams.filter((item) => item.document.lifecycle === "active");
  const peopleNames = new Map(activePeople.map((item) => [item.document.id, text(item.document, "name")]));
  const visibleTeams = activeTeams.filter((item) => `${text(item.document, "name")} ${strings(item.document, "members").map((id) => peopleNames.get(id) ?? "").join(" ")}`.toLocaleLowerCase(locale).includes(teamQuery.trim().toLocaleLowerCase(locale)));
  const teamsByPerson = new Map(activePeople.map((person) => [person.document.id, activeTeams.filter((team) => strings(team.document, "members").includes(person.document.id))]));
  const activeProjects = projects.filter((item) => item.document.lifecycle === "active");
  const activeTasks = tasks.filter((item) => item.document.lifecycle === "active");
  const projectsByPerson = new Map(activePeople.map((person) => {
    const ids = new Set<string>();
    for (const project of activeProjects) if (text(project.document, "owner") === person.document.id) ids.add(project.document.id);
    for (const task of activeTasks) if (strings(task.document, "assignees").includes(person.document.id)) ids.add(text(task.document, "project"));
    return [person.document.id, activeProjects.filter((project) => ids.has(project.document.id)).sort((left, right) => text(left.document, "name").localeCompare(text(right.document, "name"), locale))];
  }));
  const confirmDelete = (name: string) => confirmAction(t("core.deleteConfirm", { name }));
  const surfaceHeading: MessageKey = surface === "people" ? "nav.people" : surface === "calendar" ? "nav.calendar" : "nav.settings";

  const createCalendar = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); const document = { schema: "gitpm/calendar@1", id: newUniqueEntityId(ENTITY_ID_PREFIX.calendar, new Set(calendars.map((item) => item.document.id))), name: String(data.get("name")), working_weekdays: data.getAll("weekdays").map(Number), holidays: calendarDates(data), lifecycle: "active" } as GitPmDocument; void mutate(async () => await api.createEntity(draft.draft_id, "calendars", fingerprint, document)).then((result) => { if (result !== null) setCreateEditor(null); }); };
  const createPerson = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); const email = String(data.get("email") ?? ""); const calendar = String(data.get("calendar") ?? ""); const document = { schema: "gitpm/person@1", id: newUniqueEntityId(ENTITY_ID_PREFIX.person, new Set(people.map((item) => item.document.id))), name: String(data.get("name")), weekly_capacity_hours: Number(data.get("capacity")), lifecycle: "active", ...(calendar ? { calendar } : {}), ...(email ? { email } : {}) } as GitPmDocument; void mutate(async () => await api.createEntity(draft.draft_id, "people", fingerprint, document)).then((result) => { if (result !== null) setCreateEditor(null); }); };
  const createTeam = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); const document = { schema: "gitpm/team@1", id: newUniqueEntityId(ENTITY_ID_PREFIX.team, new Set(teams.map((item) => item.document.id))), name: String(data.get("name")), members: data.getAll("members").map(String), lifecycle: "active" } as GitPmDocument; void mutate(async () => await api.createEntity(draft.draft_id, "teams", fingerprint, document)).then((result) => { if (result !== null) setCreateEditor(null); }); };

  return <section className="admin-workspace"><div className="section-heading"><span className="eyebrow draft-context-id">{draft.draft_id}</span><h2 aria-hidden="true">{t(surfaceHeading)}</h2></div>
    {role !== "Maintainer" && <div className="alert warning">{t("admin.maintainerOnly")}</div>}{error !== null && <div className="alert error">{error}</div>}
    <AsyncBoundary state={loadRequest.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{loadError}<button onClick={retry}>{t("status.retry")}</button></div>}>
    <>
    {surface === "calendar" && <section className="card"><button className="primary editor-trigger" disabled={readOnly} onClick={() => setCreateEditor("calendar")} type="button">+ {t("admin.createCalendar")}</button><EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setCreateEditor(null)} open={createEditor === "calendar"} title={t("admin.createCalendar")}><CalendarCreateForm disabled={readOnly} onCancel={() => setCreateEditor(null)} onSubmit={createCalendar} t={t} /></EditorDrawer><div className="admin-grid">{activeCalendars.map((entity) => <div className={highlights[entity.document.id] ? "recently-changed" : ""} key={entity.document.id}><CalendarEditor {...{ api, draft, entity, fingerprint, readOnly, t, locale, mutate, remove, confirmDelete }} /></div>)}</div></section>}
    {surface === "people" && <div className="people-admin-sections"><section className="card directory-card"><div className="card-heading"><h3>{t("admin.people")}</h3><label className="search-field">{t("admin.peopleSearch")}<input type="search" value={peopleQuery} onChange={(event) => setPeopleQuery(event.target.value)} /></label></div><button className="primary editor-trigger" disabled={readOnly || activeCalendars.length === 0} onClick={() => setCreateEditor("person")} type="button">+ {t("admin.createPerson")}</button><EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setCreateEditor(null)} open={createEditor === "person"} title={t("admin.createPerson")}><form className="editor-drawer-form" onSubmit={createPerson}><label>{t("core.name")}<input name="name" required /></label><label>{t("admin.email")}<input name="email" type="email" /></label><label>{t("admin.capacity")}<input name="capacity" type="number" min="0" step="0.25" defaultValue="40" required /></label><label>{t("admin.calendar")}<select name="calendar"><option value="">{t("admin.defaultCalendar")}</option>{activeCalendars.map((item) => <option value={item.document.id} key={item.document.id}>{text(item.document, "name")}</option>)}</select></label><div className="editor-drawer-actions"><button onClick={() => setCreateEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly || activeCalendars.length === 0}>{t("admin.createPerson")}</button></div></form></EditorDrawer><div className="directory-table-wrap"><table className="directory-table people-directory-table"><thead><tr><th>{t("admin.person")}</th><th>{t("people.projects")}</th><th>{t("admin.teams")}</th><th>{t("admin.capacity")}</th><th>{t("admin.calendar")}</th></tr></thead><tbody>{visiblePeople.map((entity) => { const calendar = activeCalendars.find((item) => item.document.id === text(entity.document, "calendar")); const personTeams = teamsByPerson.get(entity.document.id) ?? []; return <tr className={highlights[entity.document.id] ? "recently-changed" : ""} key={entity.document.id}><th><PersonLink name={text(entity.document, "name")} onOpen={onOpenPerson} personId={entity.document.id} /></th><td><ProjectLinks empty="—" onOpen={onOpenProject} projectIds={(projectsByPerson.get(entity.document.id) ?? []).map((project) => project.document.id)} projects={activeProjects} /></td><td>{personTeams.length === 0 ? "—" : personTeams.map((team) => text(team.document, "name")).join(", ")}</td><td>{t("people.hoursPerWeek", { count: number(entity.document, "weekly_capacity_hours") })}</td><td>{calendar === undefined ? "—" : text(calendar.document, "name")}</td></tr>; })}</tbody></table></div></section>
      <section className="card directory-card"><div className="card-heading"><h3>{t("admin.teams")}</h3><label className="search-field">{t("admin.teamSearch")}<input type="search" value={teamQuery} onChange={(event) => setTeamQuery(event.target.value)} /></label></div><button className="primary editor-trigger" disabled={readOnly} onClick={() => setCreateEditor("team")} type="button">+ {t("admin.createTeam")}</button><EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setCreateEditor(null)} open={createEditor === "team"} title={t("admin.createTeam")}><form className="editor-drawer-form" onSubmit={createTeam}><label>{t("core.name")}<input name="name" required /></label><MemberChecks people={activePeople} selected={[]} t={t} /><div className="editor-drawer-actions"><button onClick={() => setCreateEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("admin.createTeam")}</button></div></form></EditorDrawer><div className="directory-table-wrap"><table className="directory-table team-directory-table"><thead><tr><th>{t("admin.team")}</th><th>{t("admin.members")}</th><th>{t("admin.actions")}</th></tr></thead><tbody>{visibleTeams.map((entity) => <tr className={highlights[entity.document.id] ? "recently-changed" : ""} key={entity.document.id}><TeamEditor {...{ api, draft, entity, fingerprint, readOnly, t, people: activePeople, mutate, remove, confirmDelete, onOpenPerson }} /></tr>)}</tbody></table></div></section></div>}
    {surface === "settings" && <section aria-label={t("admin.settings")} className="settings-config-grid">{statuses !== null && <ConfigEditor api={api} draft={draft} entity={statuses} kind="statuses" listKey="statuses" title={t("admin.statuses")} readOnly={readOnly} t={t} mutate={mutate} />}{issueTypes !== null && <ConfigEditor api={api} draft={draft} entity={issueTypes} kind="issue-types" listKey="issue_types" title={t("admin.issueTypes")} readOnly={readOnly} t={t} mutate={mutate} />}{workCategories !== null && <ConfigEditor api={api} draft={draft} entity={workCategories} kind="work-categories" listKey="categories" title={t("admin.workCategories")} showColor={false} readOnly={readOnly} t={t} mutate={mutate} />}</section>}
    </>
    </AsyncBoundary>
  </section>;
}

interface EditorProps { readonly api: GitPmApi; readonly draft: DraftStatus; readonly entity: EntityResult; readonly fingerprint: string; readonly readOnly: boolean; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string; readonly mutate: (operation: () => Promise<EntityResult>) => Promise<EntityResult | null>; readonly remove: (operation: () => Promise<void>) => Promise<boolean>; readonly confirmDelete: (name: string) => boolean }
const ActionButtons = ({ disabled, save, archive, remove, close, t }: { disabled: boolean; save: (form: HTMLFormElement) => Promise<boolean>; archive: () => Promise<boolean>; remove: () => Promise<boolean>; close: () => void; t: (key: MessageKey) => string }) => <div className="editor-drawer-actions"><details className="more-actions"><summary>{t("core.moreActions")}</summary><div><button type="button" disabled={disabled} onClick={() => { void archive().then((success) => { if (success) close(); }); }}>{t("core.archive")}</button><button type="button" className="danger" disabled={disabled} onClick={() => { void remove().then((success) => { if (success) close(); }); }}>{t("core.delete")}</button></div></details><button onClick={close} type="button">{t("core.cancel")}</button><button type="button" className="primary" disabled={disabled} onClick={(event) => { if (event.currentTarget.form !== null) void save(event.currentTarget.form).then((success) => { if (success) close(); }); }}>{t("core.save")}</button></div>;

function CalendarEditor(props: EditorProps & { readonly locale: Locale }) {
  const { api, draft, entity, fingerprint, readOnly, t, locale, mutate, remove, confirmDelete } = props;
  const [open, setOpen] = useState(false);
  const name = text(entity.document, "name");
  const weekdays = numbers(entity.document, "working_weekdays");
  const holidays = strings(entity.document, "holidays").filter((date) => /^\d{4}-\d{2}-\d{2}$/u.test(date)).sort().slice(0, 3);
  const submit = async (form: HTMLFormElement) => { const data = new FormData(form); return await mutate(async () => await api.updateEntity(draft.draft_id, "calendars", entity, fingerprint, { ...entity.document, name: String(data.get("name")), working_weekdays: data.getAll("weekdays").map(Number), holidays: calendarDates(data) })) !== null; };
  return <article className="admin-card admin-card-summary"><strong>{name}</strong><div aria-label={t("admin.weekPreview")} className="calendar-week-preview">{[1, 2, 3, 4, 5, 6, 7].map((day) => <span className={weekdays.includes(day) ? "working" : "off"} key={day}>{t(`admin.day${day}` as MessageKey)}</span>)}</div><div className="calendar-exceptions"><span>{t("admin.nextHolidays")}</span>{holidays.length === 0 ? <small>{t("admin.noHolidays")}</small> : holidays.map((date) => <time dateTime={date} key={date}>{formatDateOnly(locale, date)}</time>)}</div><button className="editor-trigger" onClick={() => setOpen(true)} type="button">{t("admin.editCalendar")}</button><EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setOpen(false)} open={open} title={`${t("admin.editCalendar")}: ${name}`}><form className="editor-drawer-form" onSubmit={(event) => event.preventDefault()}><label>{t("core.name")}<input name="name" aria-label={`${t("core.name")} ${name}`} defaultValue={name} /></label><WeekdayChecks selected={weekdays} t={t} /><CalendarDateList selected={strings(entity.document, "holidays")} t={t} /><ActionButtons disabled={readOnly} t={t} close={() => setOpen(false)} save={submit} archive={async () => await mutate(async () => await api.archiveEntity(draft.draft_id, "calendars", entity, fingerprint)) !== null} remove={async () => confirmDelete(name) && await remove(async () => await api.deleteEntity(draft.draft_id, "calendars", entity, fingerprint))} /></form></EditorDrawer></article>;
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
  const update = async (form: HTMLFormElement) => { const data = new FormData(form); return await mutate(async () => await api.updateEntity(draft.draft_id, "teams", entity, fingerprint, { ...entity.document, name: String(data.get("name")), members: data.getAll("members").map(String) })) !== null; };
  return <><th>{name}</th><td><PersonLinks empty={t("admin.noMembers")} onOpen={onOpenPerson} people={people} personIds={selected} /></td><td><button className="editor-trigger" onClick={() => setOpen(true)} type="button">{t("admin.editTeam")}</button><EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setOpen(false)} open={open} title={`${t("admin.editTeam")}: ${name}`}><form className="editor-drawer-form" onSubmit={(event) => event.preventDefault()}><label>{t("core.name")}<input name="name" aria-label={`${t("core.name")} ${name}`} defaultValue={name} /></label><MemberChecks people={people} selected={selected} t={t} /><ActionButtons disabled={readOnly} t={t} close={() => setOpen(false)} save={update} archive={async () => await mutate(async () => await api.archiveEntity(draft.draft_id, "teams", entity, fingerprint)) !== null} remove={async () => confirmDelete(name) && await remove(async () => await api.deleteEntity(draft.draft_id, "teams", entity, fingerprint))} /></form></EditorDrawer></td></>;
}

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
function ConfigEditor({ api, draft, entity, kind, listKey, title, showColor = true, readOnly, t, mutate }: { readonly api: GitPmApi; readonly draft: DraftStatus; readonly entity: ConfigurationResult; readonly kind: "statuses" | "issue-types" | "work-categories"; readonly listKey: "statuses" | "issue_types" | "categories"; readonly title: string; readonly showColor?: boolean; readonly readOnly: boolean; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string; readonly mutate: <Result extends EntityResult | ConfigurationResult>(operation: () => Promise<Result>) => Promise<Result | null> }) {
  const [open, setOpen] = useState(false);
  const entityValues = Array.isArray(entity.document[listKey]) ? entity.document[listKey] as ConfigValue[] : [];
  const [values, setValues] = useState(entityValues);
  const [busy, setBusy] = useState(false);
  const [savingRows, setSavingRows] = useState<ReadonlySet<string>>(new Set());
  const { highlights: recentRows, mark: markRows } = useExternalHighlights(500);
  const formRef = useFlipList<HTMLFormElement>(useReducedMotion());
  useEffect(() => setValues(entityValues), [entity]);
  const updateValue = (index: number, changes: Partial<Pick<ConfigValue, "title" | "color" | "active" | "category">>) => setValues((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item));
  const persist = async (next: readonly ConfigValue[], onPersisted?: () => void) => {
    const previous = values; setValues([...next]); setBusy(true);
    const result = await mutate(async () => { const saved = await api.updateConfiguration(draft.draft_id, kind, entity, entity.draft_fingerprint, { ...entity.document, [listKey]: next }); setBusy(false); onPersisted?.(); return saved; });
    if (result === null) setValues(previous);
    setBusy(false); return result;
  };
  const close = () => { setValues(entityValues); setOpen(false); };
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void persist(values).then((result) => { if (result !== null) setOpen(false); }); };
  const move = (index: number, offset: number) => { const next = [...values]; const target = index + offset; if (target < 0 || target >= next.length) return; const first = next[index]!; const second = next[target]!; [next[index], next[target]] = [second, first]; const rows = { [first.slug]: ["order"], [second.slug]: ["order"] }; setSavingRows(new Set([first.slug, second.slug])); void persist(next, () => { setSavingRows(new Set()); markRows(rows); }).finally(() => setSavingRows(new Set())); };
  return <article className="config-editor config-summary">
    <header className="config-summary-heading"><h3>{title}</h3><button className="editor-trigger" aria-label={t("admin.editConfig", { name: title })} disabled={readOnly} onClick={() => { setValues(entityValues); setOpen(true); }} type="button">{t("core.edit")}</button></header>
    <div className="config-summary-values">{values.map((item) => <ConfigBadge inactiveLabel={t("admin.inactive")} item={item} key={item.slug} />)}</div>
    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={close} open={open} title={`${t("core.edit")}: ${title}`}><form className="editor-drawer-form config-editor-form" onSubmit={submit} ref={formRef}>
      <p className="config-hint">{t("admin.slugHint")}</p>
      <div className="config-list">{values.map((item, index) => <section className={`config-row${recentRows[item.slug] ? " recently-changed" : ""}${savingRows.has(item.slug) ? " is-saving" : ""}`} data-flip-key={`config:${kind}:${item.slug}`} key={item.slug}>
        <header className="config-row-heading">
          <div className="config-identity"><ConfigBadge inactiveLabel={t("admin.inactive")} item={item} /><span className="config-technical-id"><span>{t("admin.technicalId")}</span><code>{item.slug}</code></span></div>
          <label className="config-active-switch"><input aria-label={t("admin.activeLabel", { name: item.title })} checked={item.active} disabled={readOnly || busy} name={`active-${index}`} onChange={(event) => updateValue(index, { active: event.currentTarget.checked })} role="switch" type="checkbox" /><span aria-hidden="true" className="config-switch-track" /><span>{t("admin.active")}</span></label>
        </header>
        <div className="config-row-fields">
           <label className="config-field"><span>{t("core.name")}</span><input aria-label={`${title} ${item.slug}`} disabled={readOnly || busy} name={`title-${index}`} onChange={(event) => updateValue(index, { title: event.currentTarget.value })} required value={item.title} /></label>
           {showColor && <ConfigColorPalette disabled={readOnly || busy} item={item} onChange={(color) => updateValue(index, { color })} t={t} />}
           {kind === "statuses" && <label className="config-field"><span>{t("admin.statusCategory")}</span><select aria-label={`${t("admin.statusCategory")} ${item.slug}`} disabled={readOnly || busy} onChange={(event) => updateValue(index, { category: event.currentTarget.value as ConfigValue["category"] })} value={item.category ?? "backlog"}><option value="backlog">{t("admin.categoryBacklog")}</option><option value="active">{t("admin.categoryActive")}</option><option value="done">{t("admin.categoryDone")}</option><option value="cancelled">{t("admin.categoryCancelled")}</option></select></label>}
        </div>
        <footer className="config-row-footer"><span>{t("admin.orderPosition", { position: index + 1, count: values.length })}</span><div className="config-order"><button aria-label={t("admin.moveUp", { name: item.title })} disabled={readOnly || busy || index === 0} onClick={() => move(index, -1)} type="button"><span aria-hidden="true">↑</span>{t("admin.higher")}</button><button aria-label={t("admin.moveDown", { name: item.title })} disabled={readOnly || busy || index === values.length - 1} onClick={() => move(index, 1)} type="button"><span aria-hidden="true">↓</span>{t("admin.lower")}</button></div></footer>
      </section>)}</div>
      <div className="editor-drawer-actions"><button onClick={close} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly || busy}>{t("core.save")}</button></div>
    </form></EditorDrawer>
  </article>;
}
