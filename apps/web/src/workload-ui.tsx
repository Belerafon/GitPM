import { useCallback, useEffect, useMemo, useState } from "react";
import { buildWorkloadReport, isoWeekStart, type PersonWeekWorkload, type TaskWeekAllocation } from "@gitpm/workload";
import type { GitPmApiPort } from "./api.js";
import { formatDateOnly, formatNumber, message, type Locale, type MessageKey } from "./i18n.js";
import type { ConfigurationResult, DraftStatus, EntityResult, GitPmDocument } from "./types.js";
import { AsyncBoundary, useAsyncLoad } from "./async-data.js";
import type { WorkspaceNavigate, WorkspaceSelection } from "./workspace-navigation.js";
import { EntityCatalog } from "./entity-catalog.js";
import { EditorDrawer } from "./editor-drawer.js";
import { ProjectLink } from "./project-link.js";

const DAY_MS = 86_400_000;
const text = (document: GitPmDocument, key: string): string | undefined => typeof document[key] === "string" ? document[key] as string : undefined;
const queryValue = (query: NonNullable<WorkspaceSelection["query"]>, key: string): string => query[key]?.[0] ?? "";
const overloaded = (row: PersonWeekWorkload): boolean => row.capacity_hours === 0 ? row.allocated_hours > 0 : row.allocated_hours > row.capacity_hours;
const availableHours = (row: PersonWeekWorkload): number => Math.max(0, row.capacity_hours - row.allocated_hours);
const todayIso = (now?: string): string => (now ?? new Date().toISOString()).slice(0, 10);
const shiftWeek = (week: string, weeks: number): string => new Date(Date.parse(`${week}T00:00:00.000Z`) + weeks * 7 * DAY_MS).toISOString().slice(0, 10);
const windowEnd = (from: string, weeks: number): string => shiftWeek(from, weeks - 1);

type RowMode = "all" | "work" | "overloaded";
type WorkloadQuery = NonNullable<WorkspaceSelection["query"]>;
const emptyQuery: WorkloadQuery = Object.freeze({});

function transferCandidates(selected: PersonWeekWorkload, allocation: TaskWeekAllocation, rows: readonly PersonWeekWorkload[]): readonly PersonWeekWorkload[] {
  const selectedTime = Date.parse(`${selected.week}T00:00:00.000Z`);
  return rows
    .filter((row) => row.person_id === selected.person_id && row.week !== selected.week && availableHours(row) >= allocation.allocated_hours)
    .sort((left, right) => Math.abs(Date.parse(`${left.week}T00:00:00.000Z`) - selectedTime) - Math.abs(Date.parse(`${right.week}T00:00:00.000Z`) - selectedTime) || left.week.localeCompare(right.week))
    .slice(0, 3);
}

function patchQuery(current: WorkloadQuery, patch: Readonly<Record<string, string | undefined>>): WorkloadQuery {
  const next: Record<string, string[]> = {};
  for (const key of new Set([...Object.keys(current), ...Object.keys(patch)])) {
    const value = key in patch ? patch[key] : current[key]?.[0];
    if (value !== undefined && value !== "") next[key] = [value];
  }
  return next;
}

export function WorkloadWorkspace({ api, draft, locale, query = emptyQuery, now, onNavigate = () => undefined }: { readonly api: GitPmApiPort<"getConfiguration" | "listEntities">; readonly draft: DraftStatus; readonly locale: Locale; readonly query?: WorkloadQuery; readonly now?: string; readonly onNavigate?: WorkspaceNavigate }) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [tasks, setTasks] = useState<readonly EntityResult[]>([]);
  const [people, setPeople] = useState<readonly EntityResult[]>([]);
  const [calendars, setCalendars] = useState<readonly EntityResult[]>([]);
  const [availabilityEvents, setAvailabilityEvents] = useState<readonly EntityResult[]>([]);
  const [projects, setProjects] = useState<readonly EntityResult[]>([]);
  const [teams, setTeams] = useState<readonly EntityResult[]>([]);
  const [milestones, setMilestones] = useState<readonly EntityResult[]>([]);
  const [tracksConfig, setTracksConfig] = useState<ConfigurationResult | null>(null);
  const [selectedCell, setSelectedCell] = useState<{ readonly personId: string; readonly week: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRequest = useAsyncLoad();
  const load = useCallback(async () => {
    await loadRequest.run(async () => {
      const [nextTasks, nextPeople, nextCalendars, nextAvailabilityEvents, nextProjects, nextTeams, nextMilestones, tracksDocument] = await Promise.all([
        api.listEntities(draft.draft_id, "tasks"), api.listEntities(draft.draft_id, "people"), api.listEntities(draft.draft_id, "calendars"), api.listEntities(draft.draft_id, "availability-events"), api.listEntities(draft.draft_id, "projects"), api.listEntities(draft.draft_id, "teams"), api.listEntities(draft.draft_id, "milestones"), api.getConfiguration(draft.draft_id, "schedule-tracks"),
      ]);
      return { nextTasks, nextPeople, nextCalendars, nextAvailabilityEvents, nextProjects, nextTeams, nextMilestones, tracksDocument };
    }, ({ nextTasks, nextPeople, nextCalendars, nextAvailabilityEvents, nextProjects, nextTeams, nextMilestones, tracksDocument }) => {
      setTasks(nextTasks); setPeople(nextPeople); setCalendars(nextCalendars); setAvailabilityEvents(nextAvailabilityEvents); setProjects(nextProjects.filter((item) => item.document.lifecycle === "active")); setTeams(nextTeams.filter((item) => item.document.lifecycle === "active")); setMilestones(nextMilestones.filter((item) => item.document.lifecycle === "active")); setTracksConfig(tracksDocument); setError(null);
    });
  }, [api, draft.draft_id, draft.external_fingerprint, loadRequest.run]);
  useEffect(() => { void load(); }, [load]);

  const currentWeek = isoWeekStart(todayIso(now));
  const [projectFilter, setProjectFilter] = useState(() => queryValue(query, "project"));
  const [milestoneFilter, setMilestoneFilter] = useState(() => queryValue(query, "milestone"));
  const [teamFilter, setTeamFilter] = useState(() => queryValue(query, "team"));
  const [personFilter, setPersonFilter] = useState(() => queryValue(query, "person"));
  const [from, setFrom] = useState(() => queryValue(query, "from") || currentWeek);
  const [weeks, setWeeks] = useState(() => Number(queryValue(query, "weeks") || "8") || 8);
  const [rowsMode, setRowsMode] = useState<RowMode>(() => queryValue(query, "rows") === "work" || queryValue(query, "rows") === "overloaded" ? queryValue(query, "rows") as RowMode : "all");
  useEffect(() => {
    setProjectFilter(queryValue(query, "project"));
    setMilestoneFilter(queryValue(query, "milestone"));
    setTeamFilter(queryValue(query, "team"));
    setPersonFilter(queryValue(query, "person"));
    setFrom(queryValue(query, "from") || isoWeekStart(todayIso(now)));
    setWeeks(Number(queryValue(query, "weeks") || "8") || 8);
    setRowsMode(queryValue(query, "rows") === "work" || queryValue(query, "rows") === "overloaded" ? queryValue(query, "rows") as RowMode : "all");
  }, [query, now]);
  const setFilters = (patch: Readonly<Record<string, string | undefined>>) => {
    if ("project" in patch) setProjectFilter(patch.project ?? "");
    if ("milestone" in patch) setMilestoneFilter(patch.milestone ?? "");
    if ("team" in patch) setTeamFilter(patch.team ?? "");
    if ("person" in patch) setPersonFilter(patch.person ?? "");
    if ("from" in patch) setFrom(patch.from ?? currentWeek);
    if ("weeks" in patch) setWeeks(Number(patch.weeks || "8") || 8);
    if ("rows" in patch) setRowsMode(patch.rows === "work" || patch.rows === "overloaded" ? patch.rows : "all");
    onNavigate("workload", { query: patchQuery({
      ...(projectFilter === "" ? {} : { project: [projectFilter] }),
      ...(milestoneFilter === "" ? {} : { milestone: [milestoneFilter] }),
      ...(teamFilter === "" ? {} : { team: [teamFilter] }),
      ...(personFilter === "" ? {} : { person: [personFilter] }),
      ...(from === currentWeek ? {} : { from: [from] }),
      ...(weeks === 8 ? {} : { weeks: [String(weeks)] }),
      ...(rowsMode === "all" ? {} : { rows: [rowsMode] }),
    }, {
      ...patch,
      ...(patch.from === currentWeek ? { from: undefined } : {}),
      ...(patch.weeks === "8" ? { weeks: undefined } : {}),
      ...(patch.rows === "all" ? { rows: undefined } : {}),
    }) });
  };

  const catalog = useMemo(() => new EntityCatalog({ projects, milestones, people }), [projects, milestones, people]);
  const filterMilestones = milestones.filter((item) => item.document.project === projectFilter);
  const report = useMemo(() => buildWorkloadReport({
    tasks: tasks.map((item) => item.document), projects: projects.map((item) => item.document), people: people.map((item) => item.document), calendars: calendars.map((item) => item.document), availabilityEvents: availabilityEvents.map((item) => item.document), teams: teams.map((item) => item.document),
    scheduleTracks: tracksConfig?.document ?? { schema: "gitpm/schedule-tracks@1", tracks: [], defaults: {} },
    filters: {
      ...(projectFilter === "" ? {} : { project: projectFilter }),
      ...(milestoneFilter === "" ? {} : { milestone: milestoneFilter }),
      ...(teamFilter === "" ? {} : { team: teamFilter }),
      ...(personFilter === "" ? {} : { person: personFilter }),
      from, weeks,
    },
  }), [tasks, projects, people, calendars, availabilityEvents, teams, tracksConfig, projectFilter, milestoneFilter, teamFilter, personFilter, from, weeks]);
  const visibleWeeks = report.weeks;
  const peopleById = useMemo(() => {
    const names = new Map<string, string>();
    for (const row of report.rows) names.set(row.person_id, row.person_name);
    return [...names.entries()];
  }, [report.rows]);
  const rows = new Map(report.rows.map((row) => [`${row.person_id}:${row.week}`, row]));
  const personHasWork = (personId: string): boolean => visibleWeeks.some((week) => (rows.get(`${personId}:${week}`)?.allocated_hours ?? 0) > 0);
  const personOverloaded = (personId: string): boolean => visibleWeeks.some((week) => {
    const value = rows.get(`${personId}:${week}`);
    return value !== undefined && overloaded(value);
  });
  const visiblePeople = peopleById.filter(([personId]) => rowsMode === "work" ? personHasWork(personId) : rowsMode === "overloaded" ? personOverloaded(personId) : true);
  const selectedRow = selectedCell === null ? undefined : rows.get(`${selectedCell.personId}:${selectedCell.week}`);
  const taskById = useMemo(() => new Map(tasks.map((item) => [item.document.id, item])), [tasks]);
  const excluded = Object.values(report.exclusions).reduce((sum, value) => sum + value, 0);
  const withWork = peopleById.filter(([personId]) => personHasWork(personId)).length;
  const overloadedCount = peopleById.filter(([personId]) => personOverloaded(personId)).length;
  const selectedTeam = teams.find((item) => item.document.id === teamFilter);
  const teamName = teamFilter === "" ? undefined : selectedTeam === undefined ? teamFilter : text(selectedTeam.document, "name") ?? teamFilter;
  const personName = personFilter === "" ? undefined : catalog.person(personFilter).name;
  const projectName = projectFilter === "" ? undefined : catalog.project(projectFilter).name;
  const milestoneName = milestoneFilter === "" ? undefined : catalog.milestone(milestoneFilter)?.name;
  const periodIsCurrent = from === currentWeek;
  const chips: { readonly key: string; readonly label: string; readonly clear: Readonly<Record<string, string | undefined>> }[] = [
    ...(personName === undefined ? [] : [{ key: "person", label: personName, clear: { person: undefined } }]),
    ...(teamName === undefined ? [] : [{ key: "team", label: teamName, clear: { team: undefined } }]),
    ...(projectName === undefined ? [] : [{ key: "project", label: projectName, clear: { project: undefined, milestone: undefined } }]),
    ...(milestoneName === undefined ? [] : [{ key: "milestone", label: milestoneName, clear: { milestone: undefined } }]),
    ...(rowsMode === "all" ? [] : [{ key: "rows", label: t(rowsMode === "work" ? "workload.rowsWork" : "workload.rowsOverloaded"), clear: { rows: undefined } }]),
  ];

  return <section className="workload-workspace">
    <div className="section-heading"><span className="eyebrow draft-context-id">{draft.draft_id}</span><h2 aria-hidden="true">{t("workload.heading")}</h2><p>{t("workload.description")}</p></div>
    {error !== null && <div className="alert error">{error}</div>}
    <AsyncBoundary state={loadRequest.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{loadError}<button onClick={retry}>{t("status.retry")}</button></div>}>
    <>
    <section className="card workload-toolbar">
      <fieldset className="workload-filter-group"><legend data-field-hint={t("fieldHint.workloadTeam")}>{t("workload.whoHeading")}</legend>
        <label data-field-hint={t("fieldHint.workloadTeam")}>{t("workload.teamFilter")}<select aria-label={t("workload.teamFilter")} value={teamFilter} onChange={(event) => setFilters({ team: event.target.value === "" ? undefined : event.target.value, person: undefined })}><option value="">{t("workload.allTeams")}</option>{teams.map((item) => <option key={item.document.id} value={item.document.id}>{text(item.document, "name")}</option>)}</select></label>
        <label data-field-hint={t("fieldHint.workloadRows")}>{t("workload.rows")}<select aria-label={t("workload.rows")} value={rowsMode} onChange={(event) => setFilters({ rows: event.target.value === "all" ? undefined : event.target.value })}><option value="all">{t("workload.rowsAll")}</option><option value="work">{t("workload.rowsWork")}</option><option value="overloaded">{t("workload.rowsOverloaded")}</option></select></label>
      </fieldset>
      <fieldset className="workload-filter-group"><legend data-field-hint={t("fieldHint.workloadProject")}>{t("workload.workHeading")}</legend>
        <label data-field-hint={t("fieldHint.workloadProject")}>{t("workload.projectFilter")}<select value={projectFilter} onChange={(event) => setFilters({ project: event.target.value === "" ? undefined : event.target.value, milestone: undefined })}><option value="">{t("workload.allProjects")}</option>{projects.map((item) => <option key={item.document.id} value={item.document.id}>{text(item.document, "name")}</option>)}</select></label>
        <label data-field-hint={t("fieldHint.workloadMilestone")}>{t("core.milestone")}<select aria-label={t("core.milestone")} disabled={projectFilter === ""} value={milestoneFilter} onChange={(event) => setFilters({ milestone: event.target.value === "" ? undefined : event.target.value })}><option value="">{t("core.allMilestones")}</option>{filterMilestones.map((item) => <option key={item.document.id} value={item.document.id}>{text(item.document, "name")}</option>)}</select></label>
      </fieldset>
      <fieldset className="workload-filter-group workload-period-group"><legend data-field-hint={t("fieldHint.workloadPeriod")}>{t("workload.whenHeading")}</legend>
        <label data-field-hint={t("fieldHint.workloadPeriod")}>{t("workload.from")}<input aria-label={t("workload.from")} type="date" value={from} onChange={(event) => { const next = event.target.value === "" ? currentWeek : isoWeekStart(event.target.value); setFilters({ from: next === currentWeek ? undefined : next }); }} /></label>
        <label>{t("workload.period")}<select aria-label={t("workload.period")} value={String(weeks)} onChange={(event) => setFilters({ weeks: event.target.value === "8" ? undefined : event.target.value })}><option value="4">{periodIsCurrent ? t("workload.weeks4") : t("workload.weeksCount", { count: 4 })}</option><option value="8">{periodIsCurrent ? t("workload.weeks8") : t("workload.weeksCount", { count: 8 })}</option><option value="12">{periodIsCurrent ? t("workload.weeks12") : t("workload.weeksCount", { count: 12 })}</option></select></label>
        <div className="workload-period-actions"><button onClick={() => setFilters({ from: shiftWeek(from, -weeks) })} type="button">{t("workload.previousPeriod")}</button><button onClick={() => setFilters({ from: undefined })} type="button">{t("workload.today")}</button><button onClick={() => setFilters({ from: shiftWeek(from, weeks) })} type="button">{t("workload.nextPeriod")}</button></div>
      </fieldset>
    </section>
    <p className="workload-context">{t("workload.context", { people: visiblePeople.length, team: teamName ?? t("workload.allTeams"), work: projectName === undefined ? t("workload.allProjects") : milestoneName === undefined ? projectName : t("workload.projectStage", { project: projectName, stage: milestoneName }), start: formatDateOnly(locale, from), end: formatDateOnly(locale, windowEnd(from, weeks)) })}</p>
    {chips.length > 0 && <div className="workload-chips">{chips.map((chip) => <button key={chip.key} className="workload-chip" onClick={() => setFilters(chip.clear)} type="button">{chip.label}<span aria-hidden="true">×</span></button>)}<button className="text-link" onClick={() => { setProjectFilter(""); setMilestoneFilter(""); setTeamFilter(""); setPersonFilter(""); setFrom(currentWeek); setWeeks(8); setRowsMode("all"); onNavigate("workload", { query: {} }); }} type="button">{t("workload.reset")}</button></div>}
    <section className="card workload-summary">
      <div><span>{t("workload.shownPeople")}</span><strong>{t("workload.shownOfScoped", { shown: visiblePeople.length, scoped: report.person_census.scoped, total: report.person_census.total_active })}</strong></div>
      <div><span>{t("workload.withWork")}</span><strong>{withWork}</strong></div>
      <div><span>{t("workload.overloadedPeople")}</span><strong>{overloadedCount}</strong></div>
      <div><span>{t("workload.withoutCalendar")}</span><strong>{report.person_census.without_calendar.length}</strong></div>
    </section>
    {report.person_census.without_calendar.length > 0 && <div className="alert warning">{t("workload.missingCalendar", { count: report.person_census.without_calendar.length })} {report.person_census.without_calendar.map((person) => <button className="text-link" key={person.person_id} onClick={() => onNavigate("people", { personId: person.person_id })} type="button">{person.person_name}</button>)}</div>}
    <div className="workload-legend" aria-label={t("workload.heading")}><span className="available">{t("workload.legendLow")}</span><span className="balanced">{t("workload.legendBalanced")}</span><span className="near">{t("workload.legendNear")}</span><span className="overloaded">{t("workload.legendOver")}</span></div>
    {visibleWeeks.length === 0 || visiblePeople.length === 0 ? <section className="card empty-workspace">{t(report.person_census.scoped === 0 ? "workload.emptyPeople" : "workload.empty")}</section> : <section className="card workload-table-wrap">
      <table className="workload-table"><thead><tr><th>{t("workload.person")}</th>{visibleWeeks.map((week) => <th key={week}><time dateTime={week}>{t("workload.week", { date: formatDateOnly(locale, week) })}</time></th>)}</tr></thead>
        <tbody>{visiblePeople.map(([personId, personName]) => <tr key={personId}><th><button className="text-link" onClick={() => onNavigate("people", { personId })}>{personName}</button></th>{visibleWeeks.map((week) => {
          const value = rows.get(`${personId}:${week}`)!; const tone = overloaded(value) ? "overloaded" : value.utilization_percent === null ? "unavailable" : value.utilization_percent >= 80 ? "near" : value.utilization_percent >= 40 ? "balanced" : "available";
          const content = <><strong>{t("workload.hours", { allocated: formatNumber(locale, value.allocated_hours), capacity: formatNumber(locale, value.capacity_hours) })}</strong><span>{value.utilization_percent === null ? t("workload.noCapacity") : t("workload.utilization", { percent: formatNumber(locale, value.utilization_percent) })}</span>{value.task_allocations.length > 0 && <span className="workload-cell-action">{t("workload.inspect")}</span>}</>;
          return <td className={tone} data-person-id={personId} data-week={week} key={week} title={t("workload.tasks", { count: value.task_ids.length })}>{value.task_allocations.length === 0 ? <div className="workload-cell-content">{content}</div> : <button aria-label={t("workload.openBreakdown", { person: personName, date: formatDateOnly(locale, week) })} className="workload-cell-button" onClick={() => setSelectedCell({ personId, week })} type="button">{content}</button>}</td>;
        })}</tr>)}</tbody></table>
    </section>}
    <details className="card workload-quality">
      <summary>{t("workload.quality", { included: report.included_tasks, total: report.included_tasks + excluded })}</summary>
      <p>{t("workload.formula")}</p>
      <p>{t("workload.capacityFormula")}</p>
      <dl>
        <div><dt>{t("workload.archived")}</dt><dd>{report.exclusions.archived}</dd></div><div><dt>{t("workload.undated")}</dt><dd>{report.exclusions.undated}</dd></div><div><dt>{t("workload.unestimated")}</dt><dd>{report.exclusions.unestimated}</dd></div><div><dt>{t("workload.unassigned")}</dt><dd>{report.exclusions.unassigned}</dd></div><div><dt>{t("workload.unavailable")}</dt><dd>{report.exclusions.unavailable_assignees}</dd></div>
      </dl>
    </details>
    </>
    </AsyncBoundary>
    <EditorDrawer closeLabel={t("workload.closeBreakdown")} onClose={() => setSelectedCell(null)} open={selectedRow !== undefined} title={selectedRow === undefined ? "" : t("workload.breakdownTitle", { person: selectedRow.person_name, date: formatDateOnly(locale, selectedRow.week) })}>
      {selectedRow !== undefined && <section className="workload-breakdown">
        <dl className="workload-breakdown-summary">
          <div><dt>{t("workload.allocation")}</dt><dd>{t("workload.hours", { allocated: formatNumber(locale, selectedRow.allocated_hours), capacity: formatNumber(locale, selectedRow.capacity_hours) })}</dd></div>
          <div><dt>{t("workload.availabilityLoss")}</dt><dd>{t("workload.capacityLoss", { unavailable: formatNumber(locale, selectedRow.unavailable_hours), base: formatNumber(locale, selectedRow.base_capacity_hours) })}</dd></div>
          <div><dt>{overloaded(selectedRow) ? t("workload.overload") : t("workload.spareCapacity")}</dt><dd>{t("workload.hoursOnly", { hours: formatNumber(locale, overloaded(selectedRow) ? selectedRow.allocated_hours - selectedRow.capacity_hours : availableHours(selectedRow)) })}</dd></div>
        </dl>
        <p className="workload-transfer-hint">{t("workload.transferHint")}</p>
        <h3>{t("workload.contributors", { count: selectedRow.task_allocations.length })}</h3>
        <div className="workload-contributors">{selectedRow.task_allocations.map((allocation) => {
          const task = taskById.get(allocation.task_id);
          const title = task === undefined ? allocation.task_id : text(task.document, "title") ?? allocation.task_id;
          const projectId = task === undefined ? undefined : text(task.document, "project");
          const candidates = transferCandidates(selectedRow, allocation, report.rows);
          return <article className="workload-contribution" key={allocation.task_id}>
            <header><div><button className="text-link" disabled={projectId === undefined} onClick={() => { if (projectId !== undefined) { setSelectedCell(null); onNavigate("tasks", { projectId, taskId: allocation.task_id }); } }} type="button">{title}</button><p><code>{allocation.task_id}</code>{projectId !== undefined && <> · <ProjectLink name={catalog.project(projectId).name} onOpen={(nextProjectId) => { setSelectedCell(null); onNavigate("projects", { projectId: nextProjectId }); }} projectId={projectId} /></>}</p></div><strong>{t("workload.contributionHours", { hours: formatNumber(locale, allocation.allocated_hours) })}</strong></header>
            <h4>{t("workload.transferHeading")}</h4>
            {candidates.length === 0 ? <p className="workload-no-transfer">{t("workload.noTransferWeeks")}</p> : <ul>{candidates.map((candidate) => <li key={candidate.week}><time dateTime={candidate.week}>{t("workload.transferWeek", { date: formatDateOnly(locale, candidate.week), hours: formatNumber(locale, availableHours(candidate)) })}</time></li>)}</ul>}
          </article>;
        })}</div>
      </section>}
    </EditorDrawer>
  </section>;
}
