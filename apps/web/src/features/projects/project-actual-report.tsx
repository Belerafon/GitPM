import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { windowEffort, type SchedulingReadModel } from "@gitpm/scheduling";
import {
  actualWindow,
  groupByCategory,
  groupByDate,
  groupByPerson,
  hoursAfterDate,
  sumHours,
  type TimeEntryRecord,
} from "@gitpm/time-entries";
import { formatDateOnly, formatDurationHours, formatNumber, message, type Locale, type MessageKey } from "../../i18n.js";
import { formatApiError, listAllProjectTimeEntries, type GitPmApi, type ProjectTimeEntryFilters } from "../../api.js";
import type { DraftStatus, EntityResult } from "../../types.js";
import { scheduleEffortReader, scheduleTextReader } from "../../schedules.js";
import type { WorkspaceNavigate } from "../../workspace-navigation.js";
import { buildProjectTaskViewModel, canonicalTaskComparator, flattenProjectTaskViewModel, orderActiveMilestones } from "./project-task-view-model.js";
import {
  buildTaskRelations,
  resolveEffortScope,
  taskPlanEffort,
  roundHours,
  scopeRootIdsOf,
  selectScopedRecords,
  sumBranchActualWithinScope,
  sumScopePlan,
  type EffortScopeMode,
} from "./project-effort-model.js";

export interface ActualReportCategory {
  readonly slug: string;
  readonly title: string;
}

interface ReportFilters {
  readonly task: string;
  readonly milestone: string;
  readonly person: string;
  readonly category: string;
  readonly performed_from: string;
  readonly performed_to: string;
}

const EMPTY_FILTERS: ReportFilters = { task: "", milestone: "", person: "", category: "", performed_from: "", performed_to: "" };
const text = (entity: EntityResult | undefined, key: string): string => typeof entity?.document[key] === "string" ? String(entity.document[key]) : "";

/**
 * Actual-work filters narrow only the time entries. Task and milestone scoping
 * is resolved client-side, therefore the server request never carries
 * `task`/`milestone`. Voided entries are hidden by default; toggling "show
 * cancelled entries" fetches every state for the audit trail without ever
 * counting voided hours toward a total.
 */
function requestFilters(filters: ReportFilters, showVoided: boolean): ProjectTimeEntryFilters {
  const state = showVoided ? undefined : "active";
  return {
    ...(filters.person === "" ? {} : { person: filters.person }),
    ...(filters.category === "" ? {} : { category: filters.category }),
    ...(state === undefined ? {} : { state }),
    ...(filters.performed_from === "" ? {} : { performed_from: filters.performed_from }),
    ...(filters.performed_to === "" ? {} : { performed_to: filters.performed_to }),
  };
}

type RawEntry = Awaited<ReturnType<typeof listAllProjectTimeEntries>>[number];

function toRecord(entry: RawEntry, projectId: string): TimeEntryRecord {
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

function BreakdownTable({ heading, empty, hoursLabel, rows }: { readonly heading: string; readonly empty: string; readonly hoursLabel: string; readonly rows: readonly { readonly key: string; readonly label: string; readonly hours: number }[] }) {
  return <section className="actual-breakdown"><h5>{heading}</h5>{rows.length === 0 ? <p className="empty-copy">{empty}</p> : <table><thead><tr><th scope="col">{heading}</th><th scope="col">{hoursLabel}</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key}><th scope="row">{row.label}</th><td>{row.hours}</td></tr>)}</tbody></table>}</section>;
}

const actorName = (actor: unknown): string => {
  if (actor === null || typeof actor !== "object") return "";
  const name = (actor as { readonly display_name?: unknown }).display_name;
  if (typeof name === "string" && name !== "") return name;
  const subject = (actor as { readonly subject?: unknown }).subject;
  return typeof subject === "string" ? subject : "";
};

export function ProjectActualReport({ api, categories = [], draft, locale, milestones = [], onNavigate, people = [], project, projectId, readModels, tasks = [], trackTitle, workloadTrack }: {
  readonly api: GitPmApi;
  readonly categories?: readonly ActualReportCategory[];
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
  const [scopeMode, setScopeMode] = useState<EffortScopeMode>("withSubtasks");
  const [showVoided, setShowVoided] = useState(false);
  const [cutoff, setCutoff] = useState("");
  const [entries, setEntries] = useState<readonly RawEntry[] | null>(null);
  const [knownPeople, setKnownPeople] = useState<readonly string[]>([]);
  const [knownCategories, setKnownCategories] = useState<readonly string[]>([]);
  // Task ids that have at least one non-voided time record anywhere in the project. Populated
  // exclusively by the independent full-index request (Request A below), never by the filtered
  // display request, so a person, category, or date filter can never shrink the set of tasks
  // recognized as historical.
  const [historicalTaskIds, setHistoricalTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Every accumulator below belongs to one working copy (projectId + draft). When either
  // changes the whole state of the previous copy is cleared — entries, historical index,
  // catalogs, filters, scope mode, show-cancelled toggle, cutoff, and errors — so nothing can
  // leak across projects or drafts. The two data effects that follow re-populate the state from
  // the new copy.
  useEffect(() => {
    setEntries(null);
    setKnownPeople([]);
    setKnownCategories([]);
    setHistoricalTaskIds(new Set());
    setFilters(EMPTY_FILTERS);
    setScopeMode("withSubtasks");
    setShowVoided(false);
    setCutoff("");
    setError(null);
  }, [projectId, draft.draft_id]);

  // Request A — full historical index. Depends only on api, projectId, and draft.draft_id. It
  // never carries user filters (person, category, date range, state, task, milestone,
  // showVoided) so the resulting set of historical task ids, people, and categories is always
  // complete regardless of what the user selects in the report toolbar. A single project-wide
  // paginated call is used; per-task requests are forbidden. A cancellation flag discards any
  // response that arrives after the working copy changed.
  useEffect(() => {
    let active = true;
    void listAllProjectTimeEntries(api, draft.draft_id, projectId)
      .then((result) => {
        if (!active) return;
        const taskIds = new Set<string>();
        const people = new Set<string>();
        const categories = new Set<string>();
        for (const entry of result) {
          if (entry.document.state !== "voided") taskIds.add(entry.document.task);
          people.add(entry.document.person);
          categories.add(entry.document.category);
        }
        setHistoricalTaskIds(taskIds);
        setKnownPeople([...people].sort());
        setKnownCategories([...categories].sort());
      })
      .catch(() => { /* A failed index request degrades gracefully: the selector omits
                        archived tasks and the dropdowns fall back to catalog-level options.
                        The filtered display request (Request B) surfaces its own errors. */ });
    return () => { active = false; };
  }, [api, draft.draft_id, projectId]);

  // Request B — displayed records. Narrowed by the user's person, category, date-range, and
  // state filters. Updates only the visible rows, sums, and groupings. It never touches the
  // full historical index (Request A), which stays complete across filter changes. A
  // cancellation flag discards any response that arrives after the filters or the working copy
  // changed, so a slow filtered response can never overwrite a newer one or the full index.
  useEffect(() => {
    if (filters.performed_from !== "" && filters.performed_to !== "" && filters.performed_from > filters.performed_to) {
      setError(t("actualReport.invalidRange"));
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    void listAllProjectTimeEntries(api, draft.draft_id, projectId, requestFilters(filters, showVoided))
      .then((result) => { if (active) setEntries(result); })
      .catch((reason: unknown) => { if (active) setError(formatApiError(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, draft.draft_id, projectId, filters, showVoided]);

  const records = useMemo(() => (entries ?? []).map((entry) => toRecord(entry, projectId)), [entries, projectId]);
  const reader = useMemo(() => scheduleTextReader(workloadTrack), [workloadTrack]);

  // Two relation models are kept deliberately separate. `historicalRelations` spans ALL tasks
  // (archived included, raw parent links) so historical time records, archived task display,
  // name lookups, and actual-hour grouping can still reach every descendant. `currentPlanRelations`
  // spans ACTIVE tasks only and normalizes parent links against the active-task set, so an active
  // child of an archived or missing parent becomes a root of the current plan instead of
  // disappearing from the plan rollup. The plan and root-task calculations go through
  // `currentPlanRelations`; everything that touches actual hours goes through `historicalRelations`.
  const activeTaskIds = useMemo(() => new Set(tasks.filter((task) => task.document.lifecycle === "active").map((task) => task.document.id)), [tasks]);
  const currentPlanRelations = useMemo(() => buildTaskRelations(tasks.filter((task) => task.document.lifecycle === "active"), { activeTaskIds }), [activeTaskIds, tasks]);
  const historicalRelations = useMemo(() => buildTaskRelations(tasks), [tasks]);
  const orderedMilestones = useMemo(() => orderActiveMilestones({ project, milestones, text: reader, locale }), [project, milestones, reader, locale]);
  const activeMilestoneIds = useMemo(() => new Set(orderedMilestones.map((milestone) => milestone.document.id)), [orderedMilestones]);
  const scope = useMemo<ReadonlySet<string>>(() => {
    // A selected task always wins: its subtree is the scope, even when the task lives in the
    // "outside active milestones" group. The "none" milestone scope only applies when no task
    // is selected, so picking an orphan task narrows to that task rather than every orphan.
    if (filters.task !== "") {
      return resolveEffortScope(historicalRelations, { taskId: filters.task, milestoneId: filters.milestone, mode: scopeMode });
    }
    if (filters.milestone === "none") {
      return new Set(historicalRelations.ids.filter((id) => {
        const milestone = historicalRelations.milestoneOf.get(id);
        return milestone === undefined || !activeMilestoneIds.has(milestone);
      }));
    }
    return resolveEffortScope(historicalRelations, { taskId: "", milestoneId: filters.milestone, mode: scopeMode });
  }, [historicalRelations, filters.task, filters.milestone, scopeMode, activeMilestoneIds]);
  // Plan roots are resolved from the CURRENT plan relations so an active task whose parent is
  // archived or missing still contributes its estimate to the plan. Actual-hour aggregation
  // (below) uses the historical relations and the full scope.
  const scopeRootIds = useMemo(() => scopeRootIdsOf(scope, currentPlanRelations), [scope, currentPlanRelations]);
  const scopeRecords = useMemo(() => selectScopedRecords(records, scope), [records, scope]);
  const scopeActual = useMemo(() => sumHours(scopeRecords), [scopeRecords]);
  const actualByTask = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of scopeRecords) {
      if (entry.state === "voided") continue;
      map.set(entry.task, roundHours((map.get(entry.task) ?? 0) + entry.hours));
    }
    return map;
  }, [scopeRecords]);
  const scopeWindow = useMemo(() => actualWindow(scopeRecords), [scopeRecords]);

  const planOfWork = useMemo(() => sumScopePlan(readModels, workloadTrack, scopeRootIds, scopeMode), [readModels, workloadTrack, scopeRootIds, scopeMode]);
  const wholeProject = filters.task === "" && filters.milestone === "";
  // The project budget is the explicit project-level estimate only (declared), never the
  // rolled-up task sum — otherwise it would double-count the top-level task estimates.
  const projectBudget = wholeProject
    ? windowEffort(readModels.get(projectId)?.tracks.find((track) => track.track === workloadTrack)?.declared)
    : undefined;

  const filteredActualOnly = filters.person !== "" || filters.category !== "" || filters.performed_from !== "" || filters.performed_to !== "";

  const personName = (id: string) => {
    const person = people.find((item) => item.document.id === id);
    if (person === undefined) return t("actualReport.unknownPerson", { id });
    const name = text(person, "name") || id;
    return person.document.lifecycle === "archived" ? t("actualReport.archivedEntity", { name }) : name;
  };
  const categoryName = (slug: string) => categories.find((category) => category.slug === slug)?.title ?? slug;
  const milestoneName = (id: string) => text(milestones.find((milestone) => milestone.document.id === id), "name") || t("actualReport.noMilestone");
  const taskName = (id: string) => text(tasks.find((task) => task.document.id === id), "title") || id;

  const peopleOptions = [...new Set([...people.map((person) => person.document.id), ...knownPeople])].sort((left, right) => personName(left).localeCompare(personName(right), locale));
  const categoryOptions = [...new Set([...categories.map((category) => category.slug), ...knownCategories])].sort((left, right) => categoryName(left).localeCompare(categoryName(right), locale));

  const personRows = useMemo(() => [...groupByPerson(scopeRecords).entries()].map(([key, hours]) => ({ key, label: personName(key), hours })).sort((left, right) => left.label.localeCompare(right.label, locale)), [scopeRecords, locale]);
  const categoryRows = useMemo(() => [...groupByCategory(scopeRecords).entries()].map(([key, hours]) => ({ key, label: categoryName(key), hours })).sort((left, right) => left.label.localeCompare(right.label, locale)), [scopeRecords, locale]);
  const dateRows = useMemo(() => [...groupByDate(scopeRecords).entries()].map(([key, hours]) => ({ key, label: formatDateOnly(locale, key), hours })).sort((left, right) => right.key.localeCompare(left.key)), [scopeRecords, locale]);
  const activeCount = useMemo(() => scopeRecords.filter((item) => item.state !== "voided").length, [scopeRecords]);
  const voidedRecords = useMemo(() => (entries ?? []).filter((entry) => scope.has(entry.document.task) && entry.document.state === "voided"), [entries, scope]);
  const after = cutoff === "" ? undefined : hoursAfterDate(scopeRecords, cutoff);

  // The current-plan view model is built from ACTIVE tasks only. Because buildTaskHierarchy
  // treats a task whose parent is absent from the input as a root, passing active tasks alone
  // normalizes every parent link: an active child of an archived, deleted, missing, or
  // self-referential parent becomes a root of its stage instead of vanishing under a parent
  // the active tree cannot resolve. Archived tasks are never inserted back into this tree —
  // they surface as flat historical rows (see planActualRows) so they cannot determine an
  // active task's depth, indent, or order.
  const activeTasks = useMemo(() => tasks.filter((task) => task.document.lifecycle === "active"), [tasks]);
  const viewModel = useMemo(() => buildProjectTaskViewModel({
    project,
    milestones,
    tasks: activeTasks,
    text: reader,
    effortOf: scheduleEffortReader(workloadTrack),
    locale,
    compareTasks: canonicalTaskComparator(locale, reader),
  }), [project, milestones, activeTasks, reader, workloadTrack, locale]);
  const flattened = useMemo(() => flattenProjectTaskViewModel(viewModel), [viewModel]);
  // Archived tasks that own non-voided time records anywhere in the project. Identified by the
  // independent full-index request (Request A), not the filtered display records, so they
  // remain visible in the selector and the historical rows regardless of the current filter.
  const archivedTasksWithHistory = useMemo(() => tasks.filter((task) => task.document.lifecycle === "archived" && historicalTaskIds.has(task.document.id)), [tasks, historicalTaskIds]);

  const patchFilter = <Key extends keyof ReportFilters>(key: Key, value: ReportFilters[Key]) => setFilters((current) => ({ ...current, [key]: value }));

  interface PlanActualRow {
    readonly id: string;
    readonly title: string;
    readonly depth: number;
    readonly stage: EntityResult | undefined;
    readonly plan: number | undefined;
    readonly planSource: "declared" | "rolled" | "missing";
    readonly actualBranch: number;
    readonly actualOwn: number;
    readonly archived: boolean;
  }
  const planActualRows = useMemo<readonly PlanActualRow[]>(() => {
    const taskOnly = filters.task !== "" && scopeMode === "taskOnly";
    const baseDepth = filters.task !== "" ? (flattened.find((row) => row.node.id === filters.task)?.node.depth ?? 0) : 0;
    const rows: PlanActualRow[] = [];
    for (const row of flattened) {
      if (!scope.has(row.node.id)) continue;
      const plan = taskPlanEffort(readModels, workloadTrack, row.node.id, taskOnly ? "taskOnly" : "withSubtasks");
      const actualOwn = actualByTask.get(row.node.id) ?? 0;
      const actualBranch = taskOnly ? actualOwn : sumBranchActualWithinScope(actualByTask, historicalRelations, scope, row.node.id);
      // Active rows that contribute neither planned effort nor actual hours are dropped.
      if (plan.value === undefined && actualBranch === 0) continue;
      rows.push({
        id: row.node.id,
        title: row.node.title || taskName(row.node.id),
        depth: filters.task !== "" ? row.node.depth - baseDepth : row.node.depth,
        stage: row.stage,
        plan: plan.value,
        planSource: plan.source,
        actualBranch,
        actualOwn,
        archived: false,
      });
    }
    // Historical rows: archived tasks that own time records. They are always flat (depth 0),
    // never carry a current-plan estimate, and never determine an active task's depth. They
    // only surface their accumulated actual hours so the report retains the project's history
    // without inserting archived tasks back into the active tree.
    for (const task of archivedTasksWithHistory) {
      const id = task.document.id;
      if (!scope.has(id)) continue;
      const actualOwn = actualByTask.get(id) ?? 0;
      if (actualOwn === 0) continue;
      rows.push({
        id,
        title: taskName(id),
        depth: 0,
        stage: undefined,
        plan: undefined,
        planSource: "missing",
        actualBranch: actualOwn,
        actualOwn,
        archived: true,
      });
    }
    return rows;
  }, [flattened, scope, filters.task, scopeMode, readModels, workloadTrack, actualByTask, historicalRelations, archivedTasksWithHistory, taskName]);
  const planSources: string[] = [];
  if (wholeProject && projectBudget !== undefined) {
    if (planOfWork !== undefined) planSources.push(t("actualReport.sourceRootSum"));
    planSources.push(t("actualReport.sourceProjectBudget"));
  } else if (planOfWork !== undefined) {
    if (filters.task !== "") {
      const own = taskPlanEffort(readModels, workloadTrack, filters.task, scopeMode);
      planSources.push(own.source === "declared" ? t("actualReport.sourceTaskExplicit") : own.source === "rolled" ? t("actualReport.sourceSubtaskSum") : t("actualReport.sourceMissing"));
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

  const resetAll = () => { setFilters(EMPTY_FILTERS); setScopeMode("withSubtasks"); setShowVoided(false); setCutoff(""); };
  const milestoneScopeOfTask = useCallback((taskId: string): string => {
    const raw = historicalRelations.milestoneOf.get(taskId);
    return raw !== undefined && activeMilestoneIds.has(raw) ? raw : "none";
  }, [activeMilestoneIds, historicalRelations.milestoneOf]);
  const selectMilestone = (value: string) => {
    patchFilter("milestone", value);
    // "All milestones" keeps the selected task; a specific milestone or the outside-active
    // group only keeps a task whose scope matches so the dropdown and the filter agree.
    if (value !== "" && filters.task !== "" && milestoneScopeOfTask(filters.task) !== value) patchFilter("task", "");
  };
  const selectTask = (value: string) => {
    patchFilter("task", value);
    if (value === "") return;
    // Selecting a task auto-selects its scope so the two filters cannot disagree. Tasks
    // outside every active milestone select the dedicated "outside active milestones" group.
    const milestone = milestoneScopeOfTask(value);
    if (milestone !== filters.milestone) patchFilter("milestone", milestone);
  };

  /**
   * Task-picker options narrowed by the milestone filter and grouped to mirror the plan
   * tab. Each active milestone forms its own optgroup (in canonical order); orphan tasks
   * form a trailing "outside active milestones" group. Selecting a specific milestone
   * shows only its tasks, which keeps the picker consistent with the selected scope.
   */
  const taskSelectGroups = useMemo(() => {
    type Group = { readonly label: string; readonly rows: readonly { readonly id: string; readonly title: string; readonly depth: number }[] };
    type SelectRow = { readonly id: string; readonly title: string; readonly depth: number };
    const groups: Group[] = [];
    const pushGroup = (label: string, rows: Group["rows"]): void => { if (rows.length > 0) groups.push({ label, rows }); };
    const toRow = (row: { readonly node: { readonly id: string; readonly title: string; readonly depth: number } }): SelectRow => ({ id: row.node.id, title: row.node.title || taskName(row.node.id), depth: row.node.depth });
    // Archived tasks that own time records surface as flat (depth 0) historical options alongside
    // the active tasks in the same milestone group. They never carry a nesting prefix because
    // they are not children of the current plan tree. An archived task with no history never
    // appears. History is read from the project-wide `historicalTaskIds` (Request A), not the
    // filtered display records, so a person or date filter cannot silently drop such a task.
    const archivedOption = (task: EntityResult): SelectRow => ({ id: task.document.id, title: taskName(task.document.id), depth: 0 });
    const archivedInMilestone = (milestoneId: string): readonly SelectRow[] => archivedTasksWithHistory
      .filter((task) => reader(task.document, "milestone") === milestoneId)
      .map(archivedOption);
    const archivedOutsideActive = archivedTasksWithHistory
      .filter((task) => { const m = reader(task.document, "milestone"); return m === "" || !activeMilestoneIds.has(m); })
      .map(archivedOption);
    for (const milestone of orderedMilestones) {
      // The "outside active milestones" scope renders no milestone groups at all (only the
      // trailing orphan group); a specific milestone renders only its own group.
      if (filters.milestone === "none") continue;
      if (filters.milestone !== "" && filters.milestone !== milestone.document.id) continue;
      const rows = [...flattened.filter((row) => row.stage?.document.id === milestone.document.id).map(toRow), ...archivedInMilestone(milestone.document.id)];
      pushGroup(reader(milestone.document, "name"), rows);
    }
    if (filters.milestone === "" || filters.milestone === "none") {
      const rows = [...flattened.filter((row) => row.stage === undefined).map(toRow), ...archivedOutsideActive];
      pushGroup(t("stages.withoutStage"), rows);
    }
    return groups;
  }, [flattened, filters.milestone, orderedMilestones, reader, t, taskName, archivedTasksWithHistory, activeMilestoneIds]);

  const planCellSource = (row: PlanActualRow): string => row.planSource === "declared" ? t("actualReport.cellPlanDeclared") : row.planSource === "rolled" ? t("actualReport.cellPlanRolled") : "";

  return <section className="actual-hours-report">
    <div className="actual-report-heading"><div><h4>{t("snapshot.actualReport")}</h4><p>{t("actualReport.description")}</p></div><button type="button" onClick={resetAll}>{t("actualReport.reset")}</button></div>
    <div className="actual-report-filters">
      <label>{t("actualReport.milestone")}<select value={filters.milestone} onChange={(event) => selectMilestone(event.target.value)}><option value="">{t("actualReport.allMilestones")}</option>{orderedMilestones.map((milestone) => <option key={milestone.document.id} value={milestone.document.id}>{reader(milestone.document, "name")}</option>)}<option value="none">{t("stages.withoutStage")}</option></select></label>
      <label>{t("actualReport.task")}<select value={filters.task} onChange={(event) => selectTask(event.target.value)}><option value="">{t("actualReport.allTasks")}</option>{taskSelectGroups.map((group) => <optgroup key={group.label} label={group.label}>{group.rows.map((row) => <option key={row.id} value={row.id}>{`${"\u00A0\u00A0".repeat(row.depth)}${row.title}`}</option>)}</optgroup>)}</select></label>
      <label>{t("timeEffort.person")}<select value={filters.person} onChange={(event) => patchFilter("person", event.target.value)}><option value="">{t("actualReport.allPeople")}</option>{peopleOptions.map((id) => <option key={id} value={id}>{personName(id)}</option>)}</select></label>
      <label>{t("actualReport.from")}<input type="date" value={filters.performed_from} onChange={(event) => patchFilter("performed_from", event.target.value)} /></label>
      <label>{t("actualReport.to")}<input type="date" value={filters.performed_to} onChange={(event) => patchFilter("performed_to", event.target.value)} /></label>
      <details className="actual-report-more-filters">
        <summary>{t("actualReport.additionalFilters")}</summary>
        <div className="actual-report-more-filters-grid">
          <label>{t("timeEffort.category")}<select value={filters.category} onChange={(event) => patchFilter("category", event.target.value)}><option value="">{t("actualReport.allCategories")}</option>{categoryOptions.map((slug) => <option key={slug} value={slug}>{categoryName(slug)}</option>)}</select></label>
          <label>{t("actualReport.after")}<input type="date" value={cutoff} onChange={(event) => setCutoff(event.target.value)} /></label>
          {filters.task !== "" && <label>{t("actualReport.scopeMode")}<select value={scopeMode} onChange={(event) => setScopeMode(event.target.value as EffortScopeMode)}><option value="withSubtasks">{t("actualReport.scopeWithSubtasks")}</option><option value="taskOnly">{t("actualReport.scopeTaskOnly")}</option></select></label>}
        </div>
      </details>
    </div>
    {error !== null && <div className="alert error">{error}</div>}
    {loading && <p className="empty-copy">{t("status.loading")}</p>}
    {entries !== null && <>
      <dl className="actual-report-summary">
        <div><dt>{t("snapshot.actualHours")}</dt><dd>{formatDurationHours(locale, scopeActual)}</dd></div>
        <div><dt>{t("actualReport.activeEntries")}</dt><dd>{activeCount}</dd></div>
        {scopeWindow?.start !== undefined && <div><dt>{t("timeEffort.firstActivity")}</dt><dd>{formatDateOnly(locale, scopeWindow.start)}</dd></div>}
        {scopeWindow?.finish !== undefined && <div><dt>{t("timeEffort.lastActivity")}</dt><dd>{formatDateOnly(locale, scopeWindow.finish)}</dd></div>}
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
              {planOfWork !== undefined && <div><dt>{t("actualReport.planDifference")}</dt><dd>{formatDurationHours(locale, planOfWork - projectBudget)}</dd></div>}
            </>}
            <div><dt>{filteredActualOnly ? t("actualReport.filteredActual") : t("snapshot.actualHours")}</dt><dd>{formatDurationHours(locale, scopeActual)}</dd></div>
            {!filteredActualOnly && <>
              <div><dt>{t("actualReport.variance")}</dt><dd>{planOfWork === undefined ? "—" : formatDurationHours(locale, scopeActual - planOfWork)}</dd></div>
              <div><dt>{t("actualReport.ratio")}</dt><dd>{planOfWork === undefined || planOfWork === 0 ? "—" : `${formatNumber(locale, scopeActual / planOfWork * 100)}%`}</dd></div>
            </>}
          </dl>
        </div>
        {filteredActualOnly && <p className="scope-hint">{t("actualReport.actualOnlyFilters")}</p>}
        <p className="plan-actual-disclaimer">{t("actualReport.parentRollupDisclaimer")}</p>
        {planActualRows.length === 0 ? <p className="empty-copy">{t("actualReport.empty")}</p> : <div className="actual-report-table-wrap"><table><thead><tr><th scope="col">{t("actualReport.task")}</th><th scope="col">{t("actualReport.planned")}</th><th scope="col">{t("actualReport.actual")}</th><th scope="col">{t("actualReport.ownHours")}</th><th scope="col">{t("actualReport.variance")}</th></tr></thead><tbody>{planActualGroups.map((group, groupIndex) => <Fragment key={groupIndex}>{group.rows.some((row) => row.stage !== undefined) && <tr className="actual-report-stage-row"><th scope="rowgroup" colSpan={5}>{group.stage === undefined ? t("actualReport.noMilestone") : milestoneName(group.stage.document.id)}</th></tr>}{group.rows.map((row) => <tr key={row.id} className={`actual-report-task-row${row.planSource === "rolled" ? " is-rolled" : ""}`} data-depth={row.depth} data-task-id={row.id} data-plan-source={row.planSource}><th className="actual-report-task-cell" scope="row" style={{ paddingLeft: `${0.5 + row.depth * 1.2}rem` }}><button type="button" className="actual-report-task-link" aria-label={`${row.title} ${row.id}`} onClick={() => onNavigate("tasks", { projectId, taskId: row.id })}><span>{row.title}</span>{row.archived && <span className="archived-reference"> · {t("actualReport.archivedTask")}</span>}<code>{row.id}</code></button></th><td>{row.plan === undefined ? "—" : formatDurationHours(locale, row.plan)}{planCellSource(row) !== "" && <span className="plan-cell-source">{planCellSource(row)}</span>}</td><td>{formatDurationHours(locale, row.actualBranch)}</td><td>{formatDurationHours(locale, row.actualOwn)}</td><td>{row.plan === undefined ? "—" : formatDurationHours(locale, row.actualBranch - row.plan)}</td></tr>)}</Fragment>)}</tbody></table></div>}
      </section>
      <details className="actual-breakdowns">
        <summary>{t("actualReport.breakdownsHeading")}</summary>
        <div className="actual-breakdowns-grid">
          <BreakdownTable heading={t("actualReport.byPerson")} empty={t("actualReport.empty")} hoursLabel={t("timeEffort.hours")} rows={personRows} />
          <BreakdownTable heading={t("actualReport.byCategory")} empty={t("actualReport.empty")} hoursLabel={t("timeEffort.hours")} rows={categoryRows} />
          <BreakdownTable heading={t("actualReport.byDate")} empty={t("actualReport.empty")} hoursLabel={t("timeEffort.hours")} rows={dateRows} />
        </div>
      </details>
      <section className="actual-report-correction-history">
        <label className="actual-report-show-voided">
          <input type="checkbox" checked={showVoided} onChange={(event) => setShowVoided(event.target.checked)} />
          {t("actualReport.showVoided")}
        </label>
        {showVoided && <div className="correction-history-details">
          <h5>{t("actualReport.correctionHistory")}</h5>
          <p className="correction-history-explanation">{t("actualReport.voidedExplanation")}</p>
          {voidedRecords.length === 0 ? <p className="correction-history-count">{t("actualReport.voidedNone")}</p> : <div className="actual-report-table-wrap"><table><thead><tr><th scope="col">{t("actualReport.task")}</th><th scope="col">{t("timeEffort.person")}</th><th scope="col">{t("actualReport.auditWorkDate")}</th><th scope="col">{t("timeEffort.hours")}</th><th scope="col">{t("actualReport.auditVoidedAt")}</th><th scope="col">{t("actualReport.auditVoidedBy")}</th><th scope="col">{t("actualReport.auditReplacement")}</th></tr></thead><tbody>{voidedRecords.map((entry) => <tr key={entry.document.id}><th scope="row">{taskName(entry.document.task)}</th><td>{personName(entry.document.person)}</td><td>{formatDateOnly(locale, entry.document.performed_on)}</td><td>{formatDurationHours(locale, entry.document.hours)}</td><td>{typeof entry.document.voided_at === "string" ? formatDateOnly(locale, entry.document.voided_at.slice(0, 10)) : "—"}</td><td>{actorName(entry.document.voided_by) || "—"}</td><td>{typeof entry.document.replacement === "string" ? entry.document.replacement : "—"}</td></tr>)}</tbody></table></div>}
        </div>}
      </section>
    </>}
  </section>;
}
