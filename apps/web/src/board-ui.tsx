import { useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent } from "react";
import { ENTITY_ID_PREFIX, newUniqueEntityId } from "@gitpm/shared";
import type { GitPmApi } from "./api.js";
import { message, type Locale, type MessageKey } from "./i18n.js";
import type { DraftStatus, EntityResult, GitPmDocument } from "./types.js";

interface ConfigValue { readonly slug: string; readonly title: string; readonly active: boolean }
const text = (document: GitPmDocument, key: string) => typeof document[key] === "string" ? document[key] as string : "";
const strings = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const configValues = (document: GitPmDocument, key: "statuses" | "issue_types"): ConfigValue[] => Array.isArray(document[key])
  ? (document[key] as unknown[]).filter((item): item is ConfigValue => typeof item === "object" && item !== null && typeof (item as ConfigValue).slug === "string" && typeof (item as ConfigValue).title === "string" && (item as ConfigValue).active === true)
  : [];

export function BoardWorkspace({ api, draft, locale, onChanged }: {
  readonly api: GitPmApi;
  readonly draft: DraftStatus;
  readonly locale: Locale;
  readonly onChanged: () => Promise<void>;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [projects, setProjects] = useState<readonly EntityResult[]>([]);
  const [tasks, setTasks] = useState<readonly EntityResult[]>([]);
  const [views, setViews] = useState<readonly EntityResult[]>([]);
  const [statuses, setStatuses] = useState<readonly ConfigValue[]>([]);
  const [types, setTypes] = useState<readonly ConfigValue[]>([]);
  const [projectId, setProjectId] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [fingerprint, setFingerprint] = useState(draft.fingerprint);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [activeViewId, setActiveViewId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const readOnly = draft.writer_mode !== "ui" || draft.state !== "open" || draft.changed_externally === true;

  const load = useCallback(async (preferredProject = projectId) => {
    const [nextProjects, statusConfig, typeConfig] = await Promise.all([
      api.listEntities(draft.draft_id, "projects"), api.getConfiguration(draft.draft_id, "statuses"), api.getConfiguration(draft.draft_id, "issue-types"),
    ]);
    const activeProjects = nextProjects.filter((item) => item.document.lifecycle === "active");
    const nextProject = activeProjects.some((item) => item.document.id === preferredProject) ? preferredProject : activeProjects[0]?.document.id ?? "";
    const [nextTasks, nextViews] = nextProject === "" ? [[], []] : await Promise.all([
      api.listEntities(draft.draft_id, "tasks", nextProject), api.listEntities(draft.draft_id, "views", nextProject),
    ]);
    setProjects(activeProjects); setProjectId(nextProject); setTasks(nextTasks); setViews(nextViews);
    setStatuses(configValues(statusConfig.document, "statuses")); setTypes(configValues(typeConfig.document, "issue_types"));
    setFingerprint(nextTasks[0]?.draft_fingerprint ?? nextViews[0]?.draft_fingerprint ?? nextProjects[0]?.draft_fingerprint ?? draft.fingerprint);
  }, [api, draft.draft_id, draft.fingerprint, projectId]);

  useEffect(() => { void load().catch(report); }, [draft.draft_id, draft.external_fingerprint]);
  const report = (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught));
  const mutate = async (operation: () => Promise<EntityResult>) => {
    setError(null);
    try { const result = await operation(); setFingerprint(result.draft_fingerprint); await load(); await onChanged(); }
    catch (caught) { report(caught); }
  };

  const activeTasks = tasks.filter((item) => item.document.lifecycle === "active");
  const boardStatuses = useMemo(() => {
    const known = statuses.map((item) => item.slug);
    return [...new Set([...known, ...activeTasks.map((item) => text(item.document, "status"))])];
  }, [activeTasks, statuses]);
  const visibleTasks = activeTasks.filter((item) => (statusFilter === "" || text(item.document, "status") === statusFilter) && (typeFilter === "" || text(item.document, "type") === typeFilter));
  const titleForStatus = (slug: string) => statuses.find((item) => item.slug === slug)?.title ?? slug;

  const moveTask = (status: string, id: string) => {
    const task = tasks.find((item) => item.document.id === id);
    setDraggedTaskId(null);
    if (readOnly || task === undefined || text(task.document, "status") === status) return;
    void mutate(async () => await api.updateEntity(draft.draft_id, "tasks", task, fingerprint, { ...task.document, status }));
  };
  const drop = (event: DragEvent<HTMLElement>, status: string) => {
    event.preventDefault();
    moveTask(status, draggedTaskId ?? event.dataTransfer.getData("text/plain"));
  };
  const saveView = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const document = {
      schema: "gitpm/saved-view@1", id: newUniqueEntityId(ENTITY_ID_PREFIX.view, new Set(views.map((item) => item.document.id))), project: projectId, name: String(data.get("name")), kind: "board",
      filters: { statuses: statusFilter === "" ? [] : [statusFilter], types: typeFilter === "" ? [] : [typeFilter] }, group_by: "status", lifecycle: "active",
    } as GitPmDocument;
    void mutate(async () => await api.createEntity(draft.draft_id, "views", fingerprint, document));
    event.currentTarget.reset();
  };
  const openView = (view: EntityResult) => {
    const filters = typeof view.document.filters === "object" && view.document.filters !== null ? view.document.filters as Readonly<Record<string, unknown>> : {};
    setStatusFilter(strings(filters.statuses)[0] ?? ""); setTypeFilter(strings(filters.types)[0] ?? ""); setActiveViewId(view.document.id);
  };

  return <section className="board-workspace">
    <div className="section-heading"><span className="eyebrow draft-context-id">{draft.draft_id}</span><h2>{t("board.heading")}</h2><p>{t("board.description")}</p></div>
    {readOnly && <div className="alert warning">{t("board.readOnly")}</div>}{error !== null && <div className="alert error">{error}</div>}
    <section className="card board-toolbar">
      <label>{t("board.project")}<select value={projectId} onChange={(event) => { setActiveViewId(""); void load(event.target.value); }}>{projects.map((project) => <option key={project.document.id} value={project.document.id}>{text(project.document, "name")}</option>)}</select></label>
      <label>{t("board.statusFilter")}<select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setActiveViewId(""); }}><option value="">{t("board.all")}</option>{boardStatuses.map((status) => <option key={status} value={status}>{titleForStatus(status)}</option>)}</select></label>
      <label>{t("board.typeFilter")}<select value={typeFilter} onChange={(event) => { setTypeFilter(event.target.value); setActiveViewId(""); }}><option value="">{t("board.all")}</option>{types.map((type) => <option key={type.slug} value={type.slug}>{type.title}</option>)}</select></label>
      <span className="board-count">{t("board.visible", { count: visibleTasks.length })}</span>
    </section>
    <div className="board-columns">{boardStatuses.map((status) => {
      const columnTasks = visibleTasks.filter((item) => text(item.document, "status") === status);
      return <section className="board-column" data-status={status} key={status} onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, status)} onPointerUp={() => { if (draggedTaskId !== null) moveTask(status, draggedTaskId); }}>
        <header><h3>{titleForStatus(status)}</h3><span>{columnTasks.length}</span></header>
        <div className="board-cards">{columnTasks.map((task) => <article className="board-card" draggable={!readOnly} data-task-id={task.document.id} key={task.document.id} onPointerDown={() => { if (!readOnly) setDraggedTaskId(task.document.id); }} onDragStart={(event) => { setDraggedTaskId(task.document.id); event.dataTransfer.setData("text/plain", task.document.id); }} onDragEnd={() => setDraggedTaskId(null)}>
          <strong>{text(task.document, "title")}</strong><code>{task.document.id}</code><span>{types.find((type) => type.slug === text(task.document, "type"))?.title ?? text(task.document, "type")}</span>
        </article>)}</div>
      </section>;
    })}</div>
    <section className="card saved-views"><div><h3>{t("board.savedViews")}</h3><p>{t("board.savedDescription")}</p></div>
      <form onSubmit={saveView}><input name="name" aria-label={t("board.viewName")} placeholder={t("board.viewName")} required /><button className="primary" disabled={readOnly || projectId === ""}>{t("board.saveView")}</button></form>
      <div className="saved-view-list">{views.filter((view) => view.document.lifecycle === "active" && view.document.kind === "board").map((view) => <button className={activeViewId === view.document.id ? "selected" : ""} key={view.document.id} onClick={() => openView(view)}><strong>{text(view.document, "name")}</strong><code>{view.document.id}</code></button>)}</div>
    </section>
  </section>;
}
