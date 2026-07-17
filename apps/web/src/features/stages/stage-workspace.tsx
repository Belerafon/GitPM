import { ENTITY_ID_PREFIX, newUniqueEntityId } from "@gitpm/shared";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { GitPmApi } from "../../api.js";
import { AsyncBoundary, useAsyncLoad } from "../../async-data.js";
import { EditorDrawer } from "../../editor-drawer.js";
import { formatDateOnly, formatDurationHours, message, type Locale, type MessageKey } from "../../i18n.js";
import type { DraftStatus, EntityResult, GitPmDocument, ProjectWorkspaceResult } from "../../types.js";
import type { WorkspaceNavigate } from "../../workspace-navigation.js";

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
  const [editor, setEditor] = useState<"stage" | "task" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readOnly = draft.writer_mode !== "ui" || draft.state !== "open" || draft.changed_externally === true;

  const load = useCallback(async () => {
    await loader.run(async () => {
      const [nextWorkspace, statusConfig, typeConfig] = await Promise.all([
        api.projectWorkspace(draft.draft_id, projectId),
        api.getConfiguration(draft.draft_id, "statuses"),
        api.getConfiguration(draft.draft_id, "issue-types"),
      ]);
      return { nextWorkspace, statusConfig, typeConfig };
    }, ({ nextWorkspace, statusConfig, typeConfig }) => {
      setWorkspace(nextWorkspace);
      setStatuses(configValues(statusConfig.document, "statuses"));
      setTypes(configValues(typeConfig.document, "issue_types"));
    });
  }, [api, draft.draft_id, draft.fingerprint, loader.run, projectId]);

  useEffect(() => { void load(); }, [load]);

  const mutate = async (operation: () => Promise<EntityResult>) => {
    setError(null);
    try {
      await operation();
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
  const statusTitle = (slug: string) => statuses.find((item) => item.slug === slug)?.title ?? slug;

  const updateStage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (workspace === null || selectedStage === undefined) return;
    const data = new FormData(event.currentTarget);
    const due = String(data.get("due"));
    const document = { ...selectedStage.document, name: String(data.get("name")).trim(), description_markdown: String(data.get("description")), ...(due ? { due } : { due: undefined }) } as GitPmDocument;
    void mutate(async () => await api.updateEntity(draft.draft_id, "milestones", selectedStage, workspace.draft_fingerprint, document));
  };

  const createTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (workspace === null || selectedStage === undefined) return;
    const data = new FormData(event.currentTarget);
    const id = newUniqueEntityId(ENTITY_ID_PREFIX.task, new Set(workspace.tasks.map((item) => item.document.id)));
    const document = { schema: "gitpm/task@1", id, project: projectId, milestone: selectedStage.document.id, title: String(data.get("title")).trim(), type: String(data.get("type")), status: String(data.get("status")), lifecycle: "active", description_markdown: String(data.get("description")) } as GitPmDocument;
    void mutate(async () => await api.createEntity(draft.draft_id, "tasks", workspace.draft_fingerprint, document));
  };

  const archiveStage = () => {
    if (workspace === null || selectedStage === undefined || !confirmAction(t("core.archiveMilestoneConfirm", { name: text(selectedStage.document, "name"), count: stageTasks.length }))) return;
    void mutate(async () => await api.archiveEntity(draft.draft_id, "milestones", selectedStage, workspace.draft_fingerprint)).then((success) => { if (success) onNavigate("projects", { projectId }); });
  };

  return <section className="stage-workspace">
    {error !== null && <div className="alert error">{error}</div>}
    <AsyncBoundary state={loader.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{loadError}<button onClick={retry}>{t("status.retry")}</button></div>}>
      {workspace !== null && (selectedStage === undefined ? <div className="card empty-workspace">{t("stages.notFound")}</div> : <StageDetails
        locale={locale}
        onArchive={archiveStage}
        onEdit={() => setEditor("stage")}
        onNewTask={() => setEditor("task")}
        onNavigate={onNavigate}
        projectId={projectId}
        readOnly={readOnly || selectedStage.document.lifecycle === "archived"}
        stage={selectedStage}
        tasks={stageTasks}
        statusTitle={statusTitle}
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
        <label>{t("core.description")}<textarea disabled={readOnly} name="description" /></label>
        <div className="editor-drawer-actions"><button onClick={() => setEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.createTask")}</button></div>
      </form>
    </EditorDrawer>
  </section>;
}

function StageDetails({ stage, tasks, projectId, locale, readOnly, statusTitle, onArchive, onEdit, onNewTask, onNavigate, t }: {
  readonly stage: EntityResult;
  readonly tasks: readonly EntityResult[];
  readonly projectId: string;
  readonly locale: Locale;
  readonly readOnly: boolean;
  readonly statusTitle: (slug: string) => string;
  readonly onArchive: () => void;
  readonly onEdit: () => void;
  readonly onNewTask: () => void;
  readonly onNavigate: WorkspaceNavigate;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const completed = tasks.filter((task) => text(task.document, "status") === "done").length;
  const overdue = tasks.filter((task) => text(task.document, "status") !== "done" && /^\d{4}-\d{2}-\d{2}$/u.test(text(task.document, "due")) && text(task.document, "due") < new Date().toISOString().slice(0, 10)).length;
  const estimate = tasks.reduce((sum, task) => sum + (typeof task.document.estimate_hours === "number" ? task.document.estimate_hours : 0), 0);
  return <>
    <header className="card stage-detail-header">
      <div><span className="eyebrow">{t("core.milestone")}</span><h2>{text(stage.document, "name")}</h2><p>{text(stage.document, "description_markdown") || t("core.noDescription")}</p></div>
      <div className="stage-detail-actions"><button disabled={readOnly} onClick={onEdit}>{t("core.edit")}</button><button disabled={readOnly} onClick={onArchive}>{t("core.archive")}</button><button className="primary" disabled={readOnly} onClick={onNewTask}>+ {t("stages.newTask")}</button></div>
    </header>
    <div className="stage-stats">
      <div className="card"><span>{t("stages.progressLabel")}</span><strong>{completed}/{tasks.length}</strong></div>
      <div className="card"><span>{t("stages.overdue")}</span><strong>{overdue}</strong></div>
      <div className="card"><span>{t("stages.estimate")}</span><strong>{formatDurationHours(locale, estimate)}</strong></div>
      <div className="card"><span>{t("core.due")}</span><strong>{text(stage.document, "due") ? formatDateOnly(locale, text(stage.document, "due")) : "—"}</strong></div>
    </div>
    <section className="card stage-task-list"><div className="card-heading"><div><h3>{t("stages.tasks")}</h3><p>{t("stages.tasksDescription")}</p></div><button onClick={() => onNavigate("board", { projectId, query: { milestone: [stage.document.id] } })}>{t("stages.openBoard")}</button></div>
      {tasks.length === 0 ? <p>{t("stages.emptyTasks")}</p> : tasks.map((task) => <button className="stage-task-row" key={task.document.id} onClick={() => onNavigate("tasks", { projectId, taskId: task.document.id })}>
        <span><strong>{text(task.document, "title")}</strong><code>{task.document.id}</code></span><span className="state open">{statusTitle(text(task.document, "status"))}</span>
      </button>)}
    </section>
  </>;
}
