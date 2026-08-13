import { activeProjectIds, ENTITY_ID_PREFIX, isOperationalTask, newUniqueEntityId } from "@gitpm/shared";
import type { ProjectFileDeleteResult, ProjectFileList, ProjectFileRenameResult, ProjectFileUploadResult, ProjectPlanning } from "@gitpm/contracts";
import { resolveSchedulingHierarchy, validatePlanning, windowEffort, type PlanningSettings, type SchedulingHierarchyTask } from "@gitpm/scheduling";
import { buildSchedule, ScheduleResolver, scheduleTracksConfig, scheduleTextReader, scheduleEffortReader, withSchedulesMap, type ScheduleMap } from "../../schedules.js";
import { isBlockedStatus, isCompletedStatus, isInProgressStatus } from "../../status-categories.js";
import { ProjectScheduleSummary } from "./project-schedule-summary.js";
import { buildTaskHierarchy } from "@gitpm/task-hierarchy";
import { buildProjectArchiveViewModel, buildProjectTaskViewModel, canonicalTaskComparator, isOutsideActiveMilestone, normalizeActiveParent, normalizeActiveMilestone, type ProjectArchiveViewModel, type ProjectTaskViewModel, type TaskViewModelNode } from "./project-task-view-model.js";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ApiError, deleteRestrictionLabels, formatApiError, type GitPmApi } from "../../api.js";
import { AsyncBoundary, useAsyncLoad } from "../../async-data.js";
import { AssigneeChecks, existingProjectGroups, projectGroupFromForm, ProjectGroupField, TaskPanel, type ConfigValue } from "../../core-ui.js";
import { ProjectPlanningEditor } from "../../project-planning-editor.js";
import { ScheduleTracksEditor } from "../../schedule-tracks-editor.js";
import { EditorDrawer } from "../../editor-drawer.js";
import { EntityCatalog } from "../../entity-catalog.js";
import { useExternalHighlights, useReducedMotion } from "../../external-updates.js";
import { formatDateOnly, formatDurationHours, message, type Locale, type MessageKey } from "../../i18n.js";
import { upsertEntity, useFlipList } from "../../optimistic-ui.js";
import type { ConfigurationResult, DraftStatus, EntityDocument, EntityResult, GitPmDocument, ProjectWorkspaceResult } from "../../types.js";
import type { WorkspaceNavigate } from "../../workspace-navigation.js";
import { PersonLinks } from "../../person-link.js";
import { DraftReadOnlyAlert, draftReadOnlyReason } from "../../draft-read-only.js";
import { SchedulingOverflowWarnings } from "../../scheduling-overflow-warnings.js";
import { AdvancedViewControls } from "../../advanced-view-controls.js";
import { applyAdvancedViewQuery, countViewConditions, emptyViewQuery, filterOnlyViewQuery, newViewNodeId, parseAdvancedViewQuery, serializeAdvancedViewQuery, type AdvancedViewQuery, type ViewField, type ViewFilterNode } from "../../advanced-view-query.js";
import { ProjectFilesPanel, readProjectFilesView, type ProjectFilesView } from "./project-files-panel.js";

type TaskInsertSpec = { readonly parentId?: string; readonly beforeId?: string; readonly afterId?: string };
type PlanEditor = { readonly kind: "project" | "new-stage" }
  | { readonly kind: "edit-stage"; readonly stageId: string }
  | { readonly kind: "archive-stage" | "restore-stage"; readonly stageId: string }
  | { readonly kind: "task"; readonly stageId?: string; readonly parentId?: string; readonly beforeId?: string; readonly afterId?: string }
  | null;
type TaskField = "assignees" | "due" | "estimate" | "status";
type TaskFieldVisibility = Readonly<Record<TaskField, boolean>>;
type SummaryFilter = "all" | "completed" | "active" | "blocked" | "overdue";

const normalizeSummaryFilter = (value: string | undefined): SummaryFilter =>
  value === "completed" || value === "overdue" || value === "active" || value === "blocked" ? value
    : value === "in-progress" ? "active"
    : "all";

const isQuickOverdueCondition = (node: ViewFilterNode): boolean =>
  node.kind === "condition" && node.field === "overdue" && node.operator === "is-true";

const hasQuickOverdueFilter = (query: AdvancedViewQuery): boolean =>
  query.filter.combinator === "and" && query.filter.children.some(isQuickOverdueCondition);

const withoutQuickOverdueFilter = (query: AdvancedViewQuery): AdvancedViewQuery => {
  if (query.filter.combinator !== "and") return query;
  const children = query.filter.children.filter((child) => !isQuickOverdueCondition(child));
  if (children.length === query.filter.children.length) return query;
  const onlyChild = children.length === 1 ? children[0] : undefined;
  return { ...query, filter: onlyChild?.kind === "group" ? onlyChild : { ...query.filter, children } };
};

const withQuickOverdueFilter = (query: AdvancedViewQuery): AdvancedViewQuery => {
  if (hasQuickOverdueFilter(query)) return query;
  const condition = { kind: "condition" as const, id: newViewNodeId("condition"), field: "overdue", operator: "is-true" as const };
  return query.filter.combinator === "and"
    ? { ...query, filter: { ...query.filter, children: [...query.filter.children, condition] } }
    : { ...query, filter: { kind: "group", id: newViewNodeId("group"), combinator: "and", children: [query.filter, condition] } };
};

const localCalendarDate = (date: Date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const TASK_FIELDS_STORAGE_KEY = "gitpm.projectPlan.taskFields";
const defaultTaskFields: TaskFieldVisibility = { assignees: true, due: true, estimate: true, status: true };
const readTaskFields = (): TaskFieldVisibility => {
  try {
    const stored = JSON.parse(localStorage.getItem(TASK_FIELDS_STORAGE_KEY) ?? "{}") as Partial<Record<TaskField, unknown>>;
    return { assignees: stored.assignees !== false, due: stored.due !== false, estimate: stored.estimate !== false, status: stored.status !== false };
  } catch { return defaultTaskFields; }
};
const writeTaskFields = (fields: TaskFieldVisibility) => { try { localStorage.setItem(TASK_FIELDS_STORAGE_KEY, JSON.stringify(fields)); } catch { /* Browser storage may be unavailable. */ } };

const parentOf = (document: Readonly<Record<string, unknown>>): string | undefined => typeof document.parent === "string" ? document.parent : undefined;
const INSPECTOR_WIDTH_STORAGE_KEY = "gitpm.projectPlan.inspectorWidth";
const DEFAULT_INSPECTOR_WIDTH = 410;
const MIN_INSPECTOR_WIDTH = 340;
const MAX_INSPECTOR_WIDTH = 760;

function clampInspectorWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INSPECTOR_WIDTH;
  return Math.min(MAX_INSPECTOR_WIDTH, Math.max(MIN_INSPECTOR_WIDTH, Math.round(value)));
}

function readInspectorWidth(): number {
  if (typeof localStorage === "undefined") return DEFAULT_INSPECTOR_WIDTH;
  try {
    const value = Number(localStorage.getItem(INSPECTOR_WIDTH_STORAGE_KEY));
    return value === 0 ? DEFAULT_INSPECTOR_WIDTH : clampInspectorWidth(value);
  } catch {
    return DEFAULT_INSPECTOR_WIDTH;
  }
}

function writeInspectorWidth(value: number) { try { localStorage.setItem(INSPECTOR_WIDTH_STORAGE_KEY, String(value)); } catch { /* Browser storage may be unavailable. */ } }

interface InspectorResize {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
}
const strings = (document: Readonly<Record<string, unknown>>, key: string): string[] => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
const configValues = (document: Readonly<Record<string, unknown>>, key: "statuses" | "issue_types"): ConfigValue[] => Array.isArray(document[key])
  ? (document[key] as unknown[]).filter((item): item is ConfigValue => typeof item === "object" && item !== null && typeof (item as ConfigValue).slug === "string" && typeof (item as ConfigValue).title === "string" && (item as ConfigValue).active === true)
  : [];
const moveId = (ids: readonly string[], id: string, offset: -1 | 1): string[] | null => {
  const from = ids.indexOf(id); const to = from + offset;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids]; [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
};
type PlanHierarchyPayload = { readonly id: string; readonly parent?: string; readonly entity: EntityResult };
type PayloadCompare = (left: PlanHierarchyPayload, right: PlanHierarchyPayload) => number;
const taskHierarchy = (tasks: readonly EntityResult[], order: readonly string[] = [], compare?: PayloadCompare) => buildTaskHierarchy<PlanHierarchyPayload>(
  tasks.map((entity) => ({ id: entity.document.id, parent: parentOf(entity.document), entity })),
  { ...(order.length === 0 ? {} : { order }), ...(compare === undefined ? {} : { compare }) },
);
const buildInsertedTaskOrder = (tasks: readonly EntityResult[], order: readonly string[], newId: string, compare: PayloadCompare | undefined, beforeId?: string, afterId?: string): string[] => {
  const hierarchy = taskHierarchy(tasks, order, compare);
  const depthFirst = hierarchy.flatten().map((entry) => entry.task.id);
  let insertAt = depthFirst.length;
  if (beforeId !== undefined) {
    const index = depthFirst.indexOf(beforeId);
    if (index >= 0) insertAt = index;
  } else if (afterId !== undefined) {
    const index = depthFirst.indexOf(afterId);
    if (index >= 0) {
      const descendants = new Set(hierarchy.descendantsOf(afterId).map((task) => task.id));
      let end = index + 1;
      while (end < depthFirst.length && descendants.has(depthFirst[end]!)) end++;
      insertAt = end;
    }
  }
  return [...depthFirst.slice(0, insertAt), newId, ...depthFirst.slice(insertAt)];
};

export function ProjectPlanWorkspace({ api, draft, locale, projectId, selectedStageId = "", selectedTaskId = "", initialStatusFilter = "", initialMilestoneFilter = "", initialSummaryFilter = "", initialAdvancedQuery, initialArchiveMode = false, onNavigate, onChanged, confirmAction = () => true }: {
  readonly api: GitPmApi;
  readonly draft: DraftStatus;
  readonly locale: Locale;
  readonly projectId: string;
  readonly selectedStageId?: string;
  readonly selectedTaskId?: string;
  readonly initialStatusFilter?: string;
  readonly initialMilestoneFilter?: string;
  readonly initialSummaryFilter?: string;
  readonly initialAdvancedQuery?: string;
  readonly initialArchiveMode?: boolean;
  readonly onNavigate: WorkspaceNavigate;
  readonly onChanged: () => Promise<void>;
  readonly confirmAction?: (message: string) => boolean;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const loader = useAsyncLoad();
  const { state: filesLoadState, run: runFilesLoad } = useAsyncLoad();
  const [workspace, setWorkspace] = useState<ProjectWorkspaceResult | null>(null);
  const [projectFiles, setProjectFiles] = useState<ProjectFileList | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesView, setFilesView] = useState<ProjectFilesView>(readProjectFilesView);
  const [projects, setProjects] = useState<readonly EntityResult[]>([]);
  const [availableProjectGroups, setAvailableProjectGroups] = useState<readonly string[]>([]);
  const [people, setPeople] = useState<readonly EntityResult[]>([]);
  const [statuses, setStatuses] = useState<readonly ConfigValue[]>([]);
  const [types, setTypes] = useState<readonly ConfigValue[]>([]);
  const [tracksConfig, setTracksConfig] = useState<ConfigurationResult | null>(null);
  const [editor, setEditor] = useState<PlanEditor>(null);
  const [projectPlanningDraft, setProjectPlanningDraft] = useState<ProjectPlanning | undefined>(undefined);
  const [projectPlanningDirty, setProjectPlanningDirty] = useState(false);
  const [projectSchedulesDraft, setProjectSchedulesDraft] = useState<ScheduleMap | undefined>(undefined);
  const [stageSchedulesDraft, setStageSchedulesDraft] = useState<ScheduleMap | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState(initialStatusFilter);
  const [milestoneFilter, setMilestoneFilter] = useState(initialMilestoneFilter);
  const [summaryFilter, setSummaryFilter] = useState<SummaryFilter>(normalizeSummaryFilter(initialSummaryFilter));
  const [advancedQuery, setAdvancedQuery] = useState<AdvancedViewQuery>(() => emptyViewQuery());
  const [archiveMode, setArchiveMode] = useState(initialArchiveMode);
  const [taskFields, setTaskFields] = useState<TaskFieldVisibility>(readTaskFields);
  const [error, setError] = useState<string | null>(null);
  const [orderPending, setOrderPending] = useState<readonly string[] | null>(null);
  const [statusPending, setStatusPending] = useState<string | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(readInspectorWidth);
  const [inspectorResize, setInspectorResize] = useState<InspectorResize | null>(null);
  const { highlights: recentChanges, mark: markRecentChange } = useExternalHighlights(500);
  const reducedMotion = useReducedMotion();
  const animatedList = useFlipList(reducedMotion);
  const readOnly = draftReadOnlyReason(draft) !== null;
  const inspectorPaneRef = useRef<HTMLElement | null>(null);

  const scheduling = useMemo(() => new ScheduleResolver(scheduleTracksConfig(tracksConfig?.document)), [tracksConfig]);
  const rawProjectPlanning = workspace?.project.document.planning as ProjectPlanning | undefined;
  const primaryTrack = scheduling.primaryTrack(rawProjectPlanning);
  const projectEditorPlanning = projectPlanningDraft ?? scheduling.planning(rawProjectPlanning);
  const projectEditorManualTracks = scheduling.manualTracks(projectEditorPlanning);
  const projectEditorActualTrack = scheduling.actualTrack(projectEditorPlanning);
  const stageManualTracks = scheduling.manualTracks(workspace?.project.document.planning);
  const stageActualTrack = scheduling.actualTrack(workspace?.project.document.planning);
  const text = useMemo(() => scheduleTextReader(primaryTrack), [primaryTrack]);
  const effortOf = useMemo(() => scheduleEffortReader(primaryTrack), [primaryTrack]);
  const number = useMemo(() => (document: Readonly<Record<string, unknown>>, key: string): number | undefined => key === "estimate_hours" ? effortOf(document) : typeof document[key] === "number" ? document[key] as number : undefined, [effortOf]);
  const usedProjectScheduleTracks = useMemo(() => {
    const used = new Set<string>();
    const collect = (schedules: unknown): void => {
      if (schedules === null || typeof schedules !== "object" || Array.isArray(schedules)) return;
      for (const [slug, window] of Object.entries(schedules)) {
        if (window !== null && typeof window === "object" && !Array.isArray(window) && Object.keys(window).length > 0) used.add(slug);
      }
    };
    collect(projectSchedulesDraft);
    for (const milestone of workspace?.milestones ?? []) collect(milestone.document.schedules);
    for (const task of workspace?.tasks ?? []) collect(task.document.schedules);
    return used;
  }, [projectSchedulesDraft, workspace]);

  const load = useCallback(async () => {
    await loader.run(async () => {
      const [nextWorkspace, nextProjects, nextPeople, statusConfig, typeConfig, tracksDocument] = await Promise.all([
        api.projectWorkspace(draft.draft_id, projectId),
        api.listEntities(draft.draft_id, "projects"),
        api.listEntities(draft.draft_id, "people"),
        api.getConfiguration(draft.draft_id, "statuses"),
        api.getConfiguration(draft.draft_id, "issue-types"),
        api.getConfiguration(draft.draft_id, "schedule-tracks"),
      ]);
      return { nextWorkspace, nextProjects, nextPeople, statusConfig, typeConfig, tracksDocument };
    }, ({ nextWorkspace, nextProjects, nextPeople, statusConfig, typeConfig, tracksDocument }) => {
      setWorkspace(nextWorkspace);
      setProjects(nextProjects.filter((item) => item.document.lifecycle === "active"));
      setAvailableProjectGroups(existingProjectGroups(nextProjects, locale));
      setPeople(nextPeople.filter((item) => item.document.lifecycle === "active"));
      setStatuses(configValues(statusConfig.document, "statuses"));
      setTypes(configValues(typeConfig.document, "issue_types"));
      setTracksConfig(tracksDocument);
    });
  }, [api, draft.draft_id, draft.fingerprint, loader.run, locale, projectId]);

  const loadProjectFiles = useCallback(async (keepData = true) => {
    if (!keepData) setProjectFiles(null);
    await runFilesLoad(
      async () => await api.listProjectFiles(draft.draft_id, projectId),
      setProjectFiles,
      { keepData },
    );
  }, [api, draft.draft_id, projectId, runFilesLoad]);

  const handleProjectFileUploaded = useCallback((result: ProjectFileUploadResult) => {
    setProjectFiles((current) => {
      if (current === null) return { project_id: result.project_id, count: 1, total_size_bytes: result.item.size_bytes, items: [result.item], draft_fingerprint: result.draft_fingerprint };
      const previous = current.items.find((item) => item.name === result.item.name);
      const items = previous === undefined ? [...current.items, result.item] : current.items.map((item) => item.name === result.item.name ? result.item : item);
      return {
        ...current,
        count: items.length,
        total_size_bytes: current.total_size_bytes - (previous?.size_bytes ?? 0) + result.item.size_bytes,
        items,
        draft_fingerprint: result.draft_fingerprint,
      };
    });
    setWorkspace((current) => current === null ? current : { ...current, draft_fingerprint: result.draft_fingerprint });
    void onChanged();
  }, [onChanged]);

  const handleProjectFileRenamed = useCallback((result: ProjectFileRenameResult) => {
    setProjectFiles((current) => current === null ? current : {
      ...current,
      total_size_bytes: current.total_size_bytes - (current.items.find((item) => item.name === result.previous_name)?.size_bytes ?? 0) + result.item.size_bytes,
      items: current.items.map((item) => item.name === result.previous_name ? result.item : item),
      draft_fingerprint: result.draft_fingerprint,
    });
    setWorkspace((current) => current === null ? current : { ...current, draft_fingerprint: result.draft_fingerprint });
    void onChanged();
  }, [onChanged]);

  const handleProjectFileDeleted = useCallback((result: ProjectFileDeleteResult) => {
    setProjectFiles((current) => {
      if (current === null) return current;
      const items = current.items.filter((item) => item.name !== result.name);
      return { ...current, count: items.length, total_size_bytes: Math.max(0, current.total_size_bytes - result.size_bytes), items, draft_fingerprint: result.draft_fingerprint };
    });
    setWorkspace((current) => current === null ? current : { ...current, draft_fingerprint: result.draft_fingerprint });
    void onChanged();
  }, [onChanged]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadProjectFiles(false); }, [loadProjectFiles]);
  useEffect(() => { const summary = normalizeSummaryFilter(initialSummaryFilter); setStatusFilter(initialStatusFilter); setMilestoneFilter(initialMilestoneFilter); setSummaryFilter(summary === "overdue" ? "all" : summary); setArchiveMode(initialArchiveMode); }, [initialArchiveMode, initialMilestoneFilter, initialStatusFilter, initialSummaryFilter]);
  useEffect(() => { writeTaskFields(taskFields); }, [taskFields]);
  useEffect(() => { writeInspectorWidth(inspectorWidth); }, [inspectorWidth]);

  const beginInspectorResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const inspector = inspectorPaneRef.current;
    if (inspector === null) return;
    const startWidth = inspector.getBoundingClientRect().width;
    if (startWidth <= 0) return;
    event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer capture unavailable */ }
    setInspectorResize({ pointerId: event.pointerId, startX: event.clientX, startWidth });
  };

  const moveInspectorResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (inspectorResize === null || event.pointerId !== inspectorResize.pointerId) return;
    setInspectorWidth(clampInspectorWidth(inspectorResize.startWidth - (event.clientX - inspectorResize.startX)));
  };

  const endInspectorResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (inspectorResize === null || event.pointerId !== inspectorResize.pointerId) return;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer capture unavailable */ }
    setInspectorResize(null);
  };

  const resizeInspectorByKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const step = event.shiftKey ? 40 : 16;
      setInspectorWidth((current) => clampInspectorWidth(current + (event.key === "ArrowLeft" ? step : -step)));
    } else if (event.key === "Home") {
      event.preventDefault();
      setInspectorWidth(MIN_INSPECTOR_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      setInspectorWidth(MAX_INSPECTOR_WIDTH);
    } else if (event.key === "Enter") {
      event.preventDefault();
      setInspectorWidth(DEFAULT_INSPECTOR_WIDTH);
    }
  };

  const applyResult = (result: EntityResult) => {
    setWorkspace((current) => {
      if (current === null) return current;
      const schema = result.document.schema;
      if (result.document.id === current.project.document.id || schema === "gitpm/project@2") return { ...current, project: result, draft_fingerprint: result.draft_fingerprint };
      if (schema === "gitpm/milestone@2") return { ...current, milestones: upsertEntity(current.milestones, result), draft_fingerprint: result.draft_fingerprint };
      if (schema === "gitpm/task@2") return { ...current, tasks: upsertEntity(current.tasks, result), draft_fingerprint: result.draft_fingerprint };
      return current;
    });
  };

  const markResult = (highlightIds: string | readonly string[]) => {
    const changes: Record<string, readonly string[]> = {};
    for (const id of typeof highlightIds === "string" ? [highlightIds] : highlightIds) changes[id] = ["$entity"];
    markRecentChange(changes);
  };

  const mutate = async (operation: () => Promise<EntityResult>, highlightIds?: string | readonly string[]) => {
    setError(null);
    try {
      const result = await operation();
      applyResult(result);
      markResult(highlightIds ?? result.document.id);
      await onChanged();
      await load();
      setEditor(null);
      return true;
    } catch (caught) {
      setError(formatApiError(caught));
      return false;
    }
  };

  const saveEntity = async (operation: () => Promise<EntityResult>): Promise<EntityResult | null> => {
    setError(null);
    try {
      const result = await operation();
      applyResult(result);
      markResult(result.document.id);
      await onChanged();
      await load();
      return result;
    } catch (caught) {
      setError(formatApiError(caught));
      return null;
    }
  };

  const removeEntity = async (operation: () => Promise<void>): Promise<boolean> => {
    setError(null);
    try {
      await operation();
      await onChanged();
      await load();
      return true;
    } catch (caught) {
      setError(formatApiError(caught));
      return false;
    }
  };

  const activeTasks = useMemo(
    () => (workspace?.tasks.filter((item) => isOperationalTask(item.document, activeProjectIds([workspace.project.document]))) ?? []),
    [workspace],
  );
  const archivedMilestoneIds = useMemo(() => new Set((workspace?.milestones ?? [])
    .filter((milestone) => milestone.document.lifecycle === "archived")
    .map((milestone) => milestone.document.id)), [workspace]);
  const currentPlanTasks = useMemo(() => activeTasks.filter((task) => !archivedMilestoneIds.has(text(task.document, "milestone"))), [activeTasks, archivedMilestoneIds, text]);
  const today = localCalendarDate();
  const peopleOptions = useMemo(() => people.map((person) => ({ value: person.document.id, label: text(person.document, "name") })), [people, text]);
  const taskAdvancedFields = useMemo<readonly ViewField<EntityResult>[]>(() => [
    { id: "id", label: t("advancedView.field.id"), type: "text", read: (item) => item.document.id },
    { id: "title", label: t("advancedView.field.title"), type: "text", read: (item) => text(item.document, "title") },
    { id: "status", label: t("advancedView.field.status"), type: "select", options: statuses.map((status) => ({ value: status.slug, label: status.title })), read: (item) => text(item.document, "status") },
    { id: "type", label: t("advancedView.field.type"), type: "select", options: types.map((type) => ({ value: type.slug, label: type.title })), read: (item) => text(item.document, "type") },
    { id: "milestone", label: t("advancedView.field.milestone"), type: "select", options: (workspace?.milestones ?? []).map((milestone) => ({ value: milestone.document.id, label: text(milestone.document, "name") })), read: (item) => text(item.document, "milestone") },
    { id: "assignees", label: t("advancedView.field.assignees"), type: "multi-select", options: peopleOptions, read: (item) => strings(item.document, "assignees") },
    { id: "start", label: t("advancedView.field.start"), type: "date", read: (item) => text(item.document, "start") },
    { id: "due", label: t("advancedView.field.due"), type: "date", read: (item) => text(item.document, "due") },
    { id: "estimate", label: t("advancedView.field.estimate"), type: "number", read: (item) => effortOf(item.document) },
    { id: "overdue", label: t("advancedView.field.overdue"), type: "boolean", read: (item) => { const due = text(item.document, "due"); return /^\d{4}-\d{2}-\d{2}$/u.test(due) && due < today && !isCompletedStatus(statuses, text(item.document, "status")); } },
  ], [effortOf, locale, peopleOptions, statuses, text, today, types, workspace]);
  useEffect(() => {
    const parsed = filterOnlyViewQuery(parseAdvancedViewQuery(initialAdvancedQuery, taskAdvancedFields));
    const next = normalizeSummaryFilter(initialSummaryFilter) === "overdue" ? withQuickOverdueFilter(parsed) : parsed;
    setAdvancedQuery(next);
    if (hasQuickOverdueFilter(next)) setSummaryFilter("all");
  }, [initialAdvancedQuery, initialSummaryFilter, taskAdvancedFields]);
  const advancedEvaluationQuery = useMemo(() => withoutQuickOverdueFilter(advancedQuery), [advancedQuery]);
  const advancedTasks = useMemo(() => applyAdvancedViewQuery(currentPlanTasks, taskAdvancedFields, advancedEvaluationQuery, locale), [advancedEvaluationQuery, currentPlanTasks, locale, taskAdvancedFields]);
  const taskCompare = useMemo(() => canonicalTaskComparator(locale, text), [locale, text]);
  const hierarchyCompare = useMemo<PayloadCompare>(() => { const compare = taskCompare; return (left, right) => compare(left.entity, right.entity); }, [taskCompare]);
  const taskViewModel = useMemo<ProjectTaskViewModel>(() => workspace === null
    ? { stages: [], system: { kind: "system", roots: [] } }
    : buildProjectTaskViewModel({ project: workspace.project, milestones: workspace.milestones, tasks: currentPlanTasks, text, effortOf, locale, compareTasks: taskCompare }),
    [currentPlanTasks, effortOf, locale, taskCompare, text, workspace]);
  const archiveViewModel = useMemo<ProjectArchiveViewModel>(() => workspace === null
    ? { stages: [], tasks: { kind: "system", roots: [] } }
    : buildProjectArchiveViewModel({ project: workspace.project, milestones: workspace.milestones, tasks: workspace.tasks, text, effortOf, locale, compareTasks: taskCompare }),
    [effortOf, locale, taskCompare, text, workspace]);
  const activeStages = taskViewModel.stages.map((group) => group.milestone);
  const stageRootsById = new Map(taskViewModel.stages.map((group) => [group.milestone.document.id, group.roots] as const));
  const systemRoots = taskViewModel.system.roots;
  const statusTitle = (slug: string) => statuses.find((item) => item.slug === slug)?.title ?? slug;
  const dateLabel = (value: string) => /^\d{4}-\d{2}-\d{2}$/u.test(value) ? formatDateOnly(locale, value) : "—";
  const selectedStage = workspace?.milestones.find((item) => item.document.id === selectedStageId);
  const activeStageIds = new Set(activeStages.map((stage) => stage.document.id));
  // The current scheduling hierarchy is built from ACTIVE tasks and ACTIVE milestones only.
  // Both `parent` and `milestone` are normalized against the active sets so a task pointing at a
  // non-existent, archived, deleted, or self-referential parent becomes a root of its active
  // milestone (or of the project rollup) instead of disappearing from the aggregated deadline,
  // the overflow warnings, the plan estimate, or the root-task list. Source documents are never
  // mutated — only this computed view-model value is normalized.
  const activeTaskIds = new Set(currentPlanTasks.map((task) => task.document.id));
  const schedulingHierarchy = resolveSchedulingHierarchy({
    project: workspace?.project.document,
    milestones: activeStages.map((stage) => stage.document),
    tasks: currentPlanTasks.map((task): SchedulingHierarchyTask => ({
      ...task.document,
      parent: normalizeActiveParent(activeTaskIds, task.document.id, typeof task.document.parent === "string" && task.document.parent !== "" ? task.document.parent : undefined),
      milestone: normalizeActiveMilestone(activeStageIds, typeof task.document.milestone === "string" ? task.document.milestone : ""),
    })),
    tracks: primaryTrack === "" ? [] : [primaryTrack],
  });
  const outsideStages = currentPlanTasks.filter((task) => {
    const milestoneId = text(task.document, "milestone");
    return isOutsideActiveMilestone(activeStageIds, milestoneId);
  });
  const summaryScopeTasks = milestoneFilter === ""
    ? advancedTasks
    : milestoneFilter === "none"
      ? advancedTasks.filter((task) => isOutsideActiveMilestone(activeStageIds, text(task.document, "milestone")))
      : advancedTasks.filter((task) => text(task.document, "milestone") === milestoneFilter);
  const overdueTaskIds = new Set<string>();
  for (const task of summaryScopeTasks) {
    const finish = schedulingHierarchy.readModels.get(task.document.id)?.tracks[0]?.effective?.finish;
    if (typeof finish !== "string" || finish >= today) continue;
    if (isCompletedStatus(statuses, text(task.document, "status"))) continue;
    overdueTaskIds.add(task.document.id);
  }
  const completedCount = summaryScopeTasks.filter((task) => isCompletedStatus(statuses, text(task.document, "status"))).length;
  // "В работе" counts only direct-execution status (the in-progress semantic). The broad
  // `active` category is intentionally avoided because it also covers review and other
  // non-execution states; blocked is counted by its own metric below.
  const inProgressCount = summaryScopeTasks.filter((task) => isInProgressStatus(statuses, text(task.document, "status"))).length;
  const blockedCount = summaryScopeTasks.filter((task) => isBlockedStatus(statuses, text(task.document, "status"))).length;
  const overdueCount = overdueTaskIds.size;
  const effectiveSummaryFilter: SummaryFilter = hasQuickOverdueFilter(advancedQuery) ? "overdue" : summaryFilter;
  const visibleTasks = useMemo(() => advancedTasks.filter((task) =>
    (statusFilter === "" || text(task.document, "status") === statusFilter)
    && (milestoneFilter === "" || (milestoneFilter === "none" ? isOutsideActiveMilestone(activeStageIds, text(task.document, "milestone")) : text(task.document, "milestone") === milestoneFilter))
    && (effectiveSummaryFilter === "all"
      || (effectiveSummaryFilter === "completed" && isCompletedStatus(statuses, text(task.document, "status")))
      || (effectiveSummaryFilter === "active" && isInProgressStatus(statuses, text(task.document, "status")))
      || (effectiveSummaryFilter === "blocked" && isBlockedStatus(statuses, text(task.document, "status")))
      || (effectiveSummaryFilter === "overdue" && overdueTaskIds.has(task.document.id)))), [advancedTasks, activeStageIds, effectiveSummaryFilter, milestoneFilter, overdueTaskIds, statusFilter, statuses, text]);
  const filterActive = effectiveSummaryFilter !== "all" || statusFilter !== "" || countViewConditions(advancedQuery.filter) > 0;
  const visibleStages = (milestoneFilter === "" ? activeStages : activeStages.filter((stage) => stage.document.id === milestoneFilter))
    .filter((stage) => !filterActive || visibleTasks.some((task) => task.document.milestone === stage.document.id));
  const visibleOutsideStages = visibleTasks.filter((task) => {
    const milestoneId = text(task.document, "milestone");
    return !archivedMilestoneIds.has(milestoneId) && !activeStageIds.has(milestoneId);
  });
  const navigationQuery = {
    ...(archiveMode ? { archive: ["1"] } : {}),
    ...(statusFilter ? { status: [statusFilter] } : {}),
    ...(milestoneFilter ? { milestone: [milestoneFilter] } : {}),
    ...(summaryFilter !== "all" ? { summary: [summaryFilter] } : {}),
    ...(countViewConditions(advancedQuery.filter) > 0 ? { filters: [serializeAdvancedViewQuery(advancedQuery)] } : {}),
  };
  const archivedStageTasks = archiveViewModel.stages.flatMap((group) => workspace?.tasks.filter((task) => task.document.milestone === group.milestone.document.id) ?? []);
  const standaloneArchivedTasks = workspace?.tasks.filter((task) => task.document.lifecycle === "archived" && !archivedMilestoneIds.has(text(task.document, "milestone"))) ?? [];
  const archivedContentCount = archivedStageTasks.length + standaloneArchivedTasks.length;
  const selectedStageTrack = selectedStage === undefined
    ? undefined
    : schedulingHierarchy.readModels.get(selectedStage.document.id)?.tracks[0];
  const selectedStageWarnings = selectedStage === undefined ? [] : schedulingHierarchy.readModels.get(selectedStage.document.id)?.overflowWarnings ?? [];
  const selectedStageEstimate = windowEffort(selectedStageTrack?.rolled);
  const selectedStageDue = typeof selectedStageTrack?.effective?.finish === "string" ? selectedStageTrack.effective.finish : undefined;
  const selectedTask = workspace?.tasks.find((item) => item.document.id === selectedTaskId);
  const newTaskAssignees = editor?.kind === "task" && editor.parentId !== undefined
    ? strings(workspace?.tasks.find((item) => item.document.id === editor.parentId)?.document ?? {}, "assignees")
    : [];
  const catalog = useMemo(() => new EntityCatalog({ projects, milestones: workspace?.milestones ?? [], tasks: workspace?.tasks ?? [] }), [projects, workspace]);
  const closeInspector = () => onNavigate("projects", { projectId, ...(Object.keys(navigationQuery).length > 0 ? { query: navigationQuery } : {}) });
  const showArchive = (show: boolean) => {
    setArchiveMode(show);
    setStatusFilter(""); setMilestoneFilter(""); setSummaryFilter("all");
    setAdvancedQuery(emptyViewQuery());
    onNavigate("projects", { projectId, ...(show ? { query: { archive: ["1"] } } : {}) });
  };
  const applyFilters = (status: string, milestone: string, summary: SummaryFilter) => {
    const nextAdvancedQuery = summary === "overdue" ? withQuickOverdueFilter(advancedQuery) : withoutQuickOverdueFilter(advancedQuery);
    setStatusFilter(status);
    setMilestoneFilter(milestone);
    setSummaryFilter(summary === "overdue" ? "all" : summary);
    setAdvancedQuery(nextAdvancedQuery);
    const query = {
      ...(status ? { status: [status] } : {}),
      ...(milestone ? { milestone: [milestone] } : {}),
      ...(summary !== "all" && summary !== "overdue" ? { summary: [summary] } : {}),
      ...(countViewConditions(nextAdvancedQuery.filter) > 0 ? { filters: [serializeAdvancedViewQuery(nextAdvancedQuery)] } : {}),
    };
    onNavigate("projects", { projectId, ...(Object.keys(query).length > 0 ? { query } : {}) });
  };
  const toggleSummary = (next: SummaryFilter) => applyFilters("", milestoneFilter, effectiveSummaryFilter === next ? "all" : next);
  const resetFilters = () => { setAdvancedQuery(emptyViewQuery()); setStatusFilter(""); setMilestoneFilter(""); setSummaryFilter("all"); onNavigate("projects", { projectId }); };
  const applyAdvancedQuery = (next: AdvancedViewQuery) => {
    const filterQuery = filterOnlyViewQuery(next);
    const nextSummaryFilter = hasQuickOverdueFilter(filterQuery) ? "all" : summaryFilter;
    setAdvancedQuery(filterQuery);
    setSummaryFilter(nextSummaryFilter);
    const query = {
      ...(statusFilter ? { status: [statusFilter] } : {}),
      ...(milestoneFilter ? { milestone: [milestoneFilter] } : {}),
      ...(nextSummaryFilter !== "all" ? { summary: [nextSummaryFilter] } : {}),
      ...(countViewConditions(filterQuery.filter) > 0 ? { filters: [serializeAdvancedViewQuery(filterQuery)] } : {}),
    };
    onNavigate("projects", { projectId, ...(Object.keys(query).length > 0 ? { query } : {}) });
  };
  const summaryMetricLabel = (value: SummaryFilter): string => value === "completed" ? t("projectPlan.summaryCompleted")
    : value === "active" ? t("projectPlan.summaryActive")
    : value === "blocked" ? t("projectPlan.summaryBlocked")
    : value === "overdue" ? t("projectPlan.summaryOverdue")
    : t("projectPlan.filterAll");
  const milestoneChipLabel = (value: string): string => {
    if (value === "none") return t("stages.withoutStage");
    const stage = activeStages.find((item) => item.document.id === value);
    return stage === undefined ? value : text(stage.document, "name");
  };
  const moveStage = (stageId: string, offset: -1 | 1) => {
    if (workspace === null || orderPending !== null || statusPending !== null) return;
    const stageIds = activeStages.map((stage) => stage.document.id);
    const milestoneOrder = moveId(stageIds, stageId, offset);
    if (milestoneOrder === null) return;
    const swappedStageId = stageIds[stageIds.indexOf(stageId) + offset]!;
    const previous = workspace;
    const document = { ...workspace.project.document, milestone_order: milestoneOrder } as EntityDocument;
    setOrderPending([stageId, swappedStageId]);
    setWorkspace({ ...workspace, project: { ...workspace.project, document } });
    void mutate(async () => { const result = await api.updateEntity(draft.draft_id, "projects", previous.project, previous.draft_fingerprint, document); setOrderPending(null); return result; }, [stageId, swappedStageId])
      .then((success) => { if (!success) setWorkspace(previous); })
      .finally(() => setOrderPending(null));
  };
  const moveTask = (stage: EntityResult, taskId: string, offset: -1 | 1) => {
    if (workspace === null || orderPending !== null || statusPending !== null) return;
    const stageTasks = currentPlanTasks.filter((task) => text(task.document, "milestone") === stage.document.id);
    const hierarchy = taskHierarchy(stageTasks, strings(stage.document, "task_order"), hierarchyCompare);
    const selected = hierarchy.tasks.get(taskId);
    if (selected === undefined) return;
    const siblings = hierarchy.childrenOf(selected.parent);
    const siblingIds = siblings.map((task) => task.id);
    const swappedSiblingIds = moveId(siblingIds, taskId, offset);
    if (swappedSiblingIds === null) return;
    const swappedTaskId = siblingIds[siblingIds.indexOf(taskId) + offset]!;
    const taskOrder: string[] = [];
    const visit = (id: string) => {
      taskOrder.push(id);
      const childIds = id === selected.parent
        ? swappedSiblingIds
        : hierarchy.childrenOf(id).map((task) => task.id);
      for (const childId of childIds) visit(childId);
    };
    const rootIds = selected.parent === undefined
      ? swappedSiblingIds
      : hierarchy.childrenOf().map((task) => task.id);
    for (const rootId of rootIds) visit(rootId);
    const previous = workspace;
    const document = { ...stage.document, task_order: taskOrder } as EntityDocument;
    setOrderPending([taskId, swappedTaskId]);
    setWorkspace({ ...workspace, milestones: workspace.milestones.map((item) => item.document.id === stage.document.id ? { ...item, document } : item) });
    void mutate(async () => { const result = await api.updateEntity(draft.draft_id, "milestones", stage, previous.draft_fingerprint, document); setOrderPending(null); return result; }, [taskId, swappedTaskId])
      .then((success) => { if (!success) setWorkspace(previous); })
      .finally(() => setOrderPending(null));
  };
  const changeTaskStatus = (task: EntityResult, status: string) => {
    if (workspace === null || orderPending !== null || statusPending !== null || text(task.document, "status") === status) return;
    const previous = workspace;
    const document = { ...task.document, status } as EntityDocument;
    setStatusPending(task.document.id);
    setWorkspace({ ...workspace, tasks: workspace.tasks.map((item) => item.document.id === task.document.id ? { ...item, document } : item) });
    void mutate(async () => { const result = await api.updateEntity(draft.draft_id, "tasks", task, previous.draft_fingerprint, document); setStatusPending(null); return result; }, task.document.id)
      .then((success) => { if (!success) setWorkspace(previous); })
      .finally(() => setStatusPending(null));
  };

  const updateProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (workspace === null) return;
    const data = new FormData(event.currentTarget);
    const owner = String(data.get("owner"));
    const selectedGroup = projectGroupFromForm(data, availableProjectGroups);
    if (!selectedGroup.valid) {
      if (selectedGroup.duplicate) setError(t("core.groupAlreadyExists"));
      return;
    }
    if (scheduling.raw !== null) {
      const planningIssues = validatePlanning(scheduling.raw, projectEditorPlanning as PlanningSettings);
      if (planningIssues.length > 0) {
        setError(planningIssues[0]!.message);
        return;
      }
    }
    const document = withSchedulesMap({
      ...workspace.project.document,
      name: String(data.get("name")).trim(),
      status: String(data.get("status")),
      description_markdown: String(data.get("description")),
      owner: owner || undefined,
      ...(projectPlanningDirty && projectPlanningDraft !== undefined ? { planning: projectPlanningDraft } : {}),
    }, projectSchedulesDraft) as EntityDocument;
    const writableDocument = document as unknown as Record<string, unknown>;
    if (selectedGroup.group === "") delete writableDocument.group;
    else writableDocument.group = selectedGroup.group;
    void mutate(async () => await api.updateEntity(draft.draft_id, "projects", workspace.project, workspace.draft_fingerprint, document));
  };

  const createStage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (workspace === null) return;
    const data = new FormData(event.currentTarget);
    const id = newUniqueEntityId(ENTITY_ID_PREFIX.milestone, new Set(workspace.milestones.map((item) => item.document.id)));
    const document = { schema: "gitpm/milestone@2", id, project: projectId, name: String(data.get("name")).trim(), lifecycle: "active", description_markdown: String(data.get("description")), ...(buildSchedule(primaryTrack, "", String(data.get("due") ?? ""), "") ? { schedules: buildSchedule(primaryTrack, "", String(data.get("due") ?? ""), "") } : {}) } as EntityDocument;
    void mutate(async () => await api.createEntity(draft.draft_id, "milestones", workspace.draft_fingerprint, document));
  };

  const updateStage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (workspace === null || editor?.kind !== "edit-stage") return;
    const stage = workspace.milestones.find((item) => item.document.id === editor.stageId);
    if (stage === undefined) return;
    const data = new FormData(event.currentTarget);
    const document = withSchedulesMap({ ...stage.document, name: String(data.get("name")).trim(), description_markdown: String(data.get("description")) }, stageSchedulesDraft) as EntityDocument;
    void mutate(async () => await api.updateEntity(draft.draft_id, "milestones", stage, workspace.draft_fingerprint, document));
  };

  const openStageEditor = (stage: EntityResult) => {
    setStageSchedulesDraft(stage.document.schedules as ScheduleMap | undefined);
    setEditor({ kind: "edit-stage", stageId: stage.document.id });
  };

  const transitionStage = (stage: EntityResult, action: "archive" | "restore", includeTasks: boolean) => {
    if (workspace === null) return;
    const operation = action === "archive" ? api.archiveEntity.bind(api) : api.restoreEntity.bind(api);
    void mutate(async () => await operation(draft.draft_id, "milestones", stage, workspace.draft_fingerprint, { includeTasks }))
      .then((success) => { if (success !== null) { setEditor(null); closeInspector(); } });
  };

  const createTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (workspace === null || editor?.kind !== "task") return;
    const data = new FormData(event.currentTarget);
    const id = newUniqueEntityId(ENTITY_ID_PREFIX.task, new Set(workspace.tasks.map((item) => item.document.id)));
    const start = String(data.get("start")); const due = String(data.get("due")); const estimate = String(data.get("estimate"));
    const priorWorkspace = workspace;
    const document = {
      schema: "gitpm/task@2", id, project: projectId, title: String(data.get("title")).trim(), type: String(data.get("type")), status: String(data.get("status")), lifecycle: "active",
      description_markdown: String(data.get("description")),
      assignees: data.getAll("assignees").map(String),
      ...(editor.parentId === undefined ? {} : { parent: editor.parentId }),
      ...(editor.stageId === undefined ? {} : { milestone: editor.stageId }),
      ...(buildSchedule(primaryTrack, start, due, estimate) ? { schedules: buildSchedule(primaryTrack, start, due, estimate) } : {}),
    } as EntityDocument;
    const reorder = editor.stageId !== undefined && (editor.beforeId !== undefined || editor.afterId !== undefined)
      ? { stageId: editor.stageId, beforeId: editor.beforeId, afterId: editor.afterId }
      : null;
    void mutate(async () => {
      const created = await api.createEntity(draft.draft_id, "tasks", priorWorkspace.draft_fingerprint, document);
      applyResult(created);
      if (reorder === null) return created;
      const stage = priorWorkspace.milestones.find((item) => item.document.id === reorder.stageId);
      if (stage === undefined) return created;
      const taskOrder = buildInsertedTaskOrder(
        priorWorkspace.tasks.filter((task) => task.document.milestone === stage.document.id),
        strings(stage.document, "task_order"),
        created.document.id,
        hierarchyCompare,
        reorder.beforeId,
        reorder.afterId,
      );
      return await api.updateEntity(draft.draft_id, "milestones", stage, created.draft_fingerprint, { ...stage.document, task_order: taskOrder } as EntityDocument);
    }, id);
  };

  const archiveProject = () => {
    if (workspace === null || !confirmAction(t("projectPlan.archiveConfirm", { name: text(workspace.project.document, "name") }))) return;
    void mutate(async () => await api.archiveEntity(draft.draft_id, "projects", workspace.project, workspace.draft_fingerprint)).then((success) => { if (success) onNavigate("projects"); });
  };

  const deleteProject = async () => {
    if (workspace === null) return;
    const name = text(workspace.project.document, "name");
    if (!confirmAction(t("core.deleteConfirm", { name }))) return;
    setError(null);
    try {
      await api.deleteEntity(draft.draft_id, "projects", workspace.project, workspace.draft_fingerprint);
    } catch (caught) {
      if (!(caught instanceof ApiError) || caught.code !== "DELETE_RESTRICTED") {
        setError(t("projectPlan.deleteFailed", { name, message: formatApiError(caught) }));
        return;
      }
      const references = deleteRestrictionLabels(caught.details);
      if (references.length === 0) {
        setError(t("projectPlan.deleteRestrictedUnknown", { name }));
        return;
      }
      if (!confirmAction(t("projectPlan.deleteReferencesConfirm", {
        name,
        count: references.length,
        references: references.map((reference) => `• ${reference}`).join("\n"),
      }))) return;
      try {
        await api.deleteEntity(draft.draft_id, "projects", workspace.project, workspace.draft_fingerprint, false, true);
      } catch (retryError) {
        const messageKey = retryError instanceof ApiError && retryError.code === "DELETE_RESTRICTED"
          ? "projectPlan.deleteRestrictedChanged"
          : "projectPlan.deleteFailed";
        setError(t(messageKey, { name, message: formatApiError(retryError) }));
        return;
      }
    }
    await onChanged();
    setEditor(null);
    onNavigate("projects");
  };

  return <section className="project-plan-workspace">
    <DraftReadOnlyAlert draft={draft} locale={locale} onAcknowledge={() => {
      setError(null);
      void api.acknowledgeExternalChanges(draft.draft_id)
        .then(async () => await onChanged())
        .catch((caught: unknown) => setError(formatApiError(caught)));
    }} />
    {error !== null && <div className="alert error">{error}</div>}
    <AsyncBoundary state={loader.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{loadError}<button onClick={retry}>{t("status.retry")}</button></div>}>
      {workspace !== null && <div className={`project-plan-layout${selectedStage !== undefined || selectedTask !== undefined ? " with-inspector" : ""}${inspectorResize === null ? "" : " resizing"}`} style={{ "--inspector-width": `${inspectorWidth}px` } as CSSProperties}>
        {workspace.project.document.lifecycle === "archived" && <div className="alert warning"><span>{t("core.archived")}</span><button className="primary" disabled={readOnly} onClick={() => { void mutate(async () => await api.restoreEntity(draft.draft_id, "projects", workspace.project, workspace.draft_fingerprint)); }} type="button">{t("core.restore")}</button></div>}
        <div className="project-plan-main">
          <header className={`project-plan-header${recentChanges[workspace.project.document.id] ? " recently-changed" : ""}`}>
            <div className="project-plan-title"><span className="project-plan-project-kind">{t("core.project")} <code>{workspace.project.document.id}</code></span><h2>{text(workspace.project.document, "name")}</h2><p>{text(workspace.project.document, "description_markdown") || t("core.noDescription")}</p><button aria-haspopup="dialog" className="project-files-trigger" onClick={() => { setFilesOpen(true); void loadProjectFiles(); }} type="button"><svg aria-hidden="true" viewBox="0 0 20 20"><path d="M7.4 10.8 12 6.2a2.5 2.5 0 0 1 3.5 3.6l-6.3 6.3a4 4 0 0 1-5.7-5.7l6.7-6.7a1.5 1.5 0 0 1 2.1 2.1l-6.7 6.7a1 1 0 0 0 1.5 1.4l5.4-5.4" /></svg><span>{t("projectFiles.button")}</span><span aria-label={t("projectFiles.count", { count: projectFiles?.count ?? 0 })} className="project-files-count">{projectFiles?.count ?? (filesLoadState.status === "loading" ? "…" : 0)}</span></button></div>
            <div className="project-plan-actions">{archiveMode
              ? <button className="primary" data-control-hint={t("controlHint.backToProjectPlan")} onClick={() => showArchive(false)}>{t("projectArchive.backToPlan")}</button>
              : <><button disabled={readOnly} onClick={() => { setProjectPlanningDraft(scheduling.planning(rawProjectPlanning)); setProjectPlanningDirty(false); setProjectSchedulesDraft(workspace.project.document.schedules as ScheduleMap | undefined); setEditor({ kind: "project" }); }}>{t("core.edit")}</button><button disabled={readOnly} onClick={() => setEditor({ kind: "new-stage" })}>+ {t("stages.new")}</button><button className="primary" disabled={readOnly} onClick={() => setEditor({ kind: "task" })}>+ {t("core.createTaskAction")}</button><button aria-pressed="false" className="project-archive-toggle" data-control-hint={t("controlHint.openProjectArchive")} onClick={() => showArchive(true)} type="button">{t("projectArchive.open", { stages: archiveViewModel.stages.length, tasks: archivedContentCount })}</button></>}</div>
            <dl className="project-plan-meta">
              <div><dt>{t("core.status")}</dt><dd><span className="state open">{statusTitle(text(workspace.project.document, "status"))}</span></dd></div>
              {text(workspace.project.document, "group").trim() !== "" && <div><dt>{t("core.group")}</dt><dd>{text(workspace.project.document, "group").trim()}</dd></div>}
              <div><dt>{t("core.owner")}</dt><dd><PersonLinks empty={t("core.unassigned")} onOpen={(personId) => onNavigate("people", { personId })} people={people} personIds={text(workspace.project.document, "owner") ? [text(workspace.project.document, "owner")] : []} /></dd></div>
              <div><dt>{t("projectPlan.start")}</dt><dd>{dateLabel(text(workspace.project.document, "start"))}</dd></div>
              <div><dt>{t("core.due")}</dt><dd>{dateLabel(text(workspace.project.document, "due"))}</dd></div>
            </dl>
          </header>

          {!archiveMode && <ProjectScheduleSummary project={workspace.project.document} locale={locale} milestones={activeStages} tasks={currentPlanTasks} scheduling={scheduling} projectId={projectId} onNavigate={onNavigate} />}

          {!archiveMode && <><section className="project-plan-work" ref={animatedList}>
            <div className="project-plan-toolbar">
              <div className="project-plan-toolbar-heading"><h2>{t("projectPlan.workHeading")}</h2><span>{t("projectPlan.workDescription")}</span><span className="project-plan-stage-count">{t("projectPlan.stages")}: {activeStages.length}</span>{outsideStages.length > 0 && <button aria-pressed={milestoneFilter === "none"} className={`project-plan-outside-warning${milestoneFilter === "none" ? " is-active" : ""}`} data-control-hint={t("controlHint.outsideActiveMilestones")} onClick={() => applyFilters(statusFilter, milestoneFilter === "none" ? "" : "none", effectiveSummaryFilter)} type="button">{t("projectPlan.withoutStage")}: {outsideStages.length}</button>}</div>
              <details className="task-field-settings">
                <summary>{t("projectPlan.configureFields")}</summary>
                <div>
                  <p>{t("projectPlan.configureFieldsDescription")}</p>
                  {(["assignees", "due", "estimate", "status"] as const).map((field) => <label data-field-hint={t("fieldHint.visibleTaskFields")} key={field}><input checked={taskFields[field]} onChange={(event) => setTaskFields((current) => ({ ...current, [field]: event.target.checked }))} type="checkbox" />{t(`projectPlan.field.${field}` as MessageKey)}</label>)}
                </div>
              </details>
              <AdvancedViewControls
                allowSorting={false}
                appliedControls={(summaryFilter !== "all" || statusFilter !== "" || milestoneFilter !== "") && <div className="project-plan-filter-chips">{summaryFilter !== "all" && <span className="filter-chip">{summaryMetricLabel(summaryFilter)}<button aria-label={t("projectPlan.chipRemove", { filter: summaryMetricLabel(summaryFilter) })} onClick={() => applyFilters(statusFilter, milestoneFilter, "all")} type="button">×</button></span>}{statusFilter !== "" && <span className="filter-chip">{statusTitle(statusFilter)}<button aria-label={t("projectPlan.chipRemove", { filter: statusTitle(statusFilter) })} onClick={() => applyFilters("", milestoneFilter, effectiveSummaryFilter)} type="button">×</button></span>}{milestoneFilter !== "" && <span className="filter-chip">{milestoneChipLabel(milestoneFilter)}<button aria-label={t("projectPlan.chipRemove", { filter: milestoneChipLabel(milestoneFilter) })} onClick={() => applyFilters(statusFilter, "", effectiveSummaryFilter)} type="button">×</button></span>}</div>}
                externalFilterCount={Number(summaryFilter !== "all") + Number(statusFilter !== "") + Number(milestoneFilter !== "")}
                fields={taskAdvancedFields}
                groupLabel={t("projectPlan.summaryGroup")}
                leadingControls={<div className="project-plan-summary">
                  <button aria-label={`${t("projectPlan.summaryTotal")}: ${summaryScopeTasks.length}`} aria-pressed={effectiveSummaryFilter === "all" && statusFilter === ""} className="project-plan-summary-metric" data-control-hint={t("controlHint.summaryTotal")} onClick={() => applyFilters("", milestoneFilter, "all")} type="button"><span>{t("projectPlan.summaryTotal")}</span><strong>{summaryScopeTasks.length}</strong></button>
                  <button aria-label={`${t("projectPlan.summaryActive")}: ${inProgressCount}`} aria-pressed={effectiveSummaryFilter === "active"} className="project-plan-summary-metric" data-control-hint={t("controlHint.summaryActive")} onClick={() => toggleSummary("active")} type="button"><span>{t("projectPlan.summaryActive")}</span><strong>{inProgressCount}</strong></button>
                  <button aria-label={`${t("projectPlan.summaryBlocked")}: ${blockedCount}`} aria-pressed={effectiveSummaryFilter === "blocked"} className="project-plan-summary-metric project-plan-summary-blocked" data-control-hint={t("controlHint.summaryBlocked")} onClick={() => toggleSummary("blocked")} type="button"><span>{t("projectPlan.summaryBlocked")}</span><strong>{blockedCount}</strong></button>
                  <button aria-label={`${t("projectPlan.summaryOverdue")}: ${overdueCount}`} aria-pressed={effectiveSummaryFilter === "overdue"} className="project-plan-summary-metric project-plan-summary-overdue" data-control-hint={t("controlHint.summaryOverdue")} onClick={() => toggleSummary("overdue")} type="button"><span>{t("projectPlan.summaryOverdue")}</span><strong>{overdueCount}</strong></button>
                  <button aria-label={`${t("projectPlan.summaryCompleted")}: ${completedCount}`} aria-pressed={effectiveSummaryFilter === "completed"} className="project-plan-summary-metric" data-control-hint={t("controlHint.summaryCompleted")} onClick={() => toggleSummary("completed")} type="button"><span>{t("projectPlan.summaryCompleted")}</span><strong>{completedCount}</strong></button>
                </div>}
                locale={locale}
                onChange={applyAdvancedQuery}
                onClear={resetFilters}
                query={advancedQuery}
                resultCount={visibleTasks.length}
                t={t}
                totalCount={currentPlanTasks.length}
              />
            </div>
            {activeStages.length === 0 && <div className="card empty-workspace">{t("projectPlan.emptyStages")}</div>}
            {filterActive && visibleTasks.length === 0 && <div className="card empty-workspace">{t("projectPlan.noMatchingTasks")}</div>}
            {visibleStages.map((stage) => <StageSection
              allTasks={currentPlanTasks.filter((task) => task.document.milestone === stage.document.id)}
              key={stage.document.id}
              locale={locale}
              people={people}
              onNavigate={onNavigate}
              onNewTask={() => setEditor({ kind: "task", stageId: stage.document.id })}
              onCreate={(spec) => setEditor({ kind: "task", stageId: stage.document.id, ...spec })}
              onMoveStage={(offset) => moveStage(stage.document.id, offset)}
              onMoveTask={(taskId, offset) => moveTask(stage, taskId, offset)}
              onStatusChange={changeTaskStatus}
              orderBusy={orderPending !== null || statusPending !== null}
              projectId={projectId}
              query={navigationQuery}
              readOnly={readOnly}
              roots={stageRootsById.get(stage.document.id) ?? []}
              selected={selectedStageId === stage.document.id}
              saving={orderPending?.includes(stage.document.id) === true}
              selectedTaskId={selectedTaskId}
              stage={stage}
              changed={recentChanges[stage.document.id] !== undefined}
              stageCount={activeStages.length}
              stageIndex={activeStages.indexOf(stage)}
              statusTitle={statusTitle}
              statusOptions={statuses}
              statusBusy={statusPending !== null}
              savingTaskIds={new Set([...(orderPending ?? []), ...(statusPending === null ? [] : [statusPending])])}
              tasks={visibleTasks.filter((task) => task.document.milestone === stage.document.id)}
              taskFields={taskFields}
              changedTaskIds={new Set(Object.keys(recentChanges))}
              text={text}
              number={number}
              t={t}
            />)}
            {(milestoneFilter === "" || milestoneFilter === "none") && (!filterActive || visibleOutsideStages.length > 0) && <section className={`project-plan-stage project-plan-unassigned${visibleOutsideStages.length > 0 ? " has-work" : ""}`}>
              <header><div><span className="project-plan-stage-kind">{t("projectPlan.systemGroup")}</span><h3>{t("projectPlan.unassignedHeading")}</h3><p>{t("projectPlan.unassignedDescription")}</p></div><div className="project-plan-stage-actions"><button disabled={readOnly} onClick={() => setEditor({ kind: "task" })}>+ {t("core.createTaskAction")}</button></div></header>
              <TaskRows allTasks={outsideStages} locale={locale} onCreate={(spec) => setEditor({ kind: "task", ...spec })} onNavigate={onNavigate} onStatusChange={changeTaskStatus} people={people} projectId={projectId} query={navigationQuery} readOnly={readOnly} roots={systemRoots} savingTaskIds={new Set([...(orderPending ?? []), ...(statusPending === null ? [] : [statusPending])])} selectedTaskId={selectedTaskId} statusBusy={statusPending !== null} statusOptions={statuses} statusTitle={statusTitle} taskFields={taskFields} visibleIds={new Set(visibleOutsideStages.map((task) => task.document.id))} text={text} number={number} t={t} />
            </section>}
          </section></>}
          {archiveMode && <section className="project-plan-archive">
            <div className="project-plan-toolbar"><div className="project-plan-toolbar-heading"><h2>{t("projectArchive.heading")}</h2><span>{t("projectArchive.description")}</span><span className="project-plan-stage-count">{t("projectArchive.counts", { stages: archiveViewModel.stages.length, tasks: archivedContentCount })}</span></div></div>
            {archiveViewModel.stages.length === 0 && standaloneArchivedTasks.length === 0
              ? <div className="card empty-workspace">{t("projectArchive.empty")}</div>
              : <>
                {archiveViewModel.stages.map((group, index) => {
                  const stageTasks = workspace.tasks.filter((task) => task.document.milestone === group.milestone.document.id);
                  return <ArchivedStageSection allTasks={stageTasks} key={group.milestone.document.id} locale={locale} number={number} onNavigate={onNavigate} people={people} projectId={projectId} query={navigationQuery} readOnly={readOnly} roots={group.roots} selected={selectedStageId === group.milestone.document.id} selectedTaskId={selectedTaskId} stage={group.milestone} stageIndex={index} statusOptions={statuses} statusTitle={statusTitle} taskFields={taskFields} text={text} t={t} onRestore={() => setEditor({ kind: "restore-stage", stageId: group.milestone.document.id })} />;
                })}
                {standaloneArchivedTasks.length > 0 && <section className="project-plan-stage project-plan-archive-tasks"><header><div><span className="project-plan-stage-kind">{t("projectArchive.taskGroupKind")}</span><h3>{t("projectArchive.taskGroup")}</h3><p>{t("projectArchive.taskGroupDescription")}</p></div></header><TaskRows allTasks={standaloneArchivedTasks} locale={locale} onNavigate={onNavigate} people={people} projectId={projectId} query={navigationQuery} roots={archiveViewModel.tasks.roots} selectedTaskId={selectedTaskId} statusOptions={statuses} statusTitle={statusTitle} taskFields={taskFields} visibleIds={new Set(standaloneArchivedTasks.map((task) => task.document.id))} text={text} number={number} t={t} /></section>}
              </>}
          </section>}
        </div>

        {(selectedStage !== undefined || selectedTask !== undefined) && <div
          aria-controls="project-plan-inspector-pane"
          aria-label={t("projectPlan.resizeInspector")}
          aria-orientation="vertical"
          aria-valuemax={MAX_INSPECTOR_WIDTH}
          aria-valuemin={MIN_INSPECTOR_WIDTH}
          aria-valuenow={inspectorWidth}
          className="plan-pane-resizer"
          onKeyDown={resizeInspectorByKey}
          onPointerCancel={endInspectorResize}
          onPointerDown={beginInspectorResize}
          onPointerMove={moveInspectorResize}
          onPointerUp={endInspectorResize}
          role="separator"
          tabIndex={0}
          title={t("projectPlan.resizeInspector")}
        />}

        {selectedStage !== undefined && <aside className="project-plan-inspector" aria-label={t("core.milestone")} id="project-plan-inspector-pane" ref={inspectorPaneRef}>
          <button aria-label={t("core.closeEditor")} className="inspector-close" onClick={closeInspector} title={t("core.closeEditor")} type="button">×</button>
          <span className="eyebrow">{t("core.milestone")}</span><h2>{text(selectedStage.document, "name")}</h2><code className="project-plan-inspector-id">{selectedStage.document.id}</code><p>{text(selectedStage.document, "description_markdown") || t("core.noDescription")}</p>
          <dl className="project-plan-inspector-stats"><div><dt>{t("stages.progressLabel")}</dt><dd>{workspace.tasks.filter((task) => task.document.milestone === selectedStage.document.id && isCompletedStatus(statuses, text(task.document, "status"))).length}/{workspace.tasks.filter((task) => task.document.milestone === selectedStage.document.id).length}</dd></div><div><dt>{t("stages.estimate")}</dt><dd>{selectedStageEstimate === undefined ? "—" : formatDurationHours(locale, selectedStageEstimate)}</dd></div><div><dt>{t("core.due")}</dt><dd>{dateLabel(selectedStageDue ?? "")}</dd></div></dl>
          <SchedulingOverflowWarnings locale={locale} trackTitle={(track) => scheduling.trackTitle(track)} warnings={selectedStageWarnings} onOpenGantt={() => onNavigate("gantt", { projectId })} />
          <div className="inspector-actions"><button disabled={readOnly} onClick={() => openStageEditor(selectedStage)}>{t("core.edit")}</button>{selectedStage.document.lifecycle === "archived" ? <button disabled={readOnly} onClick={() => setEditor({ kind: "restore-stage", stageId: selectedStage.document.id })}>{t("core.restore")}</button> : <button disabled={readOnly} onClick={() => setEditor({ kind: "archive-stage", stageId: selectedStage.document.id })}>{t("core.archive")}</button>}<button className="primary" disabled={readOnly || selectedStage.document.lifecycle === "archived"} onClick={() => setEditor({ kind: "task", stageId: selectedStage.document.id })}>+ {t("core.createTaskAction")}</button></div>
        </aside>}

        {selectedTask !== undefined && <aside className="project-plan-inspector task-inspector" aria-label={t("core.details")} id="project-plan-inspector-pane" ref={inspectorPaneRef}>
          <button aria-label={t("core.closeEditor")} className="inspector-close" onClick={closeInspector} title={t("core.closeEditor")} type="button">×</button>
          <TaskPanel api={api} catalog={catalog} confirmCommentDelete={() => confirmAction(t("comments.deleteConfirm"))} confirmDelete={(name) => confirmAction(t("core.deleteConfirm", { name }))} draft={draft} entity={selectedTask} fingerprint={workspace.draft_fingerprint} key={selectedTask.document.id} locale={locale} milestones={workspace.milestones} onCommentChanged={async (nextFingerprint) => { setWorkspace((current) => current === null ? current : { ...current, draft_fingerprint: nextFingerprint }); await onChanged(); }} onDeleted={closeInspector} onNavigate={onNavigate} onStatusChange={(status) => changeTaskStatus(selectedTask, status)} people={people} projects={projects} readOnly={readOnly} remove={removeEntity} save={saveEntity} statusBusy={statusPending !== null} statusOptions={statuses} tasks={workspace.tasks} typeOptions={types} value={text} effortString={(document) => { const e = effortOf(document); return typeof e === "number" ? String(e) : ""; }} track={primaryTrack} scheduling={scheduling} planning={workspace.project.document.planning as ProjectPlanning | undefined} />
        </aside>}
      </div>}
    </AsyncBoundary>

    <ProjectFilesPanel
      api={api}
      draftId={draft.draft_id}
      fingerprint={projectFiles?.draft_fingerprint ?? workspace?.draft_fingerprint ?? draft.fingerprint}
      list={projectFiles}
      loadState={filesLoadState}
      locale={locale}
      onClose={() => setFilesOpen(false)}
      onDeleted={handleProjectFileDeleted}
      onReload={() => { void loadProjectFiles(); }}
      onRenamed={handleProjectFileRenamed}
      onUploaded={handleProjectFileUploaded}
      onViewChange={setFilesView}
      open={filesOpen}
      projectId={projectId}
      readOnly={readOnly}
      view={filesView}
    />

    {workspace !== null && <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditor(null)} open={editor?.kind === "project"} title={`${t("core.edit")}: ${text(workspace.project.document, "name")}`}>
      <form className="editor-drawer-form" onSubmit={updateProject}>
        <label>{t("core.name")}<input defaultValue={text(workspace.project.document, "name")} disabled={readOnly} name="name" required /></label>
        <label>{t("core.status")}<select defaultValue={text(workspace.project.document, "status")} disabled={readOnly} name="status">{statuses.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select></label>
        <ProjectGroupField currentGroup={text(workspace.project.document, "group")} disabled={readOnly} groups={availableProjectGroups} key={editor?.kind === "project" ? "open" : "closed"} t={t} />
        <label>{t("core.owner")}<select defaultValue={text(workspace.project.document, "owner")} disabled={readOnly} name="owner"><option value="">{t("core.unassigned")}</option>{people.map((person) => <option key={person.document.id} value={person.document.id}>{text(person.document, "name")}</option>)}</select></label>
        <ScheduleTracksEditor schedules={projectSchedulesDraft} tracks={projectEditorManualTracks} actualTrack={projectEditorActualTrack} primaryTrack={projectEditorPlanning.primary_track ?? ""} dependencies={[]} showDependencies={false} disabled={readOnly} locale={locale} onChange={setProjectSchedulesDraft} />
        <label>{t("core.description")}<textarea defaultValue={text(workspace.project.document, "description_markdown")} disabled={readOnly} name="description" /></label>
        <ProjectPlanningEditor planning={projectEditorPlanning} tracks={scheduling.raw?.tracks ?? []} usedTracks={usedProjectScheduleTracks} disabled={readOnly} locale={locale} onChange={(next) => { setProjectPlanningDraft(next); setProjectPlanningDirty(true); }} />
        <div className="editor-drawer-actions"><details className="more-actions"><summary>{t("core.moreActions")}</summary><div><button disabled={readOnly} onClick={archiveProject} type="button">{t("core.archive")}</button><button className="danger" data-control-hint={t("controlHint.deleteEntity")} disabled={readOnly} onClick={() => { void deleteProject(); }} type="button">{t("core.delete")}</button></div></details><button onClick={() => setEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.save")}</button></div>
      </form>
    </EditorDrawer>}

    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditor(null)} open={editor?.kind === "new-stage"} title={t("stages.new")}>
      <form className="editor-drawer-form" onSubmit={createStage}>
        <label>{t("core.name")}<input disabled={readOnly} name="name" required /></label>
        <label>{t("core.due")}<input disabled={readOnly} name="due" type="date" /></label>
        <label>{t("core.description")}<textarea disabled={readOnly} name="description" /></label>
        <div className="editor-drawer-actions"><button onClick={() => setEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.save")}</button></div>
      </form>
    </EditorDrawer>

    {workspace !== null && editor?.kind === "edit-stage" && (() => {
      const stage = workspace.milestones.find((item) => item.document.id === editor.stageId);
      return stage === undefined ? null : <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditor(null)} open title={t("stages.edit")}>
        <form className="editor-drawer-form" onSubmit={updateStage}>
          <label>{t("core.name")}<input defaultValue={text(stage.document, "name")} disabled={readOnly} name="name" required /></label>
          <ScheduleTracksEditor schedules={stageSchedulesDraft} tracks={stageManualTracks} actualTrack={stageActualTrack} primaryTrack={primaryTrack} dependencies={[]} showDependencies={false} disabled={readOnly} locale={locale} onChange={setStageSchedulesDraft} />
          <label>{t("core.description")}<textarea defaultValue={text(stage.document, "description_markdown")} disabled={readOnly} name="description" /></label>
          <div className="editor-drawer-actions"><button onClick={() => setEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.save")}</button></div>
        </form>
      </EditorDrawer>;
    })()}

    {workspace !== null && (editor?.kind === "archive-stage" || editor?.kind === "restore-stage") && (() => {
      const stage = workspace.milestones.find((item) => item.document.id === editor.stageId);
      if (stage === undefined) return null;
      const action = editor.kind === "archive-stage" ? "archive" as const : "restore" as const;
      const affectedTasks = workspace.tasks.filter((task) => task.document.milestone === stage.document.id && task.document.lifecycle === (action === "archive" ? "active" : "archived"));
      return <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditor(null)} open title={t(action === "archive" ? "projectArchive.archiveTitle" : "projectArchive.restoreTitle", { name: text(stage.document, "name") })}>
        <div className="editor-drawer-form lifecycle-choice"><p>{t(action === "archive" ? "projectArchive.archiveChoice" : "projectArchive.restoreChoice", { count: affectedTasks.length })}</p><div className="lifecycle-choice-options"><button disabled={readOnly} onClick={() => transitionStage(stage, action, false)} type="button"><strong>{t(action === "archive" ? "projectArchive.stageOnlyArchive" : "projectArchive.stageOnlyRestore")}</strong><small>{t(action === "archive" ? "projectArchive.stageOnlyArchiveHint" : "projectArchive.stageOnlyRestoreHint")}</small></button><button className="primary" disabled={readOnly} onClick={() => transitionStage(stage, action, true)} type="button"><strong>{t(action === "archive" ? "projectArchive.stageAndTasksArchive" : "projectArchive.stageAndTasksRestore", { count: affectedTasks.length })}</strong><small>{t(action === "archive" ? "projectArchive.stageAndTasksArchiveHint" : "projectArchive.stageAndTasksRestoreHint")}</small></button></div><div className="editor-drawer-actions"><button onClick={() => setEditor(null)} type="button">{t("core.cancel")}</button></div></div>
      </EditorDrawer>;
    })()}

    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditor(null)} open={editor?.kind === "task"} title={editor?.kind === "task" && editor.parentId !== undefined && editor.beforeId === undefined && editor.afterId === undefined ? t("taskHierarchy.newSubtask") : t("core.createTaskAction")}>
      <form className="editor-drawer-form" onSubmit={createTask}>
        {editor?.kind === "task" && editor.parentId !== undefined && <p className="task-parent-context">{t("taskHierarchy.parent")}: <strong>{text(workspace?.tasks.find((task) => task.document.id === editor.parentId)?.document ?? { schema: "", id: "", lifecycle: "active" }, "title")}</strong></p>}
        <label>{t("core.title")}<input disabled={readOnly} name="title" required /></label>
        <label>{t("core.status")}<select disabled={readOnly} name="status">{statuses.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select></label>
        <label>{t("core.type")}<select disabled={readOnly} name="type">{types.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select></label>
        <AssigneeChecks disabled={readOnly} people={people} selected={newTaskAssignees} t={t} />
        <label>{t("projectPlan.start")}<input disabled={readOnly} name="start" type="date" /></label>
        <label>{t("core.due")}<input disabled={readOnly} name="due" type="date" /></label>
        <label>{t("projectPlan.estimate")}<input disabled={readOnly} min="0" name="estimate" step="0.25" type="number" /></label>
        <label>{t("core.description")}<textarea disabled={readOnly} name="description" /></label>
        <div className="editor-drawer-actions"><button onClick={() => setEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.createTask")}</button></div>
      </form>
    </EditorDrawer>
  </section>;
}

type ScheduleTextReader = (document: Readonly<Record<string, unknown>>, key: string) => string;
type ScheduleNumberReader = (document: Readonly<Record<string, unknown>>, key: string) => number | undefined;

function ArchivedStageSection({ stage, allTasks, roots, stageIndex, projectId, query, locale, people, readOnly, selected, selectedTaskId, statusTitle, statusOptions, taskFields, text, number, onRestore, onNavigate, t }: {
  readonly stage: EntityResult;
  readonly allTasks: readonly EntityResult[];
  readonly roots: readonly TaskViewModelNode[];
  readonly stageIndex: number;
  readonly projectId: string;
  readonly query: Readonly<Record<string, readonly string[]>>;
  readonly locale: Locale;
  readonly people: readonly EntityResult[];
  readonly readOnly: boolean;
  readonly selected: boolean;
  readonly selectedTaskId: string;
  readonly statusTitle: (slug: string) => string;
  readonly statusOptions: readonly ConfigValue[];
  readonly taskFields: TaskFieldVisibility;
  readonly text: ScheduleTextReader;
  readonly number: ScheduleNumberReader;
  readonly onRestore: () => void;
  readonly onNavigate: WorkspaceNavigate;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const completed = allTasks.filter((task) => isCompletedStatus(statusOptions, text(task.document, "status"))).length;
  return <article className={`project-plan-stage project-plan-archived-stage${selected ? " selected" : ""}`}>
    <header><button aria-current={selected ? "true" : undefined} aria-label={`${t("core.milestone")}: ${text(stage.document, "name")} · ${stage.document.id}`} className="project-plan-stage-selector" data-control-hint={t("controlHint.openMilestoneDetails")} onClick={() => onNavigate("stages", { projectId, stageId: stage.document.id, query })} type="button"><span className="project-plan-stage-kind">{t("projectArchive.archivedMilestone")} {stageIndex + 1}. <code>{stage.document.id}</code>.</span><span aria-level={3} className="project-plan-stage-title" role="heading">{text(stage.document, "name")}</span><span className="project-plan-stage-description">{text(stage.document, "description_markdown") || t("core.noDescription")}</span></button><div className="project-plan-stage-actions"><button disabled={readOnly} onClick={onRestore} type="button">{t("core.restore")}</button></div></header>
    <div className="project-plan-stage-progress"><progress aria-label={t("stages.progressLabel")} max="100" value={allTasks.length === 0 ? 0 : Math.round(completed / allTasks.length * 100)} /><span>{t("stages.progress", { completed, count: allTasks.length })}</span></div>
    <TaskRows allTasks={allTasks} locale={locale} onNavigate={onNavigate} people={people} projectId={projectId} query={query} roots={roots} selectedTaskId={selectedTaskId} statusOptions={statusOptions} statusTitle={statusTitle} taskFields={taskFields} visibleIds={new Set(allTasks.map((task) => task.document.id))} text={text} number={number} t={t} />
  </article>;
}

function StageSection({ stage, tasks, allTasks, roots, stageIndex, stageCount, projectId, query, locale, people, readOnly, orderBusy, selected, changed, saving, selectedTaskId, changedTaskIds, savingTaskIds, statusTitle, statusOptions, statusBusy, taskFields, text, number, onNewTask, onCreate, onMoveStage, onMoveTask, onStatusChange, onNavigate, t }: {
  readonly stage: EntityResult;
  readonly tasks: readonly EntityResult[];
  readonly allTasks: readonly EntityResult[];
  readonly roots: readonly TaskViewModelNode[];
  readonly stageIndex: number;
  readonly stageCount: number;
  readonly projectId: string;
  readonly query: Readonly<Record<string, readonly string[]>>;
  readonly locale: Locale;
  readonly people: readonly EntityResult[];
  readonly readOnly: boolean;
  readonly orderBusy: boolean;
  readonly selected: boolean;
  readonly changed: boolean;
  readonly saving: boolean;
  readonly selectedTaskId: string;
  readonly changedTaskIds: ReadonlySet<string>;
  readonly savingTaskIds: ReadonlySet<string>;
  readonly statusTitle: (slug: string) => string;
  readonly statusOptions: readonly ConfigValue[];
  readonly statusBusy: boolean;
  readonly taskFields: TaskFieldVisibility;
  readonly text: ScheduleTextReader;
  readonly number: ScheduleNumberReader;
  readonly onNewTask: () => void;
  readonly onCreate: (spec: TaskInsertSpec) => void;
  readonly onMoveStage: (offset: -1 | 1) => void;
  readonly onMoveTask: (taskId: string, offset: -1 | 1) => void;
  readonly onStatusChange: (task: EntityResult, status: string) => void;
  readonly onNavigate: WorkspaceNavigate;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const completed = allTasks.filter((task) => isCompletedStatus(statusOptions, text(task.document, "status"))).length;
  const progress = allTasks.length === 0 ? 0 : Math.round(completed / allTasks.length * 100);
  const stageAssigneeIds = [...new Set(allTasks.flatMap((task) => strings(task.document, "assignees")))];
  return <article className={`project-plan-stage${selected ? " selected" : ""}${changed ? " recently-changed" : ""}${saving ? " is-saving" : ""}`} data-flip-key={`stage:${stage.document.id}`}>
    <header>
      <button aria-current={selected ? "true" : undefined} aria-label={`${t("core.milestone")}: ${text(stage.document, "name")} · ${stage.document.id}`} className="project-plan-stage-selector" data-control-hint={t("controlHint.openMilestoneDetails")} onClick={() => onNavigate("stages", { projectId, stageId: stage.document.id, ...(Object.keys(query).length > 0 ? { query } : {}) })} type="button">
        <span className="project-plan-stage-kind">{t("core.milestone")} {stageIndex + 1}. <code>{stage.document.id}</code>.</span>
        <span aria-level={3} className="project-plan-stage-title" role="heading">{text(stage.document, "name")}</span>
        <span className="project-plan-stage-description">{text(stage.document, "description_markdown") || t("core.noDescription")}</span>
        {taskFields.assignees && <span className="project-plan-stage-assignees" title={t("tooltip.milestoneAssignees")}>{t("core.assignees")}: <PersonLinks empty={t("core.unassigned")} onOpen={(personId) => onNavigate("people", { personId })} people={people} personIds={stageAssigneeIds} /></span>}
      </button>
      <div className="project-plan-stage-actions"><span className="plan-order-controls"><button aria-label={t("projectPlan.moveStageUp", { number: stageIndex + 1 })} disabled={readOnly || orderBusy || stageIndex === 0} onClick={() => onMoveStage(-1)} title={t("projectPlan.moveStageUp", { number: stageIndex + 1 })} type="button">↑</button><button aria-label={t("projectPlan.moveStageDown", { number: stageIndex + 1 })} disabled={readOnly || orderBusy || stageIndex === stageCount - 1} onClick={() => onMoveStage(1)} title={t("projectPlan.moveStageDown", { number: stageIndex + 1 })} type="button">↓</button></span><time dateTime={text(stage.document, "due")} title={t("tooltip.milestoneDue")}>{text(stage.document, "due") ? formatDateOnly(locale, text(stage.document, "due")) : "—"}</time><button disabled={readOnly} onClick={onNewTask}>+ {t("core.createTaskAction")}</button></div>
    </header>
    <div className="project-plan-stage-progress"><progress aria-label={t("stages.progressLabel")} max="100" value={progress}>{progress}%</progress><span>{t("stages.progress", { completed, count: allTasks.length })}</span></div>
    <TaskRows allTasks={allTasks} changedTaskIds={changedTaskIds} locale={locale} numberPrefix={stageIndex + 1} onCreate={onCreate} onMoveTask={onMoveTask} onNavigate={onNavigate} onStatusChange={onStatusChange} orderBusy={orderBusy} people={people} projectId={projectId} query={query} readOnly={readOnly} roots={roots} savingTaskIds={savingTaskIds} selectedTaskId={selectedTaskId} statusBusy={statusBusy} statusOptions={statusOptions} statusTitle={statusTitle} taskFields={taskFields} visibleIds={new Set(tasks.map((task) => task.document.id))} text={text} number={number} t={t} />
  </article>;
}

function TaskRows({ roots, visibleIds, allTasks, projectId, query = {}, locale, people, numberPrefix, readOnly = true, orderBusy = false, selectedTaskId, changedTaskIds = new Set<string>(), savingTaskIds = new Set<string>(), statusTitle, statusOptions = [], statusBusy = false, taskFields, text, number, onMoveTask, onCreate, onStatusChange, onNavigate, t }: {
  readonly roots: readonly TaskViewModelNode[];
  readonly visibleIds: ReadonlySet<string>;
  readonly allTasks: readonly EntityResult[];
  readonly projectId: string;
  readonly query?: Readonly<Record<string, readonly string[]>>;
  readonly locale: Locale;
  readonly people: readonly EntityResult[];
  readonly numberPrefix?: number;
  readonly readOnly?: boolean;
  readonly orderBusy?: boolean;
  readonly selectedTaskId: string;
  readonly changedTaskIds?: ReadonlySet<string>;
  readonly savingTaskIds?: ReadonlySet<string>;
  readonly statusTitle: (slug: string) => string;
  readonly statusOptions?: readonly ConfigValue[];
  readonly statusBusy?: boolean;
  readonly taskFields: TaskFieldVisibility;
  readonly text: ScheduleTextReader;
  readonly number: ScheduleNumberReader;
  readonly onMoveTask?: (taskId: string, offset: -1 | 1) => void;
  readonly onCreate?: (spec: TaskInsertSpec) => void;
  readonly onStatusChange?: (task: EntityResult, status: string) => void;
  readonly onNavigate: WorkspaceNavigate;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [openHandle, setOpenHandle] = useState<string | null>(null);
  const taskById = new Map(allTasks.map((task) => [task.document.id, task] as const));
  const nodeById = new Map<string, TaskViewModelNode>();
  const indexNodes = (node: TaskViewModelNode): void => { nodeById.set(node.id, node); for (const child of node.children) indexNodes(child); };
  for (const root of roots) indexNodes(root);
  const reserveDue = taskFields.due && [...nodeById.values()].some((node) => node.due !== undefined);
  const reserveEstimate = taskFields.estimate && [...nodeById.values()].some((node) => node.estimate !== undefined);
  const taskListStyle = {
    "--project-plan-task-meta-columns": [
      ...(taskFields.assignees ? ["minmax(8rem, clamp(10rem, 16vw, 16rem))"] : []),
      ...(reserveDue ? ["6.5rem"] : []),
      ...(reserveEstimate ? ["4.5rem"] : []),
      ...(taskFields.status ? ["7.5rem"] : []),
      ...(onMoveTask === undefined ? [] : ["max-content"]),
    ].join(" ") || "none",
  } as CSSProperties;
  const childrenOf = (parentId: string | undefined): readonly TaskViewModelNode[] => parentId === undefined ? roots : nodeById.get(parentId)?.children ?? [];
  if (visibleIds.size === 0) return <p className="project-plan-empty-tasks">{t("stages.emptyTasks")}</p>;
  const included = new Set<string>();
  for (const id of visibleIds) {
    const node = nodeById.get(id);
    if (node === undefined) continue;
    for (const ancestorId of node.path) included.add(ancestorId);
  }
  interface FlatEntry { readonly node: TaskViewModelNode; readonly parentId: string | undefined; readonly depth: number; readonly hasChildren: boolean }
  const entries: FlatEntry[] = [];
  const ancestorsCollapsed = (node: TaskViewModelNode): boolean => node.path.slice(0, -1).some((ancestorId) => collapsed.has(ancestorId));
  const walk = (node: TaskViewModelNode, parentId: string | undefined, depth: number): void => {
    if (included.has(node.id) && !ancestorsCollapsed(node)) {
      entries.push({ node, parentId, depth, hasChildren: node.children.length > 0 });
    }
    for (const child of node.children) walk(child, node.id, depth + 1);
  };
  for (const root of roots) walk(root, undefined, 0);
  const visibleEntryIds = new Set(entries.map((entry) => entry.node.id));
  return <div className="project-plan-task-list" style={taskListStyle}>{entries.map((entry, index) => {
    const { node } = entry;
    const task = taskById.get(node.id);
    const selected = selectedTaskId === node.id;
    const taskNumber = [
      ...(numberPrefix === undefined ? [] : [numberPrefix]),
      ...node.path.map((pathId, pathIndex) => childrenOf(pathIndex === 0 ? undefined : node.path[pathIndex - 1]!).findIndex((sibling) => sibling.id === pathId) + 1),
    ].join(".");
    const siblings = childrenOf(entry.parentId);
    const siblingIndex = siblings.findIndex((item) => item.id === node.id);
    const visibleSiblings = siblings.filter((item) => visibleEntryIds.has(item.id));
    const isLastVisibleSibling = visibleSiblings.at(-1)?.id === node.id;
    const nodeChildren = node.children;
    const hasVisibleChildren = nodeChildren.some((child) => visibleEntryIds.has(child.id));
    const completedChildren = nodeChildren.filter((child) => isCompletedStatus(statusOptions, child.status)).length;
    const isContextOnly = !visibleIds.has(node.id);
    const ancestorRailLevels: number[] = [];
    for (let level = 1; level < node.path.length - 1; level++) {
      const ancestorId = node.path[level]!;
      const ancestorSiblings = childrenOf(node.path[level - 1]!);
      const lastVisibleAncestor = [...ancestorSiblings].reverse().find((sibling) => visibleEntryIds.has(sibling.id));
      if (lastVisibleAncestor?.id !== ancestorId) ancestorRailLevels.push(level - 1);
    }
    const style = {
      "--task-depth": entry.depth,
      "--task-tree-width": `${entry.depth * .8}rem`,
      "--task-tree-parent-offset": `${-.4 + Math.max(0, entry.depth - 1) * .8}rem`,
    } as CSSProperties;
    const nextEntry = entries[index + 1];
    const nextTask = nextEntry === undefined ? undefined : taskById.get(nextEntry.node.id);
    const nextParentId = nextEntry?.parentId;
    const insertDepth = nextEntry === undefined ? entry.depth : nextEntry.depth;
    const rows = [<div className={`project-plan-task-row${selected ? " selected" : ""}${isContextOnly ? " filter-context" : ""}${changedTaskIds.has(node.id) ? " recently-changed" : ""}${savingTaskIds.has(node.id) ? " is-saving" : ""}`} data-depth={entry.depth} data-flip-key={`task:${node.id}`} key={node.id} style={style}>
      <span className={`project-plan-task-tree${hasVisibleChildren ? " has-visible-children" : ""}`}>
        {ancestorRailLevels.map((level) => <span aria-hidden="true" className="project-plan-task-ancestor-rail" key={level} style={{ left: `${-.4 + level * .8}rem` }} />)}
        {entry.depth > 0 && <span aria-hidden="true" className={`project-plan-task-branch${isLastVisibleSibling ? " last" : ""}`} />}
        <span className="project-plan-task-tree-control">{entry.hasChildren ? <button aria-expanded={!collapsed.has(node.id)} aria-label={collapsed.has(node.id) ? t("taskHierarchy.expand", { title: node.title }) : t("taskHierarchy.collapse", { title: node.title })} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })} title={collapsed.has(node.id) ? t("taskHierarchy.expand", { title: node.title }) : t("taskHierarchy.collapse", { title: node.title })} type="button"><svg aria-hidden="true" viewBox="0 0 12 12"><path d={collapsed.has(node.id) ? "M4 2.5 8 6 4 9.5" : "m2.5 4 3.5 4 3.5-4"} /></svg></button> : null}</span>
      </span>
      <button aria-current={selected ? "true" : undefined} className="project-plan-task-selector" data-control-hint={t("controlHint.openTaskDetails")} onClick={() => onNavigate("tasks", { projectId, taskId: node.id, ...(Object.keys(query).length > 0 ? { query } : {}) })} type="button"><span className="project-plan-task-kind">{t("projectPlan.taskLabel")} {taskNumber}. <code>{node.id}</code>.</span><strong>{node.title}</strong>{task?.document.lifecycle === "archived" && <small className="archived-reference">{t("core.archived")}</small>}{entry.hasChildren && <small>{t("taskHierarchy.directProgress", { completed: completedChildren, count: nodeChildren.length })}</small>}</button>
      <span className="project-plan-task-meta">
        {taskFields.assignees && <span className="project-plan-task-meta-cell task-assignees" title={t("tooltip.taskAssignees")}><PersonLinks empty={t("core.unassigned")} onOpen={(personId) => onNavigate("people", { personId })} people={people} personIds={node.assignees} /></span>}
        {reserveDue && <span className="project-plan-task-meta-cell project-plan-task-due">{node.due !== undefined && <time dateTime={node.due} title={t("tooltip.taskDue")}>{formatDateOnly(locale, node.due)}</time>}</span>}
        {reserveEstimate && <span className="project-plan-task-meta-cell project-plan-task-estimate">{node.estimate !== undefined && <span title={t("tooltip.taskEstimate")}>{formatDurationHours(locale, node.estimate)}</span>}</span>}
        {taskFields.status && <span className="project-plan-task-meta-cell project-plan-task-status">{onStatusChange === undefined || readOnly || task === undefined ? <span className="state open" title={t("tooltip.taskStatus")}>{statusTitle(node.status)}</span> : <select aria-label={`${t("core.status")}: ${node.title}`} className="inline-status-select" disabled={statusBusy} onChange={(event) => onStatusChange(task, event.target.value)} title={t("tooltip.changeStatus")} value={node.status}>{statusOptions.map((status) => <option key={status.slug} value={status.slug}>{status.title}</option>)}</select>}</span>}
        {onMoveTask !== undefined && <span className="project-plan-task-meta-cell plan-order-controls"><button aria-label={t("projectPlan.moveTaskUp", { number: taskNumber })} disabled={readOnly || orderBusy || siblingIndex === 0} onClick={() => onMoveTask(node.id, -1)} title={t("projectPlan.moveTaskUp", { number: taskNumber })} type="button">↑</button><button aria-label={t("projectPlan.moveTaskDown", { number: taskNumber })} disabled={readOnly || orderBusy || siblingIndex === siblings.length - 1} onClick={() => onMoveTask(node.id, 1)} title={t("projectPlan.moveTaskDown", { number: taskNumber })} type="button">↓</button></span>}
      </span>
    </div>];
    if (onCreate !== undefined && !readOnly && task !== undefined) rows.push(<TaskInsertHandle
      key={`insert-${node.id}`}
      anchorTask={task}
      anchorParentId={entry.parentId}
      nextTask={nextTask}
      nextParentId={nextParentId}
      depth={insertDepth}
      open={openHandle === node.id}
      onOpenChange={(next) => setOpenHandle(next ? node.id : null)}
      onCreate={onCreate}
      text={text}
      t={t}
    />);
    return rows;
  }).flat()}</div>;
}

function TaskInsertHandle({ anchorTask, anchorParentId, nextTask, nextParentId, depth, open, onOpenChange, onCreate, text, t }: {
  readonly anchorTask: EntityResult;
  readonly anchorParentId?: string;
  readonly nextTask?: EntityResult;
  readonly nextParentId?: string;
  readonly depth: number;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (spec: TaskInsertSpec) => void;
  readonly text: ScheduleTextReader;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const anchorTitle = text(anchorTask.document, "title");
  const nextTitle = nextTask === undefined ? "" : text(nextTask.document, "title");
  const pick = (spec: TaskInsertSpec) => { onOpenChange(false); onCreate(spec); };
  const insertLeft = `${.35 + depth * .8}rem`;
  return <div className={`task-insert-handle${open ? " is-open" : ""}`} style={{ "--insert-left": insertLeft } as CSSProperties}>
    <span className="task-insert-zone" aria-hidden="true" />
    <button
      aria-expanded={open}
      aria-haspopup="menu"
      aria-label={t("taskHierarchy.insertButton")}
      className="task-insert-button"
      onClick={() => onOpenChange(!open)}
      title={t("taskHierarchy.insertButton")}
      type="button">+</button>
    {open && <>
      <button aria-hidden="true" className="task-insert-menu-backdrop" onClick={() => onOpenChange(false)} tabIndex={-1} type="button" />
      <div className="task-insert-menu" role="menu">
        <button className="task-insert-menu-item" onClick={() => pick({ parentId: anchorTask.document.id })} role="menuitem" type="button">{t("taskHierarchy.insertSubtaskOf", { title: anchorTitle })}</button>
        {nextTask === undefined
          ? <button className="task-insert-menu-item" onClick={() => pick({ parentId: anchorParentId, afterId: anchorTask.document.id })} role="menuitem" type="button">{t("taskHierarchy.insertAfter", { title: anchorTitle })}</button>
          : <button className="task-insert-menu-item" onClick={() => pick({ parentId: nextParentId, beforeId: nextTask.document.id })} role="menuitem" type="button">{t("taskHierarchy.insertBetween", { before: anchorTitle, after: nextTitle })}</button>}
      </div>
    </>}
  </div>;
}
