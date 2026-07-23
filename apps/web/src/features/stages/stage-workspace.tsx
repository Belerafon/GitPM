import { ENTITY_ID_PREFIX, newUniqueEntityId } from "@gitpm/shared";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { GitPmApi } from "../../api.js";
import { AsyncBoundary, useAsyncLoad } from "../../async-data.js";
import { AssigneeChecks } from "../../core-ui.js";
import { EditorDrawer } from "../../editor-drawer.js";
import { useExternalHighlights } from "../../external-updates.js";
import { formatDateOnly, formatDurationHours, message, type Locale, type MessageKey } from "../../i18n.js";
import { upsertEntity } from "../../optimistic-ui.js";
import type { DraftStatus, EntityDocument, EntityResult, GitPmDocument, ProjectWorkspaceResult } from "../../types.js";
import type { WorkspaceNavigate } from "../../workspace-navigation.js";
import { PersonLinks } from "../../person-link.js";
import { draftReadOnlyReason } from "../../draft-read-only.js";

interface ConfigValue { readonly slug: string; readonly title: string; readonly active: boolean }
const text = (document: GitPmDocument, key: string): string => typeof document[key] === "string" ? document[key] as string : "";
const configValues = (document: GitPmDocument, key: "statuses" | "issue_types"): ConfigValue[] => Array.isArray(document[key])
  ? (document[key] as unknown[]).filter((item): item is ConfigValue => typeof item === "object" && item !== null && typeof (item as ConfigValue).slug === "string" && typeof (item as ConfigValue).title === "string" && (item as ConfigValue).active === true)
  : [];

export function StageWorkspace({ api, draft, locale, projectId, stageId, onNavigate, onChanged, confirmAction = () => true }: {
  readonly api: GitPmApi;
  readonly draft: DraftStatus;
  readonly locale: Locale;
  readonly projectId: string;
  readonly stageId: string;
  readonly onNavigate: WorkspaceNavigate;
  readonly onChanged: () => Promise<void>;
  readonly confirmAction?: (message: string) => boolean;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const loader = useAsyncLoad();
  const [workspace, setWorkspace] = useState<ProjectWorkspaceResult | null>(null);
  const [statuses, setStatuses] = useState<readonly ConfigValue[]>([]);
  const [types, setTypes] = useState<readonly ConfigValue[]>([]);
  const [people, setPeople] = useState<readonly EntityResult[]>([]);
  const [editor, setEditor] = useState<"stage" | "task" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusPending, setStatusPending] = useState<string | null>(null);
  const { highlights, mark } = useExternalHighlights(500);
  const readOnly = draftReadOnlyReason(draft) !== null;

  const load = useCallback(async () => {
    await loader.run(async () => {
      const [nextWorkspace, nextPeople, statusConfig, typeConfig] = await Promise.all([
        api.projectWorkspace(draft.draft_id, projectId),
        api.listEntities(draft.draft_id, "people"),
        api.getConfiguration(draft.draft_id, "statuses"),
        api.getConfiguration(draft.draft_id, "issue-types"),
      ]);
      return { nextWorkspace, nextPeople, statusConfig, typeConfig };
    }, ({ nextWorkspace, nextPeople, statusConfig, typeConfig }) => {
      setWorkspace(nextWorkspace);
      setPeople(nextPeople.filter((item) => item.document.lifecycle === "active"));
      setStatuses(configValues(statusConfig.document, "statuses"));
      setTypes(configValues(typeConfig.document, "issue_types"));
    });
  }, [api, draft.draft_id, draft.fingerprint, loader.run, projectId]);

  useEffect(() => { void load(); }, [load]);

  const mutate = async (operation: () => Promise<EntityResult>) => {
    setError(null);
    try {
      const result = await operation();
      setWorkspace((current) => current === null ? current : result.document.schema === "gitpm/milestone@1"
        ? { ...current, milestones: upsertEntity(current.milestones, result), draft_fingerprint: result.draft_fingerprint }
        : result.document.schema === "gitpm/task@1"
          ? { ...current, tasks: upsertEntity(current.tasks, result), draft_fingerprint: result.draft_fingerprint }
          : current);
      mark({ [result.document.id]: ["$local"] });
      await onChanged();
      await load();
      setEditor(null);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    }
  };

  const activeTasks = useMemo(() => workspace?.tasks.filter((item) => item.document.lifecycle === "active") ?? [], [workspace]);
  const selectedStage = workspace?.milestones.find((item) => item.document.id === stageId);
  const stageTasks = stageId === "" ? [] : activeTasks.filter((item) => item.document.milestone === stageId).sort((left, right) => {
    const byCompletion = Number(text(left.document, "status") === "done") - Number(text(right.document, "status") === "done");
    const byDue = (text(left.document, "due") || "9999-12-31").localeCompare(text(right.document, "due") || "9999-12-31");
    return byCompletion !== 0 ? byCompletion : byDue !== 0 ? byDue : text(left.document, "title").localeCompare(text(right.document, "title"));
  });

  const updateStage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (workspace === null || selectedStage === undefined) return;
    const data = new FormData(event.currentTarget);
    const due = String(data.get("due"));
    const document = { ...selectedStage.document, name: String(data.get("name")).trim(), description_markdown: String(data.get("description")), ...(due ? { due } : { due: undefined }) } as EntityDocument;
    void mutate(async () => await api.updateEntity(draft.draft_id, "milestones", selectedStage, workspace.draft_fingerprint, document));
  };

  const createTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (workspace === null || selectedStage === undefined) return;
    const data = new FormData(event.currentTarget);
    const id = newUniqueEntityId(ENTITY_ID_PREFIX.task, new Set(workspace.tasks.map((item) => item.document.id)));
    const start = String(data.get("start")); const due = String(data.get("due")); const estimate = String(data.get("estimate"));
    const document = { schema: "gitpm/task@1", id, project: projectId, milestone: selectedStage.document.id, title: String(data.get("title")).trim(), type: String(data.get("type")), status: String(data.get("status")), lifecycle: "active", description_markdown: String(data.get("description")), assignees: data.getAll("assignees").map(String), ...(start ? { start } : {}), ...(due ? { due } : {}), ...(estimate ? { estimate_hours: Number(estimate) } : {}) } as EntityDocument;
    void mutate(async () => await api.createEntity(draft.draft_id, "tasks", workspace.draft_fingerprint, document));
  };

  const archiveStage = () => {
    if (workspace === null || selectedStage === undefined || !confirmAction(t("core.archiveMilestoneConfirm", { name: text(selectedStage.document, "name"), count: stageTasks.length }))) return;
    void mutate(async () => await api.archiveEntity(draft.draft_id, "milestones", selectedStage, workspace.draft_fingerprint)).then((success) => { if (success) onNavigate("projects", { projectId }); });
  };
  const changeTaskStatus = (task: EntityResult, status: string) => {
    if (workspace === null || statusPending !== null || text(task.document, "status") === status) return;
    const previous = workspace;
    const document = { ...task.document, status } as EntityDocument;
    setStatusPending(task.document.id);
    setWorkspace({ ...workspace, tasks: workspace.tasks.map((item) => item.document.id === task.document.id ? { ...item, document } : item) });
    void mutate(async () => { const result = await api.updateEntity(draft.draft_id, "tasks", task, previous.draft_fingerprint, document); setStatusPending(null); return result; })
      .then((success) => { if (!success) setWorkspace(previous); })
      .finally(() => setStatusPending(null));
  };

  return <section className="stage-workspace">
    {error !== null && <div className="alert error">{error}</div>}
    <AsyncBoundary state={loader.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{loadError}<button onClick={retry}>{t("status.retry")}</button></div>}>
      {workspace !== null && (selectedStage === undefined ? <div className="card empty-workspace">{t("stages.notFound")}</div> : <StageDetails
        locale={locale}
        changed={highlights[selectedStage.document.id] !== undefined}
        changedTaskIds={new Set(Object.keys(highlights))}
        onArchive={archiveStage}
        onEdit={() => setEditor("stage")}
        onNewTask={() => setEditor("task")}
        onNavigate={onNavigate}
        onStatusChange={changeTaskStatus}
        people={people}
        projectId={projectId}
        readOnly={readOnly || selectedStage.document.lifecycle === "archived"}
        stage={selectedStage}
        tasks={stageTasks}
        statusOptions={statuses}
        statusBusy={statusPending !== null}
        statusSavingId={statusPending}
        t={t}
      />)}
    </AsyncBoundary>

    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditor(null)} open={editor === "stage"} title={t("stages.edit")}>
      <form className="editor-drawer-form" onSubmit={updateStage}>
        <label>{t("core.name")}<input defaultValue={selectedStage === undefined ? "" : text(selectedStage.document, "name")} disabled={readOnly} name="name" required /></label>
        <label>{t("core.due")}<input defaultValue={selectedStage === undefined ? "" : text(selectedStage.document, "due")} disabled={readOnly} name="due" type="date" /></label>
        <label>{t("core.description")}<textarea defaultValue={selectedStage === undefined ? "" : text(selectedStage.document, "description_markdown")} disabled={readOnly} name="description" /></label>
        <div className="editor-drawer-actions"><button onClick={() => setEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.save")}</button></div>
      </form>
    </EditorDrawer>

    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditor(null)} open={editor === "task"} title={t("stages.newTask")}>
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

function StageDetails({ stage, tasks, projectId, locale, people, readOnly, changed, changedTaskIds, statusOptions, statusBusy, statusSavingId, onArchive, onEdit, onNewTask, onStatusChange, onNavigate, t }: {
  readonly stage: EntityResult;
  readonly tasks: readonly EntityResult[];
  readonly projectId: string;
  readonly locale: Locale;
  readonly people: readonly EntityResult[];
  readonly readOnly: boolean;
  readonly changed: boolean;
  readonly changedTaskIds: ReadonlySet<string>;
  readonly statusOptions: readonly ConfigValue[];
  readonly statusBusy: boolean;
  readonly statusSavingId: string | null;
  readonly onArchive: () => void;
  readonly onEdit: () => void;
  readonly onNewTask: () => void;
  readonly onStatusChange: (task: EntityResult, status: string) => void;
  readonly onNavigate: WorkspaceNavigate;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const completed = tasks.filter((task) => text(task.document, "status") === "done").length;
  const overdue = tasks.filter((task) => text(task.document, "status") !== "done" && /^\d{4}-\d{2}-\d{2}$/u.test(text(task.document, "due")) && text(task.document, "due") < new Date().toISOString().slice(0, 10)).length;
  const estimate = tasks.reduce((sum, task) => sum + (typeof task.document.estimate_hours === "number" ? task.document.estimate_hours : 0), 0);
  const stageAssignees = [...new Set(tasks.flatMap((task) => Array.isArray(task.document.assignees) ? task.document.assignees.filter((id): id is string => typeof id === "string") : []))];
  return <>
    <header className={`card stage-detail-header${changed ? " recently-changed" : ""}`}>
      <div><span className="eyebrow">{t("core.milestone")}</span><h2>{text(stage.document, "name")}</h2><p>{text(stage.document, "description_markdown") || t("core.noDescription")}</p><p className="stage-detail-assignees">{t("core.assignees")}: <PersonLinks empty={t("core.unassigned")} onOpen={(personId) => onNavigate("people", { personId })} people={people} personIds={stageAssignees} /></p></div>
      <div className="stage-detail-actions"><button disabled={readOnly} onClick={onEdit}>{t("core.edit")}</button><button disabled={readOnly} onClick={onArchive}>{t("core.archive")}</button><button className="primary" disabled={readOnly} onClick={onNewTask}>+ {t("stages.newTask")}</button></div>
    </header>
    <div className="stage-stats">
      <div className="card"><span>{t("stages.progressLabel")}</span><strong>{completed}/{tasks.length}</strong></div>
      <div className="card"><span>{t("stages.overdue")}</span><strong>{overdue}</strong></div>
      <div className="card"><span>{t("stages.estimate")}</span><strong>{formatDurationHours(locale, estimate)}</strong></div>
      <div className="card"><span>{t("core.due")}</span><strong>{text(stage.document, "due") ? formatDateOnly(locale, text(stage.document, "due")) : "—"}</strong></div>
    </div>
    <section className="card stage-task-list"><div className="card-heading"><div><h3>{t("stages.tasks")}</h3><p>{t("stages.tasksDescription")}</p></div><button onClick={() => onNavigate("board", { projectId, query: { milestone: [stage.document.id] } })}>{t("stages.openBoard")}</button></div>
      {tasks.length === 0 ? <p>{t("stages.emptyTasks")}</p> : tasks.map((task) => { const assignees = Array.isArray(task.document.assignees) ? task.document.assignees.filter((id): id is string => typeof id === "string") : []; return <div className={`stage-task-row${changedTaskIds.has(task.document.id) ? " recently-changed" : ""}${statusSavingId === task.document.id ? " is-saving" : ""}`} key={task.document.id}>
        <button className="stage-task-link" onClick={() => onNavigate("tasks", { projectId, taskId: task.document.id })}><strong>{text(task.document, "title")}</strong><code>{task.document.id}</code><span className="task-assignees"><PersonLinks empty={t("core.unassigned")} onOpen={(personId) => onNavigate("people", { personId })} people={people} personIds={assignees} /></span></button>{readOnly ? <span className="state open">{statusOptions.find((status) => status.slug === text(task.document, "status"))?.title ?? text(task.document, "status")}</span> : <select aria-label={`${t("core.status")}: ${text(task.document, "title")}`} className="inline-status-select" disabled={statusBusy} onChange={(event) => onStatusChange(task, event.target.value)} value={text(task.document, "status")}>{statusOptions.map((status) => <option key={status.slug} value={status.slug}>{status.title}</option>)}</select>}
      </div>; })}
    </section>
  </>;
}
