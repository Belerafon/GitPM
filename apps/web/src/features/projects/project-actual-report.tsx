import { Fragment, useEffect, useMemo, useState } from "react";
import type { SchedulingReadModel } from "@gitpm/scheduling";
import { windowEffort } from "@gitpm/scheduling";
import {
  actualWindow,
  groupByCategory,
  groupByDate,
  groupByPerson,
  groupByTask,
  hoursAfterDate,
  sumHours,
  type TimeEntryRecord,
} from "@gitpm/time-entries";
import { formatDateOnly, formatDurationHours, formatNumber, message, type Locale, type MessageKey } from "../../i18n.js";
import { formatApiError, listAllProjectTimeEntries, type GitPmApi, type ProjectTimeEntryFilters } from "../../api.js";
import type { DraftStatus, EntityResult } from "../../types.js";
import { scheduleEffortReader, scheduleTextReader } from "../../schedules.js";
import type { WorkspaceNavigate } from "../../workspace-navigation.js";
import { buildProjectTaskViewModel, flattenProjectTaskViewModel } from "./project-task-view-model.js";

export interface ActualReportCategory {
  readonly slug: string;
  readonly title: string;
}

interface ReportFilters {
  readonly task: string;
  readonly milestone: string;
  readonly person: string;
  readonly category: string;
  readonly state: "" | "active" | "voided";
  readonly performed_from: string;
  readonly performed_to: string;
}

type ScopeMode = "withSubtasks" | "taskOnly";

const EMPTY_FILTERS: ReportFilters = { task: "", milestone: "", person: "", category: "", state: "", performed_from: "", performed_to: "" };
const text = (entity: EntityResult | undefined, key: string): string => typeof entity?.document[key] === "string" ? String(entity.document[key]) : "";

/**
 * Actual-work filters narrow only the time entries. Task and milestone scoping
 * is resolved client-side (so a parent task's branch can include its subtasks'
 * records), therefore the server request never carries `task`/`milestone`.
 */
function requestFilters(filters: ReportFilters): ProjectTimeEntryFilters {
  return {
    ...(filters.person === "" ? {} : { person: filters.person }),
    ...(filters.category === "" ? {} : { category: filters.category }),
    ...(filters.state === "" ? {} : { state: filters.state }),
    ...(filters.performed_from === "" ? {} : { performed_from: filters.performed_from }),
    ...(filters.performed_to === "" ? {} : { performed_to: filters.performed_to }),
  };
}

function record(entry: Awaited<ReturnType<typeof listAllProjectTimeEntries>>[number], projectId: string): TimeEntryRecord {
  return {
    id: entry.document.id,
    project: projectId,
    task: entry.document.task,
    person: entry.document.person,
    performed_on: entry.document.performed_on,
    hours: entry.document.hours,
    category: entry.document.category,
    state: entry.document.state,
  };
}

const roundHours = (value: number): number => Math.round((value + Number.EPSILON) * 10_000) / 10_000;

function BreakdownTable({ heading, empty, hoursLabel, rows }: { readonly heading: string; readonly empty: string; readonly hoursLabel: string; readonly rows: readonly { readonly key: string; readonly label: string; readonly hours: number }[] }) {
  return <section className="actual-breakdown"><h5>{heading}</h5>{rows.length === 0 ? <p className="empty-copy">{empty}</p> : <table><thead><tr><th>{heading}</th><th>{hoursLabel}</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key}><th>{row.label}</th><td>{row.hours}</td></tr>)}</tbody></table>}</section>;
}

export function ProjectActualReport({ api, categories = [], comparisonFinish, draft, locale, milestones = [], onNavigate, people = [], project, projectId, readModels, tasks = [], trackTitle, workloadTrack }: {
  readonly api: GitPmApi;
  readonly categories?: readonly ActualReportCategory[];
  readonly comparisonFinish?: string;
  readonly draft: DraftStatus;
  readonly locale: Locale;
  readonly milestones?: readonly EntityResult[];
  readonly onNavigate: WorkspaceNavigate;
  readonly people?: readonly EntityResult[];
  readonly project: EntityResult;
  readonly projectId: string;
  readonly readModels: ReadonlyMap<string, SchedulingReadModel>;
  readonly tasks?: readonly EntityResult[];
  readonly trackTitle?: (slug: string) => string;
  readonly workloadTrack: string;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [filters, setFilters] = useState<ReportFilters>(EMPTY_FILTERS);
  const [scopeMode, setScopeMode] = useState<ScopeMode>("withSubtasks");
  const [cutoff, setCutoff] = useState(comparisonFinish ?? "");
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof listAllProjectTimeEntries>> | null>(null);
  const [knownPeople, setKnownPeople] = useState<readonly string[]>([]);
  const [knownCategories, setKnownCategories] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setCutoff(comparisonFinish ?? ""); }, [comparisonFinish]);
  useEffect(() => {
    if (filters.performed_from !== "" && filters.performed_to !== "" && filters.performed_from > filters.performed_to) {
      setError(t("actualReport.invalidRange"));
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    void listAllProjectTimeEntries(api, draft.draft_id, projectId, requestFilters(filters))
      .then((result) => {
        if (!active) return;
        setEntries(result);
        setKnownPeople((current) => [...new Set([...current, ...result.map((entry) => entry.document.person)])].sort());
        setKnownCategories((current) => [...new Set([...current, ...result.map((entry) => entry.document.category)])].sort());
      })
      .catch((reason: unknown) => { if (active) setError(formatApiError(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, draft.draft_id, filters, projectId]);

  const records = useMemo(() => (entries ?? []).map((entry) => record(entry, projectId)), [entries, projectId]);
  const actualByTask = useMemo(() => groupByTask(records), [records]);
  const actual = actualWindow(records);

  // Hierarchy maps built from `parent` links across ALL project tasks, so the
  // branch actual of any task can reach descendants even if a milestone filter
  // narrows the visible scope.
  const hierarchyMaps = useMemo(() => {
    const childrenByParent = new Map<string, string[]>();
    const parentOf = new Map<string, string>();
    for (const task of tasks) {
      const parent = text(task, "parent");
      if (parent === "") continue;
      parentOf.set(task.document.id, parent);
      const peers = childrenByParent.get(parent) ?? [];
      peers.push(task.document.id);
      childrenByParent.set(parent, peers);
    }
    return { childrenByParent, parentOf };
  }, [tasks]);

  const descendantsOf = (id: string): readonly string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const child of hierarchyMaps.childrenByParent.get(current) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        out.push(child);
        stack.push(child);
      }
    }
    return out;
  };

  const workloadSummary = (id: string) => readModels.get(id)?.tracks.find((track) => track.track === workloadTrack);
  // declared-own wins; otherwise rolled-children. Exactly one value per task, so
  // summing this over scope ROOTS never double-counts parent + children.
  const modelEffortFor = (id: string): number | undefined =>
    windowEffort(workloadSummary(id)?.declared) ?? windowEffort(workloadSummary(id)?.rolled);

  const ownActual = (id: string): number => actualByTask.get(id) ?? 0;
  const branchActual = (id: string): number => {
    let total = ownActual(id);
    for (const descendant of descendantsOf(id)) total += ownActual(descendant);
    return roundHours(total);
  };

  const inScopeIds = useMemo<ReadonlySet<string>>(() => {
    if (filters.task !== "") {
      return scopeMode === "taskOnly" ? new Set([filters.task]) : new Set([filters.task, ...descendantsOf(filters.task)]);
    }
    if (filters.milestone !== "") {
      return new Set(tasks.filter((task) => text(task, "milestone") === filters.milestone).map((task) => task.document.id));
    }
    return new Set(tasks.map((task) => task.document.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.task, filters.milestone, scopeMode, tasks, hierarchyMaps]);

  const scopeRootIds = useMemo<readonly string[]>(() => {
    const parentOf = hierarchyMaps.parentOf;
    return [...inScopeIds].filter((id) => {
      const parent = parentOf.get(id);
      return parent === undefined || !inScopeIds.has(parent);
    });
  }, [inScopeIds, hierarchyMaps]);

  const planOfWork = useMemo<number | undefined>(() => {
    let total: number | undefined;
    for (const id of scopeRootIds) {
      const effort = modelEffortFor(id);
      if (effort === undefined) continue;
      total = (total ?? 0) + effort;
    }
    return total;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeRootIds, readModels, workloadTrack]);

  const wholeProject = filters.task === "" && filters.milestone === "";
  const projectBudget = wholeProject
    ? windowEffort(workloadSummary(projectId)?.declared)
    : undefined;

  const scopeRecords = useMemo(() => records.filter((item) => inScopeIds.has(item.task)), [records, inScopeIds]);
  const scopeActual = useMemo(() => sumHours(scopeRecords), [scopeRecords]);
  const filteredActualOnly = filters.person !== "" || filters.category !== "" || filters.state !== "" || filters.performed_from !== "" || filters.performed_to !== "";

  const personName = (id: string) => text(people.find((person) => person.document.id === id), "name") || id;
  const categoryName = (slug: string) => categories.find((category) => category.slug === slug)?.title ?? slug;
  const milestoneName = (id: string) => text(milestones.find((milestone) => milestone.document.id === id), "name") || t("actualReport.noMilestone");
  const taskName = (id: string) => text(tasks.find((task) => task.document.id === id), "title") || id;
  const taskOptions = tasks.filter((task) => filters.milestone === "" || text(task, "milestone") === filters.milestone);
  const peopleOptions = [...new Set([...people.map((person) => person.document.id), ...knownPeople])].sort((left, right) => personName(left).localeCompare(personName(right), locale));
  const categoryOptions = [...new Set([...categories.map((category) => category.slug), ...knownCategories])].sort((left, right) => categoryName(left).localeCompare(categoryName(right), locale));
  const personRows = [...groupByPerson(records).entries()].map(([key, hours]) => ({ key, label: personName(key), hours })).sort((left, right) => left.label.localeCompare(right.label, locale));
  const categoryRows = [...groupByCategory(records).entries()].map(([key, hours]) => ({ key, label: categoryName(key), hours })).sort((left, right) => left.label.localeCompare(right.label, locale));
  const dateRows = [...groupByDate(records).entries()].map(([key, hours]) => ({ key, label: formatDateOnly(locale, key), hours })).sort((left, right) => right.key.localeCompare(left.key));
  const activeCount = records.filter((item) => item.state !== "voided").length;
  const voidedCount = records.length - activeCount;
  const after = cutoff === "" ? undefined : hoursAfterDate(records, cutoff);
  const patchFilter = <Key extends keyof ReportFilters>(key: Key, value: ReportFilters[Key]) => setFilters((current) => ({ ...current, [key]: value }));

  const viewModel = useMemo(() => buildProjectTaskViewModel({
    project,
    milestones,
    tasks,
    text: scheduleTextReader(workloadTrack),
    effortOf: scheduleEffortReader(workloadTrack),
    locale,
  }), [project, milestones, tasks, workloadTrack, locale]);
  const flattened = useMemo(() => flattenProjectTaskViewModel(viewModel), [viewModel]);

  interface PlanActualRow {
    readonly id: string;
    readonly title: string;
    readonly depth: number;
    readonly stage: EntityResult | undefined;
    readonly plan: number | undefined;
    readonly actualBranch: number;
    readonly actualOwn: number;
  }
  const planActualRows = useMemo<readonly PlanActualRow[]>(() => {
    const taskOnly = filters.task !== "" && scopeMode === "taskOnly";
    const baseDepth = filters.task !== "" ? (flattened.find((row) => row.node.id === filters.task)?.node.depth ?? 0) : 0;
    const rows: PlanActualRow[] = [];
    for (const row of flattened) {
      if (!inScopeIds.has(row.node.id)) continue;
      rows.push({
        id: row.node.id,
        title: row.node.title || taskName(row.node.id),
        depth: filters.task !== "" ? row.node.depth - baseDepth : row.node.depth,
        stage: row.stage,
        plan: modelEffortFor(row.node.id),
        actualBranch: taskOnly ? ownActual(row.node.id) : branchActual(row.node.id),
        actualOwn: ownActual(row.node.id),
      });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flattened, inScopeIds, filters.task, scopeMode, readModels, workloadTrack, actualByTask, hierarchyMaps]);

  const planSources: string[] = [];
  if (wholeProject && projectBudget !== undefined) {
    if (planOfWork !== undefined) planSources.push(t("actualReport.sourceRootSum"));
    planSources.push(t("actualReport.sourceProjectBudget"));
  } else if (planOfWork !== undefined) {
    if (filters.task !== "") {
      const ownEstimate = windowEffort(workloadSummary(filters.task)?.declared);
      planSources.push(ownEstimate !== undefined ? t("actualReport.sourceTaskExplicit") : t("actualReport.sourceSubtaskSum"));
    } else {
      planSources.push(t("actualReport.sourceRootSum"));
    }
  } else {
    planSources.push(t("actualReport.sourceMissing"));
  }
  const planSourceText = planSources.join(" · ");
  const showPlanOfWorkLabel = wholeProject && projectBudget !== undefined;

  const planActualGroups = useMemo(() => {
    const groups: { stage: EntityResult | undefined; rows: PlanActualRow[] }[] = [];
    for (const row of planActualRows) {
      const last = groups[groups.length - 1];
      if (last === undefined || last.stage !== row.stage) groups.push({ stage: row.stage, rows: [row] });
      else last.rows.push(row);
    }
    return groups;
  }, [planActualRows]);

  return <section className="actual-hours-report">
    <div className="actual-report-heading"><div><h4>{t("snapshot.actualReport")}</h4><p>{t("actualReport.description")}</p></div><button type="button" onClick={() => { setFilters(EMPTY_FILTERS); setScopeMode("withSubtasks"); setCutoff(comparisonFinish ?? ""); }}>{t("actualReport.reset")}</button></div>
    <div className="actual-report-filters">
      <label>{t("actualReport.task")}<select value={filters.task} onChange={(event) => patchFilter("task", event.target.value)}><option value="">{t("actualReport.allTasks")}</option>{taskOptions.map((task) => <option key={task.document.id} value={task.document.id}>{taskName(task.document.id)}</option>)}</select></label>
      <label>{t("actualReport.milestone")}<select value={filters.milestone} onChange={(event) => { patchFilter("milestone", event.target.value); if (filters.task !== "" && text(tasks.find((task) => task.document.id === filters.task), "milestone") !== event.target.value) patchFilter("task", ""); }}><option value="">{t("actualReport.allMilestones")}</option>{milestones.map((milestone) => <option key={milestone.document.id} value={milestone.document.id}>{milestoneName(milestone.document.id)}</option>)}</select></label>
      <label>{t("timeEffort.person")}<select value={filters.person} onChange={(event) => patchFilter("person", event.target.value)}><option value="">{t("actualReport.allPeople")}</option>{peopleOptions.map((id) => <option key={id} value={id}>{personName(id)}</option>)}</select></label>
      <label>{t("timeEffort.category")}<select value={filters.category} onChange={(event) => patchFilter("category", event.target.value)}><option value="">{t("actualReport.allCategories")}</option>{categoryOptions.map((slug) => <option key={slug} value={slug}>{categoryName(slug)}</option>)}</select></label>
      <label>{t("actualReport.state")}<select value={filters.state} onChange={(event) => patchFilter("state", event.target.value as ReportFilters["state"])}><option value="">{t("actualReport.allStates")}</option><option value="active">{t("actualReport.active")}</option><option value="voided">{t("actualReport.voided")}</option></select></label>
      <label>{t("actualReport.from")}<input type="date" value={filters.performed_from} onChange={(event) => patchFilter("performed_from", event.target.value)} /></label>
      <label>{t("actualReport.to")}<input type="date" value={filters.performed_to} onChange={(event) => patchFilter("performed_to", event.target.value)} /></label>
      <label>{t("actualReport.after")}<input type="date" value={cutoff} onChange={(event) => setCutoff(event.target.value)} /></label>
      {filters.task !== "" && <label>{t("actualReport.scopeMode")}<select value={scopeMode} onChange={(event) => setScopeMode(event.target.value as ScopeMode)}><option value="withSubtasks">{t("actualReport.scopeWithSubtasks")}</option><option value="taskOnly">{t("actualReport.scopeTaskOnly")}</option></select></label>}
    </div>
    {error !== null && <div className="alert error">{error}</div>}
    {loading && <p className="empty-copy">{t("status.loading")}</p>}
    {entries !== null && <>
      <dl className="actual-report-summary">
        <div><dt>{t("snapshot.actualHours")}</dt><dd>{formatDurationHours(locale, sumHours(scopeRecords))}</dd></div>
        <div><dt>{t("actualReport.activeEntries")}</dt><dd>{activeCount}</dd></div>
        <div><dt>{t("actualReport.voidedEntries")}</dt><dd>{voidedCount}</dd></div>
        {actual?.start !== undefined && <div><dt>{t("timeEffort.firstActivity")}</dt><dd>{formatDateOnly(locale, actual.start)}</dd></div>}
        {actual?.finish !== undefined && <div><dt>{t("timeEffort.lastActivity")}</dt><dd>{formatDateOnly(locale, actual.finish)}</dd></div>}
        {after !== undefined && <div><dt>{t("snapshot.hoursAfter", { date: cutoff })}</dt><dd>{formatDurationHours(locale, after)}</dd></div>}
      </dl>
      <section className="plan-actual-report">
        <div className="plan-actual-heading">
          <div>
            <h5>{t("actualReport.planActual")}</h5>
            <p className="plan-source"><span className="plan-source-label">{t("actualReport.planSourceLabel")}:</span> {planSourceText}{trackTitle !== undefined && planOfWork !== undefined ? ` · ${t("actualReport.planSourceTrack", { track: trackTitle(workloadTrack) })}` : ""}</p>
            {filteredActualOnly && <p className="scope-hint">{t("actualReport.planNotFiltered")}</p>}
          </div>
          <dl>
            <div><dt>{showPlanOfWorkLabel ? t("actualReport.planOfWork") : t("actualReport.planOfScope")}</dt><dd>{planOfWork === undefined ? "—" : formatDurationHours(locale, planOfWork)}</dd></div>
            {wholeProject && projectBudget !== undefined && <>
              <div><dt>{t("actualReport.budget")}</dt><dd>{formatDurationHours(locale, projectBudget)}</dd></div>
              <div><dt>{t("actualReport.planDifference")}</dt><dd>{formatDurationHours(locale, (planOfWork ?? 0) - projectBudget)}</dd></div>
            </>}
            <div><dt>{filteredActualOnly ? t("actualReport.filteredActual") : t("snapshot.actualHours")}</dt><dd>{formatDurationHours(locale, scopeActual)}</dd></div>
            {!filteredActualOnly && <>
              <div><dt>{t("actualReport.variance")}</dt><dd>{planOfWork === undefined ? "—" : formatDurationHours(locale, scopeActual - planOfWork)}</dd></div>
              <div><dt>{t("actualReport.ratio")}</dt><dd>{planOfWork === undefined || planOfWork === 0 ? "—" : `${formatNumber(locale, scopeActual / planOfWork * 100)}%`}</dd></div>
            </>}
          </dl>
        </div>
        {filteredActualOnly && <p className="scope-hint">{t("actualReport.actualOnlyFilters")}</p>}
        {planActualRows.length === 0 ? <p className="empty-copy">{t("actualReport.empty")}</p> : <div className="actual-report-table-wrap"><table><thead><tr><th>{t("actualReport.task")}</th><th>{t("actualReport.milestone")}</th><th>{t("actualReport.planned")}</th><th>{t("actualReport.actual")}</th><th>{t("actualReport.ownHours")}</th><th>{t("actualReport.variance")}</th></tr></thead><tbody>{planActualGroups.map((group, groupIndex) => <Fragment key={groupIndex}><tr className="actual-report-stage-row"><th colSpan={6}>{group.stage === undefined ? t("actualReport.noMilestone") : milestoneName(group.stage.document.id)}</th></tr>{group.rows.map((row) => <tr key={row.id} className="actual-report-task-row" data-depth={row.depth} data-task-id={row.id}><th className="actual-report-task-cell" style={{ paddingLeft: `${0.5 + row.depth * 1.2}rem` }}><button type="button" className="actual-report-task-link" aria-label={`${row.title} ${row.id}`} onClick={() => onNavigate("tasks", { projectId, taskId: row.id })}><span>{row.title}</span><code>{row.id}</code></button></th><td>{group.stage === undefined ? t("actualReport.noMilestone") : milestoneName(group.stage.document.id)}</td><td>{row.plan === undefined ? "—" : formatDurationHours(locale, row.plan)}</td><td>{formatDurationHours(locale, row.actualBranch)}</td><td>{formatDurationHours(locale, row.actualOwn)}</td><td>{row.plan === undefined ? "—" : formatDurationHours(locale, row.actualBranch - row.plan)}</td></tr>)}</Fragment>)}</tbody></table></div>}
      </section>
      <div className="actual-breakdowns">
        <BreakdownTable heading={t("actualReport.byPerson")} empty={t("actualReport.empty")} hoursLabel={t("timeEffort.hours")} rows={personRows} />
        <BreakdownTable heading={t("actualReport.byCategory")} empty={t("actualReport.empty")} hoursLabel={t("timeEffort.hours")} rows={categoryRows} />
        <BreakdownTable heading={t("actualReport.byDate")} empty={t("actualReport.empty")} hoursLabel={t("timeEffort.hours")} rows={dateRows} />
      </div>
    </>}
  </section>;
}
