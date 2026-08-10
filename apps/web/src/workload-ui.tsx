import { useCallback, useEffect, useMemo, useState } from "react";
import { buildWorkloadReport, type PersonWeekWorkload, type TaskWeekAllocation } from "@gitpm/workload";
import type { GitPmApi } from "./api.js";
import { formatDateOnly, formatNumber, message, type Locale, type MessageKey } from "./i18n.js";
import type { ConfigurationResult, DraftStatus, EntityResult, GitPmDocument } from "./types.js";
import { AsyncBoundary, useAsyncLoad } from "./async-data.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";
import { EntityCatalog } from "./entity-catalog.js";
import { EditorDrawer } from "./editor-drawer.js";
import { ProjectLink } from "./project-link.js";

const text = (document: GitPmDocument, key: string): string | undefined => typeof document[key] === "string" ? document[key] as string : undefined;

const overloaded = (row: PersonWeekWorkload): boolean => row.capacity_hours === 0 ? row.allocated_hours > 0 : row.allocated_hours > row.capacity_hours;
const availableHours = (row: PersonWeekWorkload): number => Math.max(0, row.capacity_hours - row.allocated_hours);

function transferCandidates(selected: PersonWeekWorkload, allocation: TaskWeekAllocation, rows: readonly PersonWeekWorkload[]): readonly PersonWeekWorkload[] {
  const selectedTime = Date.parse(`${selected.week}T00:00:00.000Z`);
  return rows
    .filter((row) => row.person_id === selected.person_id && row.week !== selected.week && availableHours(row) >= allocation.allocated_hours)
    .sort((left, right) => Math.abs(Date.parse(`${left.week}T00:00:00.000Z`) - selectedTime) - Math.abs(Date.parse(`${right.week}T00:00:00.000Z`) - selectedTime) || left.week.localeCompare(right.week))
    .slice(0, 3);
}

export function WorkloadWorkspace({ api, draft, locale, onNavigate = () => undefined }: { readonly api: GitPmApi; readonly draft: DraftStatus; readonly locale: Locale; readonly onNavigate?: WorkspaceNavigate }) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [tasks, setTasks] = useState<readonly EntityResult[]>([]);
  const [people, setPeople] = useState<readonly EntityResult[]>([]);
  const [calendars, setCalendars] = useState<readonly EntityResult[]>([]);
  const [projects, setProjects] = useState<readonly EntityResult[]>([]);
  const [teams, setTeams] = useState<readonly EntityResult[]>([]);
  const [milestones, setMilestones] = useState<readonly EntityResult[]>([]);
  const [tracksConfig, setTracksConfig] = useState<ConfigurationResult | null>(null);
  const [projectFilter, setProjectFilter] = useState("");
  const [milestoneFilter, setMilestoneFilter] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  const [period, setPeriod] = useState("8");
  const [selectedCell, setSelectedCell] = useState<{ readonly personId: string; readonly week: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRequest = useAsyncLoad();
  const load = useCallback(async () => {
    await loadRequest.run(async () => {
      const [nextTasks, nextPeople, nextCalendars, nextProjects, nextTeams, nextMilestones, tracksDocument] = await Promise.all([
        api.listEntities(draft.draft_id, "tasks"), api.listEntities(draft.draft_id, "people"), api.listEntities(draft.draft_id, "calendars"), api.listEntities(draft.draft_id, "projects"), api.listEntities(draft.draft_id, "teams"), api.listEntities(draft.draft_id, "milestones"), api.getConfiguration(draft.draft_id, "schedule-tracks"),
      ]);
      return { nextTasks, nextPeople, nextCalendars, nextProjects, nextTeams, nextMilestones, tracksDocument };
    }, ({ nextTasks, nextPeople, nextCalendars, nextProjects, nextTeams, nextMilestones, tracksDocument }) => {
      setTasks(nextTasks); setPeople(nextPeople); setCalendars(nextCalendars); setProjects(nextProjects.filter((item) => item.document.lifecycle === "active")); setTeams(nextTeams.filter((item) => item.document.lifecycle === "active")); setMilestones(nextMilestones.filter((item) => item.document.lifecycle === "active")); setTracksConfig(tracksDocument); setError(null);
    });
  }, [api, draft.draft_id, draft.external_fingerprint, loadRequest.run]);
  useEffect(() => { void load(); }, [load]);
  const catalog = useMemo(() => new EntityCatalog({ projects, milestones }), [projects, milestones]);
  const filterMilestones = milestones.filter((item) => projectFilter === "" || item.document.project === projectFilter);
  const report = useMemo(() => buildWorkloadReport({
    tasks: tasks.map((item) => item.document), projects: projects.map((item) => item.document), people: people.map((item) => item.document), calendars: calendars.map((item) => item.document), teams: teams.map((item) => item.document),
    scheduleTracks: tracksConfig?.document ?? { schema: "gitpm/schedule-tracks@1", tracks: [], defaults: {} },
    filters: { ...(projectFilter === "" ? {} : { project: projectFilter }), ...(milestoneFilter === "" ? {} : { milestone: milestoneFilter }), ...(teamFilter === "" ? {} : { team: teamFilter }) },
  }), [tasks, projects, people, calendars, teams, tracksConfig, projectFilter, milestoneFilter, teamFilter]);
  const visibleWeeks = period === "all" ? report.weeks : report.weeks.slice(0, Number(period));
  const activePeople = [...new Map(report.rows.map((row) => [row.person_id, row.person_name])).entries()];
  const rows = new Map(report.rows.map((row) => [`${row.person_id}:${row.week}`, row]));
  const selectedRow = selectedCell === null ? undefined : rows.get(`${selectedCell.personId}:${selectedCell.week}`);
  const taskById = useMemo(() => new Map(tasks.map((item) => [item.document.id, item])), [tasks]);
  const excluded = Object.values(report.exclusions).reduce((sum, value) => sum + value, 0);

  return <section className="workload-workspace">
    <div className="section-heading"><span className="eyebrow draft-context-id">{draft.draft_id}</span><h2 aria-hidden="true">{t("workload.heading")}</h2><p>{t("workload.description")}</p></div>
    {error !== null && <div className="alert error">{error}</div>}
    <AsyncBoundary state={loadRequest.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{loadError}<button onClick={retry}>{t("status.retry")}</button></div>}>
    <>
    <section className="card workload-toolbar"><label>{t("workload.projectFilter")}<select value={projectFilter} onChange={(event) => { setProjectFilter(event.target.value); setMilestoneFilter(""); }}><option value="">{t("workload.allProjects")}</option>{projects.map((item) => <option key={item.document.id} value={item.document.id}>{text(item.document, "name")}</option>)}</select></label><label>{t("core.milestone")}<select aria-label={t("core.milestone")} value={milestoneFilter} onChange={(event) => setMilestoneFilter(event.target.value)}><option value="">{t("core.allMilestones")}</option>{filterMilestones.map((item) => <option key={item.document.id} value={item.document.id}>{projectFilter === "" ? `${catalog.project(item.document.project).name} · ` : ""}{text(item.document, "name")}</option>)}</select></label><label>{t("workload.teamFilter")}<select value={teamFilter} onChange={(event) => setTeamFilter(event.target.value)}><option value="">{t("workload.allTeams")}</option>{teams.map((item) => <option key={item.document.id} value={item.document.id}>{text(item.document, "name")}</option>)}</select></label><label>{t("workload.period")}<select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="4">{t("workload.weeks4")}</option><option value="8">{t("workload.weeks8")}</option><option value="12">{t("workload.weeks12")}</option><option value="all">{t("workload.allWeeks")}</option></select></label></section>
    <section className="card workload-summary">
      <div><span>{t("workload.included")}</span><strong>{report.included_tasks}</strong></div>
      <div><span>{t("workload.excluded")}</span><strong>{excluded}</strong></div>
      <details className="workload-calculation">
        <summary>{t("workload.calculationDetails")}</summary>
        <p>{t("workload.formula")}</p>
        <p>{t("workload.capacityFormula")}</p>
      </details>
    </section>
    <div className="workload-legend" aria-label={t("workload.heading")}><span className="available">{t("workload.legendLow")}</span><span className="balanced">{t("workload.legendBalanced")}</span><span className="near">{t("workload.legendNear")}</span><span className="overloaded">{t("workload.legendOver")}</span></div>
    {visibleWeeks.length === 0 || activePeople.length === 0 ? <section className="card empty-workspace">{t("workload.empty")}</section> : <section className="card workload-table-wrap">
      <table className="workload-table"><thead><tr><th>{t("workload.person")}</th>{visibleWeeks.map((week) => <th key={week}><time dateTime={week}>{t("workload.week", { date: formatDateOnly(locale, week) })}</time></th>)}</tr></thead>
        <tbody>{activePeople.map(([personId, personName]) => <tr key={personId}><th><button className="text-link" onClick={() => onNavigate("people", { personId })}>{personName}</button></th>{visibleWeeks.map((week) => {
          const value = rows.get(`${personId}:${week}`)!; const tone = overloaded(value) ? "overloaded" : value.utilization_percent === null ? "unavailable" : value.utilization_percent >= 80 ? "near" : value.utilization_percent >= 40 ? "balanced" : "available";
          const content = <><strong>{t("workload.hours", { allocated: formatNumber(locale, value.allocated_hours), capacity: formatNumber(locale, value.capacity_hours) })}</strong><span>{value.utilization_percent === null ? t("workload.noCapacity") : t("workload.utilization", { percent: formatNumber(locale, value.utilization_percent) })}</span>{value.task_allocations.length > 0 && <span className="workload-cell-action">{t("workload.inspect")}</span>}</>;
          return <td className={tone} data-person-id={personId} data-week={week} key={week} title={t("workload.tasks", { count: value.task_ids.length })}>{value.task_allocations.length === 0 ? <div className="workload-cell-content">{content}</div> : <button aria-label={t("workload.openBreakdown", { person: personName, date: formatDateOnly(locale, week) })} className="workload-cell-button" onClick={() => setSelectedCell({ personId, week })} type="button">{content}</button>}</td>;
        })}</tr>)}</tbody></table>
    </section>}
    <section className="card workload-exclusions"><h3>{t("workload.exclusionHeading")}</h3><dl>
      <div><dt>{t("workload.archived")}</dt><dd>{report.exclusions.archived}</dd></div><div><dt>{t("workload.undated")}</dt><dd>{report.exclusions.undated}</dd></div><div><dt>{t("workload.unestimated")}</dt><dd>{report.exclusions.unestimated}</dd></div><div><dt>{t("workload.unassigned")}</dt><dd>{report.exclusions.unassigned}</dd></div><div><dt>{t("workload.unavailable")}</dt><dd>{report.exclusions.unavailable_assignees}</dd></div>
    </dl></section>
    </>
    </AsyncBoundary>
    <EditorDrawer closeLabel={t("workload.closeBreakdown")} onClose={() => setSelectedCell(null)} open={selectedRow !== undefined} title={selectedRow === undefined ? "" : t("workload.breakdownTitle", { person: selectedRow.person_name, date: formatDateOnly(locale, selectedRow.week) })}>
      {selectedRow !== undefined && <section className="workload-breakdown">
        <dl className="workload-breakdown-summary">
          <div><dt>{t("workload.allocation")}</dt><dd>{t("workload.hours", { allocated: formatNumber(locale, selectedRow.allocated_hours), capacity: formatNumber(locale, selectedRow.capacity_hours) })}</dd></div>
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
