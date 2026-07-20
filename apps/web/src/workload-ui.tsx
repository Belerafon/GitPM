import { useCallback, useEffect, useMemo, useState } from "react";
import { calculateWorkload, type WorkloadCalendar, type WorkloadPerson, type WorkloadTask } from "@gitpm/workload";
import type { GitPmApi } from "./api.js";
import { formatDateOnly, formatNumber, message, type Locale, type MessageKey } from "./i18n.js";
import type { DraftStatus, EntityResult, GitPmDocument } from "./types.js";
import { AsyncBoundary, useAsyncLoad } from "./async-data.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";
import { EntityCatalog } from "./entity-catalog.js";

const text = (document: GitPmDocument, key: string) => typeof document[key] === "string" ? document[key] as string : undefined;
const number = (document: GitPmDocument, key: string) => typeof document[key] === "number" ? document[key] as number : undefined;
const strings = (document: GitPmDocument, key: string) => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
const numbers = (document: GitPmDocument, key: string) => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is number => typeof item === "number") : [];

function task(entity: EntityResult): WorkloadTask {
  return { id: entity.document.id, title: text(entity.document, "title") ?? entity.document.id, lifecycle: entity.document.lifecycle, estimate_hours: number(entity.document, "estimate_hours"), start: text(entity.document, "start"), due: text(entity.document, "due"), assignees: strings(entity.document, "assignees") };
}

function person(entity: EntityResult): WorkloadPerson {
  return { id: entity.document.id, name: text(entity.document, "name") ?? entity.document.id, lifecycle: entity.document.lifecycle, weekly_capacity_hours: number(entity.document, "weekly_capacity_hours") ?? 0, calendar: text(entity.document, "calendar") ?? "" };
}

function calendar(entity: EntityResult): WorkloadCalendar {
  return { id: entity.document.id, lifecycle: entity.document.lifecycle, working_weekdays: numbers(entity.document, "working_weekdays"), holidays: strings(entity.document, "holidays") };
}

export function WorkloadWorkspace({ api, draft, locale, onNavigate = () => undefined }: { readonly api: GitPmApi; readonly draft: DraftStatus; readonly locale: Locale; readonly onNavigate?: WorkspaceNavigate }) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [tasks, setTasks] = useState<readonly EntityResult[]>([]);
  const [people, setPeople] = useState<readonly EntityResult[]>([]);
  const [calendars, setCalendars] = useState<readonly EntityResult[]>([]);
  const [projects, setProjects] = useState<readonly EntityResult[]>([]);
  const [teams, setTeams] = useState<readonly EntityResult[]>([]);
  const [milestones, setMilestones] = useState<readonly EntityResult[]>([]);
  const [projectFilter, setProjectFilter] = useState("");
  const [milestoneFilter, setMilestoneFilter] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  const [period, setPeriod] = useState("8");
  const [error, setError] = useState<string | null>(null);
  const loadRequest = useAsyncLoad();
  const load = useCallback(async () => {
    await loadRequest.run(async () => {
      const [nextTasks, nextPeople, nextCalendars, nextProjects, nextTeams, nextMilestones] = await Promise.all([
        api.listEntities(draft.draft_id, "tasks"), api.listEntities(draft.draft_id, "people"), api.listEntities(draft.draft_id, "calendars"), api.listEntities(draft.draft_id, "projects"), api.listEntities(draft.draft_id, "teams"), api.listEntities(draft.draft_id, "milestones"),
      ]);
      return { nextTasks, nextPeople, nextCalendars, nextProjects, nextTeams, nextMilestones };
    }, ({ nextTasks, nextPeople, nextCalendars, nextProjects, nextTeams, nextMilestones }) => {
      setTasks(nextTasks); setPeople(nextPeople); setCalendars(nextCalendars); setProjects(nextProjects.filter((item) => item.document.lifecycle === "active")); setTeams(nextTeams.filter((item) => item.document.lifecycle === "active")); setMilestones(nextMilestones.filter((item) => item.document.lifecycle === "active")); setError(null);
    });
  }, [api, draft.draft_id, draft.external_fingerprint, loadRequest.run]);
  useEffect(() => { void load(); }, [load]);
  const selectedTeamMembers = new Set(strings(teams.find((item) => item.document.id === teamFilter)?.document ?? { schema: "", id: "", lifecycle: "active" }, "members"));
  const filteredTasks = tasks.filter((item) => (projectFilter === "" || text(item.document, "project") === projectFilter) && (milestoneFilter === "" || text(item.document, "milestone") === milestoneFilter) && (teamFilter === "" || strings(item.document, "assignees").some((id) => selectedTeamMembers.has(id))));
  const catalog = useMemo(() => new EntityCatalog({ projects, milestones }), [projects, milestones]);
  const filterMilestones = milestones.filter((item) => projectFilter === "" || item.document.project === projectFilter);
  const report = useMemo(() => calculateWorkload(filteredTasks.map(task), people.map(person), calendars.map(calendar)), [filteredTasks, people, calendars]);
  const visibleWeeks = period === "all" ? report.weeks : report.weeks.slice(0, Number(period));
  const activePeople = [...new Map(report.rows.map((row) => [row.person_id, row.person_name])).entries()];
  const rows = new Map(report.rows.map((row) => [`${row.person_id}:${row.week}`, row]));
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
          const value = rows.get(`${personId}:${week}`)!; const overloaded = value.capacity_hours === 0 ? value.allocated_hours > 0 : value.allocated_hours > value.capacity_hours; const tone = overloaded ? "overloaded" : value.utilization_percent === null ? "unavailable" : value.utilization_percent >= 80 ? "near" : value.utilization_percent >= 40 ? "balanced" : "available";
          return <td className={tone} data-person-id={personId} data-week={week} key={week} title={t("workload.tasks", { count: value.task_ids.length })}><strong>{t("workload.hours", { allocated: formatNumber(locale, value.allocated_hours), capacity: formatNumber(locale, value.capacity_hours) })}</strong><span>{value.utilization_percent === null ? t("workload.noCapacity") : t("workload.utilization", { percent: formatNumber(locale, value.utilization_percent) })}</span></td>;
        })}</tr>)}</tbody></table>
    </section>}
    <section className="card workload-exclusions"><h3>{t("workload.exclusionHeading")}</h3><dl>
      <div><dt>{t("workload.archived")}</dt><dd>{report.exclusions.archived}</dd></div><div><dt>{t("workload.undated")}</dt><dd>{report.exclusions.undated}</dd></div><div><dt>{t("workload.unestimated")}</dt><dd>{report.exclusions.unestimated}</dd></div><div><dt>{t("workload.unassigned")}</dt><dd>{report.exclusions.unassigned}</dd></div><div><dt>{t("workload.unavailable")}</dt><dd>{report.exclusions.unavailable_assignees}</dd></div>
    </dl></section>
    </>
    </AsyncBoundary>
  </section>;
}
