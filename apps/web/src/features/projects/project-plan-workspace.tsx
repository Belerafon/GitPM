import { ENTITY_ID_PREFIX, newUniqueEntityId } from "@gitpm/shared";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { GitPmApi } from "../../api.js";
import { AsyncBoundary, useAsyncLoad } from "../../async-data.js";
import { AssigneeChecks, TaskPanel, type ConfigValue } from "../../core-ui.js";
import { EditorDrawer } from "../../editor-drawer.js";
import { EntityCatalog } from "../../entity-catalog.js";
import { useExternalHighlights, useReducedMotion } from "../../external-updates.js";
import { formatDateOnly, formatDurationHours, message, type Locale, type MessageKey } from "../../i18n.js";
import { upsertEntity, useFlipList } from "../../optimistic-ui.js";
import type { DraftStatus, EntityResult, GitPmDocument, ProjectWorkspaceResult } from "../../types.js";
import type { WorkspaceNavigate } from "../../workspace-navigation.js";
import { PersonLinks } from "../../person-link.js";

type PlanEditor = { readonly kind: "project" | "new-stage" } | { readonly kind: "edit-stage"; readonly stageId: string } | { readonly kind: "task"; readonly stageId?: string } | null;
type TaskField = "assignees" | "due" | "estimate" | "status";
type TaskFieldVisibility = Readonly<Record<TaskField, boolean>>;

const TASK_FIELDS_STORAGE_KEY = "gitpm.projectPlan.taskFields";
const defaultTaskFields: TaskFieldVisibility = { assignees: true, due: true, estimate: true, status: true };
const readTaskFields = (): TaskFieldVisibility => {
  try {
    const stored = JSON.parse(localStorage.getItem(TASK_FIELDS_STORAGE_KEY) ?? "{}") as Partial<Record<TaskField, unknown>>;
    return { assignees: stored.assignees !== false, due: stored.due !== false, estimate: stored.estimate !== false, status: stored.status !== false };
  } catch { return defaultTaskFields; }
};
const writeTaskFields = (fields: TaskFieldVisibility) => { try { localStorage.setItem(TASK_FIELDS_STORAGE_KEY, JSON.stringify(fields)); } catch { /* Browser storage may be unavailable. */ } };

const text = (document: GitPmDocument, key: string): string => typeof document[key] === "string" ? document[key] as string : "";
const number = (document: GitPmDocument, key: string): number | undefined => typeof document[key] === "number" ? document[key] as number : undefined;
const strings = (document: GitPmDocument, key: string): string[] => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
const configValues = (document: GitPmDocument, key: "statuses" | "issue_types"): ConfigValue[] => Array.isArray(document[key])
  ? (document[key] as unknown[]).filter((item): item is ConfigValue => typeof item === "object" && item !== null && typeof (item as ConfigValue).slug === "string" && typeof (item as ConfigValue).title === "string" && (item as ConfigValue).active === true)
  : [];
const compareOrder = (order: readonly string[], leftId: string, rightId: string) => {
  const left = order.indexOf(leftId); const right = order.indexOf(rightId);
  if (left < 0 && right >= 0) return 1;
  if (left >= 0 && right < 0) return -1;
  return left >= 0 && right >= 0 ? left - right : 0;
};
const moveId = (ids: readonly string[], id: string, offset: -1 | 1): string[] | null => {
  const from = ids.indexOf(id); const to = from + offset;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids]; [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
};
const compareTasks = (left: EntityResult, right: EntityResult, locale: Locale) => {
  const byTitle = text(left.document, "title").localeCompare(text(right.document, "title"), locale) || left.document.id.localeCompare(right.document.id);
  const byCompletion = Number(text(left.document, "status") === "done") - Number(text(right.document, "status") === "done");
  const byDue = (text(left.document, "due") || "9999-12-31").localeCompare(text(right.document, "due") || "9999-12-31");
  return byCompletion || byDue || byTitle;
};

export function ProjectPlanWorkspace({ api, draft, locale, projectId, selectedStageId = "", selectedTaskId = "", initialStatusFilter = "", initialMilestoneFilter = "", onNavigate, onChanged, confirmAction = () => true }: {
  readonly api: GitPmApi;
  readonly draft: DraftStatus;
  readonly locale: Locale;
  readonly projectId: string;
  readonly selectedStageId?: string;
  readonly selectedTaskId?: string;
  readonly initialStatusFilter?: string;
  readonly initialMilestoneFilter?: string;
  readonly onNavigate: WorkspaceNavigate;
  readonly onChanged: () => Promise<void>;
  readonly confirmAction?: (message: string) => boolean;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const loader = useAsyncLoad();
  const [workspace, setWorkspace] = useState<ProjectWorkspaceResult | null>(null);
  const [projects, setProjects] = useState<readonly EntityResult[]>([]);
  const [people, setPeople] = useState<readonly EntityResult[]>([]);
  const [statuses, setStatuses] = useState<readonly ConfigValue[]>([]);
  const [types, setTypes] = useState<readonly ConfigValue[]>([]);
  const [editor, setEditor] = useState<PlanEditor>(null);
  const [statusFilter, setStatusFilter] = useState(initialStatusFilter);
  const [milestoneFilter, setMilestoneFilter] = useState(initialMilestoneFilter);
  const [taskFields, setTaskFields] = useState<TaskFieldVisibility>(readTaskFields);
  const [error, setError] = useState<string | null>(null);
  const [orderPending, setOrderPending] = useState<readonly string[] | null>(null);
  const [statusPending, setStatusPending] = useState<string | null>(null);
  const { highlights: recentChanges, mark: markRecentChange } = useExternalHighlights(500);
  const reducedMotion = useReducedMotion();
  const animatedList = useFlipList(reducedMotion);
  const readOnly = draft.writer_mode !== "ui" || draft.state !== "open" || draft.changed_externally === true;

  const load = useCallback(async () => {
    await loader.run(async () => {
      const [nextWorkspace, nextProjects, nextPeople, statusConfig, typeConfig] = await Promise.all([
        api.projectWorkspace(draft.draft_id, projectId),
        api.listEntities(draft.draft_id, "projects"),
        api.listEntities(draft.draft_id, "people"),
        api.getConfiguration(draft.draft_id, "statuses"),
        api.getConfiguration(draft.draft_id, "issue-types"),
      ]);
      return { nextWorkspace, nextProjects, nextPeople, statusConfig, typeConfig };
    }, ({ nextWorkspace, nextProjects, nextPeople, statusConfig, typeConfig }) => {
      setWorkspace(nextWorkspace);
      setProjects(nextProjects.filter((item) => item.document.lifecycle === "active"));
      setPeople(nextPeople.filter((item) => item.document.lifecycle === "active"));
      setStatuses(configValues(statusConfig.document, "statuses"));
      setTypes(configValues(typeConfig.document, "issue_types"));
    });
  }, [api, draft.draft_id, draft.fingerprint, loader.run, projectId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setStatusFilter(initialStatusFilter); setMilestoneFilter(initialMilestoneFilter); }, [initialMilestoneFilter, initialStatusFilter]);
  useEffect(() => { writeTaskFields(taskFields); }, [taskFields]);

  const applyResult = (result: EntityResult) => {
    setWorkspace((current) => {
      if (current === null) return current;
      const schema = result.document.schema;
      if (result.document.id === current.project.document.id || schema === "gitpm/project@1") return { ...current, project: result, draft_fingerprint: result.draft_fingerprint };
      if (schema === "gitpm/milestone@1") return { ...current, milestones: upsertEntity(current.milestones, result), draft_fingerprint: result.draft_fingerprint };
      if (schema === "gitpm/task@1") return { ...current, tasks: upsertEntity(current.tasks, result), draft_fingerprint: result.draft_fingerprint };
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
      setError(caught instanceof Error ? caught.message : String(caught));
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
      setError(caught instanceof Error ? caught.message : String(caught));
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
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    }
  };

  const activeStages = useMemo(() => [...(workspace?.milestones.filter((item) => item.document.lifecycle === "active") ?? [])].sort((left, right) => {
    const byOrder = compareOrder(strings(workspace?.project.document ?? { schema: "", id: "", lifecycle: "active" }, "milestone_order"), left.document.id, right.document.id);
    const byDue = (text(left.document, "due") || "9999-12-31").localeCompare(text(right.document, "due") || "9999-12-31");
    return byOrder || byDue || text(left.document, "name").localeCompare(text(right.document, "name"), locale);
  }), [locale, workspace]);
  const activeTasks = useMemo(() => {
    const stages = new Map((workspace?.milestones ?? []).map((stage) => [stage.document.id, stage]));
    return [...(workspace?.tasks.filter((item) => item.document.lifecycle === "active") ?? [])].sort((left, right) => {
      const milestone = text(left.document, "milestone");
      const byOrder = milestone !== "" && milestone === text(right.document, "milestone")
        ? compareOrder(strings(stages.get(milestone)?.document ?? { schema: "", id: "", lifecycle: "active" }, "task_order"), left.document.id, right.document.id)
        : 0;
      return byOrder || compareTasks(left, right, locale);
    });
  }, [locale, workspace]);
  const visibleTasks = useMemo(() => activeTasks.filter((task) =>
    (statusFilter === "" || text(task.document, "status") === statusFilter)
    && (milestoneFilter === "" || (milestoneFilter === "none" ? text(task.document, "milestone") === "" : text(task.document, "milestone") === milestoneFilter))), [activeTasks, milestoneFilter, statusFilter]);
  const completed = activeTasks.filter((task) => text(task.document, "status") === "done").length;
  const overdue = activeTasks.filter((task) => text(task.document, "status") !== "done" && /^\d{4}-\d{2}-\d{2}$/u.test(text(task.document, "due")) && text(task.document, "due") < new Date().toISOString().slice(0, 10)).length;
  const activeStageIds = new Set(activeStages.map((stage) => stage.document.id));
  const visibleStages = milestoneFilter === "" ? activeStages : activeStages.filter((stage) => stage.document.id === milestoneFilter);
  const outsideStages = activeTasks.filter((task) => !activeStageIds.has(text(task.document, "milestone")));
  const visibleOutsideStages = visibleTasks.filter((task) => !activeStageIds.has(text(task.document, "milestone")));
  const navigationQuery = { ...(statusFilter ? { status: [statusFilter] } : {}), ...(milestoneFilter ? { milestone: [milestoneFilter] } : {}) };
  const progress = activeTasks.length === 0 ? 0 : Math.round(completed / activeTasks.length * 100);
  const statusTitle = (slug: string) => statuses.find((item) => item.slug === slug)?.title ?? slug;
  const dateLabel = (value: string) => /^\d{4}-\d{2}-\d{2}$/u.test(value) ? formatDateOnly(locale, value) : "—";
  const selectedStage = workspace?.milestones.find((item) => item.document.id === selectedStageId);
  const selectedTask = workspace?.tasks.find((item) => item.document.id === selectedTaskId);
  const catalog = useMemo(() => new EntityCatalog({ projects, milestones: workspace?.milestones ?? [], tasks: workspace?.tasks ?? [] }), [projects, workspace]);
  const closeInspector = () => onNavigate("projects", { projectId, ...(Object.keys(navigationQuery).length > 0 ? { query: navigationQuery } : {}) });
  const applyFilters = (status: string, milestone: string) => {
    setStatusFilter(status);
    setMilestoneFilter(milestone);
    const query = { ...(status ? { status: [status] } : {}), ...(milestone ? { milestone: [milestone] } : {}) };
    onNavigate("projects", { projectId, ...(Object.keys(query).length > 0 ? { query } : {}) });
  };
  const moveStage = (stageId: string, offset: -1 | 1) => {
    if (workspace === null || orderPending !== null || statusPending !== null) return;
    const stageIds = activeStages.map((stage) => stage.document.id);
    const milestoneOrder = moveId(stageIds, stageId, offset);
    if (milestoneOrder === null) return;
    const swappedStageId = stageIds[stageIds.indexOf(stageId) + offset]!;
    const previous = workspace;
    const document = { ...workspace.project.document, milestone_order: milestoneOrder } as GitPmDocument;
    setOrderPending([stageId, swappedStageId]);
    setWorkspace({ ...workspace, project: { ...workspace.project, document } });
    void mutate(async () => { const result = await api.updateEntity(draft.draft_id, "projects", previous.project, previous.draft_fingerprint, document); setOrderPending(null); return result; }, [stageId, swappedStageId])
      .then((success) => { if (!success) setWorkspace(previous); })
      .finally(() => setOrderPending(null));
  };
  const moveTask = (stage: EntityResult, taskId: string, offset: -1 | 1) => {
    if (workspace === null || orderPending !== null || statusPending !== null) return;
    const stageTasks = activeTasks.filter((task) => text(task.document, "milestone") === stage.document.id);
    const taskIds = stageTasks.map((task) => task.document.id);
    const taskOrder = moveId(taskIds, taskId, offset);
    if (taskOrder === null) return;
    const swappedTaskId = taskIds[taskIds.indexOf(taskId) + offset]!;
    const previous = workspace;
    const document = { ...stage.document, task_order: taskOrder } as GitPmDocument;
    setOrderPending([taskId, swappedTaskId]);
    setWorkspace({ ...workspace, milestones: workspace.milestones.map((item) => item.document.id === stage.document.id ? { ...item, document } : item) });
    void mutate(async () => { const result = await api.updateEntity(draft.draft_id, "milestones", stage, previous.draft_fingerprint, document); setOrderPending(null); return result; }, [taskId, swappedTaskId])
      .then((success) => { if (!success) setWorkspace(previous); })
      .finally(() => setOrderPending(null));
  };
  const changeTaskStatus = (task: EntityResult, status: string) => {
    if (workspace === null || orderPending !== null || statusPending !== null || text(task.document, "status") === status) return;
    const previous = workspace;
    const document = { ...task.document, status } as GitPmDocument;
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
    const owner = String(data.get("owner")); const start = String(data.get("start")); const due = String(data.get("due"));
    const document = {
      ...workspace.project.document,
      name: String(data.get("name")).trim(),
      status: String(data.get("status")),
      description_markdown: String(data.get("description")),
      owner: owner || undefined,
      start: start || undefined,
      due: due || undefined,
    } as GitPmDocument;
    void mutate(async () => await api.updateEntity(draft.draft_id, "projects", workspace.project, workspace.draft_fingerprint, document));
  };

  const createStage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (workspace === null) return;
    const data = new FormData(event.currentTarget);
    const id = newUniqueEntityId(ENTITY_ID_PREFIX.milestone, new Set(workspace.milestones.map((item) => item.document.id)));
    const document = { schema: "gitpm/milestone@1", id, project: projectId, name: String(data.get("name")).trim(), lifecycle: "active", description_markdown: String(data.get("description")), ...(data.get("due") ? { due: String(data.get("due")) } : {}) } as GitPmDocument;
    void mutate(async () => await api.createEntity(draft.draft_id, "milestones", workspace.draft_fingerprint, document));
  };

  const updateStage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (workspace === null || editor?.kind !== "edit-stage") return;
    const stage = workspace.milestones.find((item) => item.document.id === editor.stageId);
    if (stage === undefined) return;
    const data = new FormData(event.currentTarget);
    const due = String(data.get("due"));
    const document = { ...stage.document, name: String(data.get("name")).trim(), description_markdown: String(data.get("description")), ...(due ? { due } : { due: undefined }) } as GitPmDocument;
    void mutate(async () => await api.updateEntity(draft.draft_id, "milestones", stage, workspace.draft_fingerprint, document));
  };

  const archiveStage = (stage: EntityResult) => {
    if (workspace === null) return;
    const count = activeTasks.filter((task) => task.document.milestone === stage.document.id).length;
    if (!confirmAction(t("core.archiveMilestoneConfirm", { name: text(stage.document, "name"), count }))) return;
    void mutate(async () => await api.archiveEntity(draft.draft_id, "milestones", stage, workspace.draft_fingerprint)).then((success) => { if (success) closeInspector(); });
  };

  const createTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (workspace === null || editor?.kind !== "task") return;
    const data = new FormData(event.currentTarget);
    const id = newUniqueEntityId(ENTITY_ID_PREFIX.task, new Set(workspace.tasks.map((item) => item.document.id)));
    const start = String(data.get("start")); const due = String(data.get("due")); const estimate = String(data.get("estimate"));
    const document = {
      schema: "gitpm/task@1", id, project: projectId, title: String(data.get("title")).trim(), type: String(data.get("type")), status: String(data.get("status")), lifecycle: "active",
      description_markdown: String(data.get("description")),
      assignees: data.getAll("assignees").map(String),
      ...(editor.stageId === undefined ? {} : { milestone: editor.stageId }),
      ...(start ? { start } : {}),
      ...(due ? { due } : {}),
      ...(estimate ? { estimate_hours: Number(estimate) } : {}),
    } as GitPmDocument;
    void mutate(async () => await api.createEntity(draft.draft_id, "tasks", workspace.draft_fingerprint, document));
  };

  const archiveProject = () => {
    if (workspace === null || !confirmAction(t("projectPlan.archiveConfirm", { name: text(workspace.project.document, "name") }))) return;
    void mutate(async () => await api.archiveEntity(draft.draft_id, "projects", workspace.project, workspace.draft_fingerprint)).then((success) => { if (success) onNavigate("projects"); });
  };

  const deleteProject = async () => {
    if (workspace === null || !confirmAction(t("core.deleteConfirm", { name: text(workspace.project.document, "name") }))) return;
    setError(null);
    try {
      await api.deleteEntity(draft.draft_id, "projects", workspace.project, workspace.draft_fingerprint);
      await onChanged();
      setEditor(null);
      onNavigate("projects");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return <section className="project-plan-workspace">
    {error !== null && <div className="alert error">{error}</div>}
    <AsyncBoundary state={loader.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{loadError}<button onClick={retry}>{t("status.retry")}</button></div>}>
      {workspace !== null && <div className={`project-plan-layout${selectedStage !== undefined || selectedTask !== undefined ? " with-inspector" : ""}`}>
        <div className="project-plan-main">
          <header className={`project-plan-header${recentChanges[workspace.project.document.id] ? " recently-changed" : ""}`}>
            <div className="project-plan-title"><span className="project-plan-project-kind">{t("core.project")} <code>{workspace.project.document.id}</code></span><h2>{text(workspace.project.document, "name")}</h2><p>{text(workspace.project.document, "description_markdown") || t("core.noDescription")}</p></div>
            <div className="project-plan-actions"><button disabled={readOnly} onClick={() => setEditor({ kind: "project" })}>{t("core.edit")}</button><button disabled={readOnly} onClick={() => setEditor({ kind: "new-stage" })}>+ {t("stages.new")}</button><button className="primary" disabled={readOnly} onClick={() => setEditor({ kind: "task" })}>+ {t("core.createTaskAction")}</button></div>
            <dl className="project-plan-meta">
              <div><dt>{t("core.status")}</dt><dd><span className="state open">{statusTitle(text(workspace.project.document, "status"))}</span></dd></div>
              <div><dt>{t("core.owner")}</dt><dd><PersonLinks empty={t("core.unassigned")} onOpen={(personId) => onNavigate("people", { personId })} people={people} personIds={text(workspace.project.document, "owner") ? [text(workspace.project.document, "owner")] : []} /></dd></div>
              <div><dt>{t("projectPlan.start")}</dt><dd>{dateLabel(text(workspace.project.document, "start"))}</dd></div>
              <div><dt>{t("core.due")}</dt><dd>{dateLabel(text(workspace.project.document, "due"))}</dd></div>
            </dl>
          </header>

          <dl className="project-plan-summary">
            <div><dt>{t("projectPlan.progress")}</dt><dd>{progress}% <small>{t("stages.progress", { completed, count: activeTasks.length })}</small></dd></div>
            <div><dt>{t("projectPlan.stages")}</dt><dd>{activeStages.length}</dd></div>
            <div><dt>{t("projectPlan.overdue")}</dt><dd>{overdue}</dd></div>
            <div><dt>{t("projectPlan.withoutStage")}</dt><dd>{outsideStages.length}</dd></div>
          </dl>

          <section className="project-plan-work" ref={animatedList}>
            <div className="project-plan-toolbar">
              <div><h2>{t("projectPlan.workHeading")}</h2><span>{t("projectPlan.workDescription")}</span></div>
              <label>{t("core.filter")}<select value={statusFilter} onChange={(event) => applyFilters(event.target.value, milestoneFilter)}><option value="">{t("core.allStatuses")}</option>{statuses.map((status) => <option key={status.slug} value={status.slug}>{status.title}</option>)}</select></label>
              <label>{t("core.milestone")}<select value={milestoneFilter} onChange={(event) => applyFilters(statusFilter, event.target.value)}><option value="">{t("core.allMilestones")}</option><option value="none">{t("stages.withoutStage")}</option>{activeStages.map((stage) => <option key={stage.document.id} value={stage.document.id}>{text(stage.document, "name")}</option>)}</select></label>
              <details className="task-field-settings"><summary>{t("projectPlan.configureFields")}</summary><div>{(["assignees", "due", "estimate", "status"] as const).map((field) => <label key={field}><input checked={taskFields[field]} onChange={(event) => setTaskFields((current) => ({ ...current, [field]: event.target.checked }))} type="checkbox" />{t(`projectPlan.field.${field}` as MessageKey)}</label>)}</div></details>
            </div>
            {activeStages.length === 0 && <div className="card empty-workspace">{t("projectPlan.emptyStages")}</div>}
            {visibleStages.map((stage) => <StageSection
              allTasks={activeTasks.filter((task) => task.document.milestone === stage.document.id)}
              key={stage.document.id}
              locale={locale}
              people={people}
              onNavigate={onNavigate}
              onNewTask={() => setEditor({ kind: "task", stageId: stage.document.id })}
              onMoveStage={(offset) => moveStage(stage.document.id, offset)}
              onMoveTask={(taskId, offset) => moveTask(stage, taskId, offset)}
              onStatusChange={changeTaskStatus}
              orderBusy={orderPending !== null || statusPending !== null}
              projectId={projectId}
              query={navigationQuery}
              readOnly={readOnly}
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
              t={t}
            />)}
            {(milestoneFilter === "" || milestoneFilter === "none") && <section className={`project-plan-stage project-plan-unassigned${visibleOutsideStages.length > 0 ? " has-work" : ""}`}>
              <header><div><span className="project-plan-stage-kind">{t("projectPlan.systemGroup")}</span><h3>{t("projectPlan.unassignedHeading")}</h3><p>{t("projectPlan.unassignedDescription")}</p></div><div className="project-plan-stage-actions"><button disabled={readOnly} onClick={() => setEditor({ kind: "task" })}>+ {t("core.createTaskAction")}</button></div></header>
              <TaskRows allTasks={outsideStages} locale={locale} onNavigate={onNavigate} onStatusChange={changeTaskStatus} people={people} projectId={projectId} query={navigationQuery} readOnly={readOnly} savingTaskIds={new Set([...(orderPending ?? []), ...(statusPending === null ? [] : [statusPending])])} selectedTaskId={selectedTaskId} statusBusy={statusPending !== null} statusOptions={statuses} statusTitle={statusTitle} taskFields={taskFields} tasks={visibleOutsideStages} t={t} />
            </section>}
          </section>
        </div>

        {selectedStage !== undefined && <aside className="project-plan-inspector" aria-label={t("core.milestone")}>
          <button aria-label={t("core.closeEditor")} className="inspector-close" onClick={closeInspector} type="button">×</button>
          <span className="eyebrow">{t("core.milestone")}</span><h2>{text(selectedStage.document, "name")}</h2><code className="project-plan-inspector-id">{selectedStage.document.id}</code><p>{text(selectedStage.document, "description_markdown") || t("core.noDescription")}</p>
          <dl className="project-plan-inspector-stats"><div><dt>{t("stages.progressLabel")}</dt><dd>{activeTasks.filter((task) => task.document.milestone === selectedStage.document.id && text(task.document, "status") === "done").length}/{activeTasks.filter((task) => task.document.milestone === selectedStage.document.id).length}</dd></div><div><dt>{t("stages.estimate")}</dt><dd>{formatDurationHours(locale, activeTasks.filter((task) => task.document.milestone === selectedStage.document.id).reduce((sum, task) => sum + (number(task.document, "estimate_hours") ?? 0), 0))}</dd></div><div><dt>{t("core.due")}</dt><dd>{dateLabel(text(selectedStage.document, "due"))}</dd></div></dl>
          <div className="inspector-actions"><button disabled={readOnly} onClick={() => setEditor({ kind: "edit-stage", stageId: selectedStage.document.id })}>{t("core.edit")}</button><button disabled={readOnly} onClick={() => archiveStage(selectedStage)}>{t("core.archive")}</button><button className="primary" disabled={readOnly} onClick={() => setEditor({ kind: "task", stageId: selectedStage.document.id })}>+ {t("core.createTaskAction")}</button></div>
        </aside>}

        {selectedTask !== undefined && <aside className="project-plan-inspector task-inspector" aria-label={t("core.details")}>
          <button aria-label={t("core.closeEditor")} className="inspector-close" onClick={closeInspector} type="button">×</button>
          <TaskPanel api={api} catalog={catalog} confirmDelete={(name) => confirmAction(t("core.deleteConfirm", { name }))} draft={draft} entity={selectedTask} fingerprint={workspace.draft_fingerprint} key={selectedTask.document.id} locale={locale} milestones={workspace.milestones} onDeleted={closeInspector} onNavigate={onNavigate} onStatusChange={(status) => changeTaskStatus(selectedTask, status)} people={people} projects={projects} readOnly={readOnly} remove={removeEntity} save={saveEntity} statusBusy={statusPending !== null} statusOptions={statuses} typeOptions={types} />
        </aside>}
      </div>}
    </AsyncBoundary>

    {workspace !== null && <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditor(null)} open={editor?.kind === "project"} title={`${t("core.edit")}: ${text(workspace.project.document, "name")}`}>
      <form className="editor-drawer-form" onSubmit={updateProject}>
        <label>{t("core.name")}<input defaultValue={text(workspace.project.document, "name")} disabled={readOnly} name="name" required /></label>
        <label>{t("core.status")}<select defaultValue={text(workspace.project.document, "status")} disabled={readOnly} name="status">{statuses.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select></label>
        <label>{t("core.owner")}<select defaultValue={text(workspace.project.document, "owner")} disabled={readOnly} name="owner"><option value="">{t("core.unassigned")}</option>{people.map((person) => <option key={person.document.id} value={person.document.id}>{text(person.document, "name")}</option>)}</select></label>
        <label>{t("projectPlan.start")}<input defaultValue={text(workspace.project.document, "start")} disabled={readOnly} name="start" type="date" /></label>
        <label>{t("core.due")}<input defaultValue={text(workspace.project.document, "due")} disabled={readOnly} name="due" type="date" /></label>
        <label>{t("core.description")}<textarea defaultValue={text(workspace.project.document, "description_markdown")} disabled={readOnly} name="description" /></label>
        <div className="editor-drawer-actions"><details className="more-actions"><summary>{t("core.moreActions")}</summary><div><button disabled={readOnly} onClick={archiveProject} type="button">{t("core.archive")}</button><button className="danger" disabled={readOnly} onClick={() => { void deleteProject(); }} type="button">{t("core.delete")}</button></div></details><button onClick={() => setEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.save")}</button></div>
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
          <label>{t("core.due")}<input defaultValue={text(stage.document, "due")} disabled={readOnly} name="due" type="date" /></label>
          <label>{t("core.description")}<textarea defaultValue={text(stage.document, "description_markdown")} disabled={readOnly} name="description" /></label>
          <div className="editor-drawer-actions"><button onClick={() => setEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.save")}</button></div>
        </form>
      </EditorDrawer>;
    })()}

    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditor(null)} open={editor?.kind === "task"} title={t("core.createTaskAction")}>
      <form className="editor-drawer-form" onSubmit={createTask}>
        <label>{t("core.title")}<input disabled={readOnly} name="title" required /></label>
        <label>{t("core.status")}<select disabled={readOnly} name="status">{statuses.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select></label>
        <label>{t("core.type")}<select disabled={readOnly} name="type">{types.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select></label>
        <AssigneeChecks disabled={readOnly} people={people} selected={[]} t={t} />
        <label>{t("projectPlan.start")}<input disabled={readOnly} name="start" type="date" /></label>
        <label>{t("core.due")}<input disabled={readOnly} name="due" type="date" /></label>
        <label>{t("projectPlan.estimate")}<input disabled={readOnly} min="0" name="estimate" step="0.25" type="number" /></label>
        <label>{t("core.description")}<textarea disabled={readOnly} name="description" /></label>
        <div className="editor-drawer-actions"><button onClick={() => setEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.createTask")}</button></div>
      </form>
    </EditorDrawer>
  </section>;
}

function StageSection({ stage, tasks, allTasks, stageIndex, stageCount, projectId, query, locale, people, readOnly, orderBusy, selected, changed, saving, selectedTaskId, changedTaskIds, savingTaskIds, statusTitle, statusOptions, statusBusy, taskFields, onNewTask, onMoveStage, onMoveTask, onStatusChange, onNavigate, t }: {
  readonly stage: EntityResult;
  readonly tasks: readonly EntityResult[];
  readonly allTasks: readonly EntityResult[];
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
  readonly onNewTask: () => void;
  readonly onMoveStage: (offset: -1 | 1) => void;
  readonly onMoveTask: (taskId: string, offset: -1 | 1) => void;
  readonly onStatusChange: (task: EntityResult, status: string) => void;
  readonly onNavigate: WorkspaceNavigate;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const completed = allTasks.filter((task) => text(task.document, "status") === "done").length;
  const progress = allTasks.length === 0 ? 0 : Math.round(completed / allTasks.length * 100);
  const stageAssigneeIds = [...new Set(allTasks.flatMap((task) => strings(task.document, "assignees")))];
  return <article className={`project-plan-stage${selected ? " selected" : ""}${changed ? " recently-changed" : ""}${saving ? " is-saving" : ""}`} data-flip-key={`stage:${stage.document.id}`}>
    <header>
      <button aria-current={selected ? "true" : undefined} aria-label={`${t("core.milestone")}: ${text(stage.document, "name")} · ${stage.document.id}`} className="project-plan-stage-selector" onClick={() => onNavigate("stages", { projectId, stageId: stage.document.id, ...(Object.keys(query).length > 0 ? { query } : {}) })} type="button">
        <span className="project-plan-stage-kind">{t("core.milestone")} {stageIndex + 1}. <code>{stage.document.id}</code>.</span>
        <span aria-level={3} className="project-plan-stage-title" role="heading">{text(stage.document, "name")}</span>
        <span className="project-plan-stage-description">{text(stage.document, "description_markdown") || t("core.noDescription")}</span>
        {taskFields.assignees && <span className="project-plan-stage-assignees">{t("core.assignees")}: <PersonLinks empty={t("core.unassigned")} onOpen={(personId) => onNavigate("people", { personId })} people={people} personIds={stageAssigneeIds} /></span>}
      </button>
      <div className="project-plan-stage-actions"><span className="plan-order-controls"><button aria-label={t("projectPlan.moveStageUp", { number: stageIndex + 1 })} disabled={readOnly || orderBusy || stageIndex === 0} onClick={() => onMoveStage(-1)} type="button">↑</button><button aria-label={t("projectPlan.moveStageDown", { number: stageIndex + 1 })} disabled={readOnly || orderBusy || stageIndex === stageCount - 1} onClick={() => onMoveStage(1)} type="button">↓</button></span><time dateTime={text(stage.document, "due")}>{text(stage.document, "due") ? formatDateOnly(locale, text(stage.document, "due")) : "—"}</time><button disabled={readOnly} onClick={onNewTask}>+ {t("core.createTaskAction")}</button></div>
    </header>
    <div className="project-plan-stage-progress"><progress aria-label={t("stages.progressLabel")} max="100" value={progress}>{progress}%</progress><span>{t("stages.progress", { completed, count: allTasks.length })}</span></div>
    <TaskRows allTasks={allTasks} changedTaskIds={changedTaskIds} locale={locale} onMoveTask={onMoveTask} onNavigate={onNavigate} onStatusChange={onStatusChange} orderBusy={orderBusy} people={people} projectId={projectId} query={query} readOnly={readOnly} savingTaskIds={savingTaskIds} selectedTaskId={selectedTaskId} statusBusy={statusBusy} statusOptions={statusOptions} statusTitle={statusTitle} taskFields={taskFields} tasks={tasks} t={t} />
  </article>;
}

function TaskRows({ tasks, allTasks, projectId, query = {}, locale, people, readOnly = true, orderBusy = false, selectedTaskId, changedTaskIds = new Set<string>(), savingTaskIds = new Set<string>(), statusTitle, statusOptions = [], statusBusy = false, taskFields, onMoveTask, onStatusChange, onNavigate, t }: {
  readonly tasks: readonly EntityResult[];
  readonly allTasks: readonly EntityResult[];
  readonly projectId: string;
  readonly query?: Readonly<Record<string, readonly string[]>>;
  readonly locale: Locale;
  readonly people: readonly EntityResult[];
  readonly readOnly?: boolean;
  readonly orderBusy?: boolean;
  readonly selectedTaskId: string;
  readonly changedTaskIds?: ReadonlySet<string>;
  readonly savingTaskIds?: ReadonlySet<string>;
  readonly statusTitle: (slug: string) => string;
  readonly statusOptions?: readonly ConfigValue[];
  readonly statusBusy?: boolean;
  readonly taskFields: TaskFieldVisibility;
  readonly onMoveTask?: (taskId: string, offset: -1 | 1) => void;
  readonly onStatusChange?: (task: EntityResult, status: string) => void;
  readonly onNavigate: WorkspaceNavigate;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  if (tasks.length === 0) return <p className="project-plan-empty-tasks">{t("stages.emptyTasks")}</p>;
  return <div className="project-plan-task-list">{tasks.map((task) => {
    const selected = selectedTaskId === task.document.id;
    const taskIndex = allTasks.findIndex((item) => item.document.id === task.document.id);
    const assignees = strings(task.document, "assignees");
    return <div className={`project-plan-task-row${selected ? " selected" : ""}${changedTaskIds.has(task.document.id) ? " recently-changed" : ""}${savingTaskIds.has(task.document.id) ? " is-saving" : ""}`} data-flip-key={`task:${task.document.id}`} key={task.document.id}>
      <button aria-current={selected ? "true" : undefined} className="project-plan-task-selector" onClick={() => onNavigate("tasks", { projectId, taskId: task.document.id, ...(Object.keys(query).length > 0 ? { query } : {}) })} type="button"><span className="project-plan-task-kind">{t("projectPlan.taskLabel")} {taskIndex + 1}. <code>{task.document.id}</code>.</span><strong>{text(task.document, "title")}</strong></button>
      <span className="project-plan-task-meta">{taskFields.assignees && <span className="task-assignees"><PersonLinks empty={t("core.unassigned")} onOpen={(personId) => onNavigate("people", { personId })} people={people} personIds={assignees} /></span>}{taskFields.due && text(task.document, "due") && <time dateTime={text(task.document, "due")}>{formatDateOnly(locale, text(task.document, "due"))}</time>}{taskFields.estimate && number(task.document, "estimate_hours") !== undefined && <span>{number(task.document, "estimate_hours")}h</span>}{taskFields.status && (onStatusChange === undefined || readOnly ? <span className="state open">{statusTitle(text(task.document, "status"))}</span> : <select aria-label={`${t("core.status")}: ${text(task.document, "title")}`} className="inline-status-select" disabled={statusBusy} onChange={(event) => onStatusChange(task, event.target.value)} value={text(task.document, "status")}>{statusOptions.map((status) => <option key={status.slug} value={status.slug}>{status.title}</option>)}</select>)}{onMoveTask !== undefined && <span className="plan-order-controls"><button aria-label={t("projectPlan.moveTaskUp", { number: taskIndex + 1 })} disabled={readOnly || orderBusy || taskIndex === 0} onClick={() => onMoveTask(task.document.id, -1)} type="button">↑</button><button aria-label={t("projectPlan.moveTaskDown", { number: taskIndex + 1 })} disabled={readOnly || orderBusy || taskIndex === allTasks.length - 1} onClick={() => onMoveTask(task.document.id, 1)} type="button">↓</button></span>}</span>
    </div>;
  })}</div>;
}
