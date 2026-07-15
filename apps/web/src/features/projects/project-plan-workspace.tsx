import { ENTITY_ID_PREFIX, newUniqueEntityId } from "@gitpm/shared";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { GitPmApi } from "../../api.js";
import { AsyncBoundary, useAsyncLoad } from "../../async-data.js";
import { EditorDrawer } from "../../editor-drawer.js";
import { formatDateOnly, message, type Locale, type MessageKey } from "../../i18n.js";
import type { DraftStatus, EntityResult, GitPmDocument, ProjectWorkspaceResult } from "../../types.js";
import type { WorkspaceNavigate } from "../../workspace-navigation.js";

interface ConfigValue { readonly slug: string; readonly title: string; readonly active: boolean }
type PlanEditor = { readonly kind: "project" | "stage" } | { readonly kind: "task"; readonly stageId?: string } | null;

const text = (document: GitPmDocument, key: string): string => typeof document[key] === "string" ? document[key] as string : "";
const number = (document: GitPmDocument, key: string): number | undefined => typeof document[key] === "number" ? document[key] as number : undefined;
const configValues = (document: GitPmDocument, key: "statuses" | "issue_types"): ConfigValue[] => Array.isArray(document[key])
  ? (document[key] as unknown[]).filter((item): item is ConfigValue => typeof item === "object" && item !== null && typeof (item as ConfigValue).slug === "string" && typeof (item as ConfigValue).title === "string" && (item as ConfigValue).active === true)
  : [];
const sortTasks = (left: EntityResult, right: EntityResult) => {
  const byCompletion = Number(text(left.document, "status") === "done") - Number(text(right.document, "status") === "done");
  const byDue = (text(left.document, "due") || "9999-12-31").localeCompare(text(right.document, "due") || "9999-12-31");
  return byCompletion !== 0 ? byCompletion : byDue !== 0 ? byDue : text(left.document, "title").localeCompare(text(right.document, "title"));
};

export function ProjectPlanWorkspace({ api, draft, locale, projectId, onNavigate, onChanged, confirmAction = () => true }: {
  readonly api: GitPmApi;
  readonly draft: DraftStatus;
  readonly locale: Locale;
  readonly projectId: string;
  readonly onNavigate: WorkspaceNavigate;
  readonly onChanged: () => Promise<void>;
  readonly confirmAction?: (message: string) => boolean;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const loader = useAsyncLoad();
  const [workspace, setWorkspace] = useState<ProjectWorkspaceResult | null>(null);
  const [people, setPeople] = useState<readonly EntityResult[]>([]);
  const [statuses, setStatuses] = useState<readonly ConfigValue[]>([]);
  const [types, setTypes] = useState<readonly ConfigValue[]>([]);
  const [editor, setEditor] = useState<PlanEditor>(null);
  const [error, setError] = useState<string | null>(null);
  const readOnly = draft.writer_mode !== "ui" || draft.state !== "open" || draft.changed_externally === true;

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

  const activeStages = useMemo(() => [...(workspace?.milestones.filter((item) => item.document.lifecycle === "active") ?? [])].sort((left, right) => {
    const byDue = (text(left.document, "due") || "9999-12-31").localeCompare(text(right.document, "due") || "9999-12-31");
    return byDue !== 0 ? byDue : text(left.document, "name").localeCompare(text(right.document, "name"));
  }), [workspace]);
  const activeTasks = useMemo(() => [...(workspace?.tasks.filter((item) => item.document.lifecycle === "active") ?? [])].sort(sortTasks), [workspace]);
  const completed = activeTasks.filter((task) => text(task.document, "status") === "done").length;
  const overdue = activeTasks.filter((task) => text(task.document, "status") !== "done" && /^\d{4}-\d{2}-\d{2}$/u.test(text(task.document, "due")) && text(task.document, "due") < new Date().toISOString().slice(0, 10)).length;
  const activeStageIds = new Set(activeStages.map((stage) => stage.document.id));
  const outsideStages = activeTasks.filter((task) => !activeStageIds.has(text(task.document, "milestone")));
  const progress = activeTasks.length === 0 ? 0 : Math.round(completed / activeTasks.length * 100);
  const statusTitle = (slug: string) => statuses.find((item) => item.slug === slug)?.title ?? slug;
  const personName = (id: string) => text(people.find((item) => item.document.id === id)?.document ?? { schema: "", id: "", lifecycle: "active" }, "name") || t("core.unassigned");
  const dateLabel = (value: string) => /^\d{4}-\d{2}-\d{2}$/u.test(value) ? formatDateOnly(locale, value) : "—";

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

  const createTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (workspace === null || editor?.kind !== "task") return;
    const data = new FormData(event.currentTarget);
    const id = newUniqueEntityId(ENTITY_ID_PREFIX.task, new Set(workspace.tasks.map((item) => item.document.id)));
    const due = String(data.get("due")); const estimate = String(data.get("estimate"));
    const document = {
      schema: "gitpm/task@1", id, project: projectId, title: String(data.get("title")).trim(), type: String(data.get("type")), status: String(data.get("status")), lifecycle: "active",
      description_markdown: String(data.get("description")),
      ...(editor.stageId === undefined ? {} : { milestone: editor.stageId }),
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
      {workspace !== null && <>
        <header className="card project-plan-header">
          <div className="project-plan-title"><span className="eyebrow">{t("projectTabs.overview")}</span><h2>{text(workspace.project.document, "name")}</h2><p>{text(workspace.project.document, "description_markdown") || t("core.noDescription")}</p></div>
          <div className="project-plan-actions"><button disabled={readOnly} onClick={() => setEditor({ kind: "project" })}>{t("core.edit")}</button><button className="primary" disabled={readOnly} onClick={() => setEditor({ kind: "stage" })}>+ {t("stages.new")}</button></div>
          <dl className="project-plan-meta">
            <div><dt>{t("core.status")}</dt><dd><span className="state open">{statusTitle(text(workspace.project.document, "status"))}</span></dd></div>
            <div><dt>{t("core.owner")}</dt><dd>{personName(text(workspace.project.document, "owner"))}</dd></div>
            <div><dt>{t("projectPlan.start")}</dt><dd>{dateLabel(text(workspace.project.document, "start"))}</dd></div>
            <div><dt>{t("core.due")}</dt><dd>{dateLabel(text(workspace.project.document, "due"))}</dd></div>
          </dl>
        </header>

        <div className="project-plan-stats">
          <div className="card"><span>{t("projectPlan.progress")}</span><strong>{progress}%</strong><progress max="100" value={progress}>{progress}%</progress><small>{t("stages.progress", { completed, count: activeTasks.length })}</small></div>
          <div className="card"><span>{t("projectPlan.stages")}</span><strong>{activeStages.length}</strong></div>
          <div className="card"><span>{t("projectPlan.overdue")}</span><strong>{overdue}</strong></div>
          <div className="card"><span>{t("projectPlan.withoutStage")}</span><strong>{outsideStages.length}</strong></div>
        </div>

        <section className="project-plan-work">
          <div className="project-plan-work-heading"><div><h2>{t("projectPlan.workHeading")}</h2><p>{t("projectPlan.workDescription")}</p></div><button onClick={() => onNavigate("tasks", { projectId })}>{t("projectPlan.openTaskList")}</button></div>
          {activeStages.length === 0 && <div className="card empty-workspace">{t("projectPlan.emptyStages")}</div>}
          {activeStages.map((stage) => <StageSection
            key={stage.document.id}
            locale={locale}
            onNavigate={onNavigate}
            onNewTask={() => setEditor({ kind: "task", stageId: stage.document.id })}
            projectId={projectId}
            readOnly={readOnly}
            stage={stage}
            statusTitle={statusTitle}
            tasks={activeTasks.filter((task) => task.document.milestone === stage.document.id)}
            t={t}
          />)}
          <section className={`card project-plan-stage project-plan-unassigned${outsideStages.length > 0 ? " has-work" : ""}`}>
            <header><div><h3>{t("projectPlan.unassignedHeading")}</h3><p>{t("projectPlan.unassignedDescription")}</p></div><div className="project-plan-stage-actions"><button disabled={readOnly} onClick={() => setEditor({ kind: "task" })}>+ {t("core.createTaskAction")}</button><button onClick={() => onNavigate("tasks", { projectId })}>{t("projectPlan.openTaskList")}</button></div></header>
            <TaskRows locale={locale} onNavigate={onNavigate} projectId={projectId} statusTitle={statusTitle} tasks={outsideStages} t={t} />
          </section>
        </section>
      </>}
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

    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditor(null)} open={editor?.kind === "stage"} title={t("stages.new")}>
      <form className="editor-drawer-form" onSubmit={createStage}>
        <label>{t("core.name")}<input disabled={readOnly} name="name" required /></label>
        <label>{t("core.due")}<input disabled={readOnly} name="due" type="date" /></label>
        <label>{t("core.description")}<textarea disabled={readOnly} name="description" /></label>
        <div className="editor-drawer-actions"><button onClick={() => setEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.save")}</button></div>
      </form>
    </EditorDrawer>

    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditor(null)} open={editor?.kind === "task"} title={t("core.createTaskAction")}>
      <form className="editor-drawer-form" onSubmit={createTask}>
        <label>{t("core.title")}<input disabled={readOnly} name="title" required /></label>
        <label>{t("core.status")}<select disabled={readOnly} name="status">{statuses.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select></label>
        <label>{t("core.type")}<select disabled={readOnly} name="type">{types.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select></label>
        <label>{t("core.due")}<input disabled={readOnly} name="due" type="date" /></label>
        <label>{t("projectPlan.estimate")}<input disabled={readOnly} min="0" name="estimate" step="0.25" type="number" /></label>
        <label>{t("core.description")}<textarea disabled={readOnly} name="description" /></label>
        <div className="editor-drawer-actions"><button onClick={() => setEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.createTask")}</button></div>
      </form>
    </EditorDrawer>
  </section>;
}

function StageSection({ stage, tasks, projectId, locale, readOnly, statusTitle, onNewTask, onNavigate, t }: {
  readonly stage: EntityResult;
  readonly tasks: readonly EntityResult[];
  readonly projectId: string;
  readonly locale: Locale;
  readonly readOnly: boolean;
  readonly statusTitle: (slug: string) => string;
  readonly onNewTask: () => void;
  readonly onNavigate: WorkspaceNavigate;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const completed = tasks.filter((task) => text(task.document, "status") === "done").length;
  const progress = tasks.length === 0 ? 0 : Math.round(completed / tasks.length * 100);
  return <article className="card project-plan-stage">
    <header><div><div className="project-plan-stage-title"><h3>{text(stage.document, "name")}</h3><button aria-label={`${t("stages.open")}: ${text(stage.document, "name")}`} className="project-plan-stage-link" onClick={() => onNavigate("stages", { projectId, stageId: stage.document.id })}>{t("stages.open")} →</button></div><p>{text(stage.document, "description_markdown") || t("core.noDescription")}</p></div><div className="project-plan-stage-actions"><time dateTime={text(stage.document, "due")}>{text(stage.document, "due") ? formatDateOnly(locale, text(stage.document, "due")) : "—"}</time><button disabled={readOnly} onClick={onNewTask}>+ {t("core.createTaskAction")}</button></div></header>
    <div className="project-plan-stage-progress"><progress aria-label={t("stages.progressLabel")} max="100" value={progress}>{progress}%</progress><span>{t("stages.progress", { completed, count: tasks.length })}</span></div>
    <TaskRows locale={locale} onNavigate={onNavigate} projectId={projectId} statusTitle={statusTitle} tasks={tasks} t={t} />
  </article>;
}

function TaskRows({ tasks, projectId, locale, statusTitle, onNavigate, t }: {
  readonly tasks: readonly EntityResult[];
  readonly projectId: string;
  readonly locale: Locale;
  readonly statusTitle: (slug: string) => string;
  readonly onNavigate: WorkspaceNavigate;
  readonly t: (key: MessageKey) => string;
}) {
  if (tasks.length === 0) return <p className="project-plan-empty-tasks">{t("stages.emptyTasks")}</p>;
  return <div className="project-plan-task-list">{tasks.map((task) => {
    const milestone = text(task.document, "milestone");
    return <button className="project-plan-task-row" key={task.document.id} onClick={() => onNavigate("tasks", { projectId, taskId: task.document.id, query: { milestone: [milestone || "none"] } })}>
    <span><strong>{text(task.document, "title")}</strong><code>{task.document.id}</code></span>
    <span className="project-plan-task-meta">{text(task.document, "due") && <time dateTime={text(task.document, "due")}>{formatDateOnly(locale, text(task.document, "due"))}</time>}{number(task.document, "estimate_hours") !== undefined && <span>{number(task.document, "estimate_hours")}h</span>}<span className="state open">{statusTitle(text(task.document, "status"))}</span></span>
    </button>;
  })}</div>;
}
