import { useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent } from "react";
import { ENTITY_ID_PREFIX, newUniqueEntityId } from "@gitpm/shared";
import type { GitPmApi } from "./api.js";
import { message, type Locale, type MessageKey } from "./i18n.js";
import type { DraftStatus, EntityDocument, EntityResult, GitPmDocument } from "./types.js";
import { AsyncBoundary, useAsyncLoad } from "./async-data.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";
import { EntityCatalog } from "./entity-catalog.js";
import { useExternalHighlights, useReducedMotion } from "./external-updates.js";
import { upsertEntity, useFlipList } from "./optimistic-ui.js";
import { PersonLinks } from "./person-link.js";
import { DraftReadOnlyAlert, draftReadOnlyReason } from "./draft-read-only.js";

interface ConfigValue { readonly slug: string; readonly title: string; readonly active: boolean }
const text = (document: GitPmDocument, key: string) => typeof document[key] === "string" ? document[key] as string : "";
const strings = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const configValues = (document: GitPmDocument, key: "statuses" | "issue_types"): ConfigValue[] => Array.isArray(document[key])
  ? (document[key] as unknown[]).filter((item): item is ConfigValue => typeof item === "object" && item !== null && typeof (item as ConfigValue).slug === "string" && typeof (item as ConfigValue).title === "string" && (item as ConfigValue).active === true)
  : [];

export function BoardWorkspace({ api, draft, locale, initialProjectId = "", initialStatusFilter = "", initialTypeFilter = "", initialMilestoneFilter = "", initialViewId = "", onNavigate = () => undefined, onChanged }: {
  readonly api: GitPmApi;
  readonly draft: DraftStatus;
  readonly locale: Locale;
  readonly initialProjectId?: string;
  readonly initialStatusFilter?: string;
  readonly initialTypeFilter?: string;
  readonly initialMilestoneFilter?: string;
  readonly initialViewId?: string;
  readonly onNavigate?: WorkspaceNavigate;
  readonly onChanged: () => Promise<void>;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [projects, setProjects] = useState<readonly EntityResult[]>([]);
  const [tasks, setTasks] = useState<readonly EntityResult[]>([]);
  const [people, setPeople] = useState<readonly EntityResult[]>([]);
  const [views, setViews] = useState<readonly EntityResult[]>([]);
  const [milestones, setMilestones] = useState<readonly EntityResult[]>([]);
  const [statuses, setStatuses] = useState<readonly ConfigValue[]>([]);
  const [types, setTypes] = useState<readonly ConfigValue[]>([]);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [statusFilter, setStatusFilter] = useState(initialStatusFilter);
  const [typeFilter, setTypeFilter] = useState(initialTypeFilter);
  const [milestoneFilter, setMilestoneFilter] = useState(initialMilestoneFilter);
  const [fingerprint, setFingerprint] = useState(draft.fingerprint);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [activeViewId, setActiveViewId] = useState(initialViewId);
  const [error, setError] = useState<string | null>(null);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const { highlights, mark } = useExternalHighlights(500);
  const reducedMotion = useReducedMotion();
  const columnsRef = useFlipList<HTMLDivElement>(reducedMotion);
  const loadRequest = useAsyncLoad();
  const readOnly = draftReadOnlyReason(draft) !== null;

  const load = useCallback(async (preferredProject = projectId) => {
    await loadRequest.run(async () => {
      const [nextProjects, nextPeople, statusConfig, typeConfig] = await Promise.all([
        api.listEntities(draft.draft_id, "projects"), api.listEntities(draft.draft_id, "people"), api.getConfiguration(draft.draft_id, "statuses"), api.getConfiguration(draft.draft_id, "issue-types"),
      ]);
      const activeProjects = nextProjects.filter((item) => item.document.lifecycle === "active");
      const nextProject = activeProjects.some((item) => item.document.id === preferredProject) ? preferredProject : activeProjects[0]?.document.id ?? "";
      const [nextTasks, nextViews, nextMilestones] = nextProject === "" ? [[], [], []] : await Promise.all([
        api.listEntities(draft.draft_id, "tasks", nextProject), api.listEntities(draft.draft_id, "views", nextProject), api.listEntities(draft.draft_id, "milestones", nextProject),
      ]);
      return { activeProjects, nextProject, nextTasks, nextViews, nextMilestones, nextPeople, statusConfig, typeConfig, nextProjects };
    }, ({ activeProjects, nextProject, nextTasks, nextViews, nextMilestones, nextPeople, statusConfig, typeConfig, nextProjects }) => {
      setProjects(activeProjects); setProjectId(nextProject); setTasks(nextTasks); setViews(nextViews); setMilestones(nextMilestones); setPeople(nextPeople);
      setStatuses(configValues(statusConfig.document, "statuses")); setTypes(configValues(typeConfig.document, "issue_types"));
      setFingerprint(nextTasks[0]?.draft_fingerprint ?? nextViews[0]?.draft_fingerprint ?? nextProjects[0]?.draft_fingerprint ?? draft.fingerprint);
    });
  }, [api, draft.draft_id, draft.fingerprint, loadRequest.run, projectId]);

  useEffect(() => { void load(initialProjectId); }, [draft.draft_id, draft.external_fingerprint]);
  useEffect(() => {
    setStatusFilter(initialStatusFilter); setTypeFilter(initialTypeFilter); setMilestoneFilter(initialMilestoneFilter); setActiveViewId(initialViewId);
  }, [initialMilestoneFilter, initialStatusFilter, initialTypeFilter, initialViewId]);
  const report = (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught));
  const mutate = async (operation: () => Promise<EntityResult>): Promise<EntityResult | null> => {
    setError(null);
    try {
      const result = await operation();
      setFingerprint(result.draft_fingerprint);
      if (result.document.schema === "gitpm/task@1") setTasks((current) => upsertEntity(current, result));
      if (result.document.schema === "gitpm/saved-view@1") setViews((current) => upsertEntity(current, result));
      mark({ [result.document.id]: ["$entity"] });
      await onChanged(); await load();
      return result;
    } catch (caught) { report(caught); return null; }
  };

  const activeTasks = tasks.filter((item) => item.document.lifecycle === "active");
  const boardStatuses = useMemo(() => {
    const known = statuses.map((item) => item.slug);
    return [...new Set([...known, ...activeTasks.map((item) => text(item.document, "status"))])];
  }, [activeTasks, statuses]);
  const visibleTasks = activeTasks.filter((item) => (statusFilter === "" || text(item.document, "status") === statusFilter) && (typeFilter === "" || text(item.document, "type") === typeFilter) && (milestoneFilter === "" || text(item.document, "milestone") === milestoneFilter));
  const titleForStatus = (slug: string) => statuses.find((item) => item.slug === slug)?.title ?? slug;
  const catalog = useMemo(() => new EntityCatalog({ projects, milestones, tasks }), [projects, milestones, tasks]);
  const activeMilestones = milestones.filter((item) => item.document.lifecycle === "active");

  const moveTask = (status: string, id: string) => {
    const task = tasks.find((item) => item.document.id === id);
    setDraggedTaskId(null);
    if (readOnly || task === undefined || text(task.document, "status") === status) return;
    const previous = tasks;
    const document = { ...task.document, status } as EntityDocument;
    setSavingTaskId(task.document.id);
    setTasks(upsertEntity(tasks, { ...task, document }));
    void mutate(async () => { const result = await api.updateEntity(draft.draft_id, "tasks", task, fingerprint, document); setSavingTaskId(null); return result; }).then((result) => { if (result === null) setTasks(previous); }).finally(() => setSavingTaskId(null));
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
      filters: { statuses: statusFilter === "" ? [] : [statusFilter], types: typeFilter === "" ? [] : [typeFilter], milestones: milestoneFilter === "" ? [] : [milestoneFilter] }, group_by: "status", lifecycle: "active",
    } as EntityDocument;
    void mutate(async () => await api.createEntity(draft.draft_id, "views", fingerprint, document));
    event.currentTarget.reset();
  };
  const applyFilters = (status: string, type: string, milestone: string, view = "") => {
    setStatusFilter(status); setTypeFilter(type); setMilestoneFilter(milestone); setActiveViewId(view);
    const query = { ...(status === "" ? {} : { status: [status] }), ...(type === "" ? {} : { type: [type] }), ...(milestone === "" ? {} : { milestone: [milestone] }), ...(view === "" ? {} : { view: [view] }) };
    onNavigate("board", { projectId, query });
  };
  const openView = (view: EntityResult) => {
    const filters = typeof view.document.filters === "object" && view.document.filters !== null ? view.document.filters as Readonly<Record<string, unknown>> : {};
    applyFilters(strings(filters.statuses)[0] ?? "", strings(filters.types)[0] ?? "", strings(filters.milestones)[0] ?? "", view.document.id);
  };
  const savedViews = views.filter((view) => view.document.lifecycle === "active" && view.document.kind === "board");
  const scrollColumns = (direction: -1 | 1) => columnsRef.current?.scrollBy({ left: direction * Math.max(280, columnsRef.current.clientWidth * .75), behavior: "smooth" });

  return <section className="board-workspace">
    <div className="section-heading"><span className="eyebrow draft-context-id">{draft.draft_id}</span><h2 aria-hidden="true">{t("board.heading")}</h2><p>{t("board.description")}</p></div>
    <DraftReadOnlyAlert draft={draft} locale={locale} onAcknowledge={() => {
      setError(null);
      void api.acknowledgeExternalChanges(draft.draft_id)
        .then(async () => await onChanged())
        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    }} />{error !== null && <div className="alert error">{error}</div>}
    <AsyncBoundary state={loadRequest.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{loadError}<button onClick={retry}>{t("status.retry")}</button></div>}>
    <>
    <section className="card board-toolbar">
      {initialProjectId === "" && <label>{t("board.project")}<select aria-label={t("board.project")} value={projectId} onChange={(event) => onNavigate("board", { projectId: event.target.value })}>{projects.map((project) => <option key={project.document.id} value={project.document.id}>{text(project.document, "name")}</option>)}</select></label>}
      <label>{t("board.statusFilter")}<select aria-label={t("board.statusFilter")} value={statusFilter} onChange={(event) => applyFilters(event.target.value, typeFilter, milestoneFilter)}><option value="">{t("board.all")}</option>{boardStatuses.map((status) => <option key={status} value={status}>{titleForStatus(status)}</option>)}</select></label>
      <label>{t("board.typeFilter")}<select aria-label={t("board.typeFilter")} value={typeFilter} onChange={(event) => applyFilters(statusFilter, event.target.value, milestoneFilter)}><option value="">{t("board.all")}</option>{types.map((type) => <option key={type.slug} value={type.slug}>{type.title}</option>)}</select></label>
      <label>{t("core.milestone")}<select aria-label={t("core.milestone")} value={milestoneFilter} onChange={(event) => applyFilters(statusFilter, typeFilter, event.target.value)}><option value="">{t("core.allMilestones")}</option>{activeMilestones.map((milestone) => <option key={milestone.document.id} value={milestone.document.id}>{text(milestone.document, "name")}</option>)}</select></label>
      <label>{t("board.savedView")}<select aria-label={t("board.savedView")} value={activeViewId} onChange={(event) => { const selected = savedViews.find((view) => view.document.id === event.target.value); if (selected === undefined) applyFilters(statusFilter, typeFilter, milestoneFilter); else openView(selected); }}><option value="">{t("board.customView")}</option>{savedViews.map((view) => <option key={view.document.id} value={view.document.id}>{text(view.document, "name")}</option>)}</select></label>
      <span className="board-count">{t("board.visible", { count: visibleTasks.length })}</span>
    </section>
    <div className="board-scroll-tools"><span>{t("board.scrollHint")}</span><div><button aria-label={t("board.previousColumns")} onClick={() => scrollColumns(-1)} type="button">←</button><button aria-label={t("board.nextColumns")} onClick={() => scrollColumns(1)} type="button">→</button></div></div>
    <div className="board-columns" ref={columnsRef}>{boardStatuses.map((status) => {
      const columnTasks = visibleTasks.filter((item) => text(item.document, "status") === status);
      return <section className="board-column" data-status={status} key={status} onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, status)} onPointerUp={() => { if (draggedTaskId !== null) moveTask(status, draggedTaskId); }}>
        <header><h3>{titleForStatus(status)}</h3><span>{columnTasks.length}</span></header>
        <div className="board-cards">{columnTasks.map((task) => <article className={`board-card${highlights[task.document.id] ? " recently-changed" : ""}${savingTaskId === task.document.id ? " is-saving" : ""}`} draggable={!readOnly} data-flip-key={`board-task:${task.document.id}`} data-task-id={task.document.id} key={task.document.id} onPointerDown={() => { if (!readOnly) setDraggedTaskId(task.document.id); }} onDragStart={(event) => { setDraggedTaskId(task.document.id); event.dataTransfer.setData("text/plain", task.document.id); }} onDragEnd={() => setDraggedTaskId(null)}>
          {!readOnly && <span aria-hidden="true" className="board-drag-handle">⋮⋮</span>}<button className="board-task-link" onPointerDown={(event) => event.stopPropagation()} onClick={() => onNavigate("tasks", { projectId, taskId: task.document.id })}><strong>{text(task.document, "title")}</strong><code>{task.document.id}</code></button>{catalog.milestone(task.document.milestone) !== undefined && <button className="board-milestone" onPointerDown={(event) => event.stopPropagation()} onClick={() => onNavigate("stages", { projectId, stageId: text(task.document, "milestone") })} type="button">{catalog.milestone(task.document.milestone)?.name}{catalog.milestone(task.document.milestone)?.lifecycle === "archived" ? ` · ${t("core.archived")}` : ""}</button>}<span>{types.find((type) => type.slug === text(task.document, "type"))?.title ?? text(task.document, "type")}</span><span className="board-assignees">{t("core.assignees")}: <PersonLinks empty={t("core.unassigned")} onOpen={(personId) => onNavigate("people", { personId })} people={people} personIds={strings(task.document.assignees)} /></span><label className="board-status-control" onPointerDown={(event) => event.stopPropagation()}>{t("core.status")}<select disabled={readOnly} value={text(task.document, "status")} onChange={(event) => moveTask(event.target.value, task.document.id)}>{boardStatuses.map((nextStatus) => <option key={nextStatus} value={nextStatus}>{titleForStatus(nextStatus)}</option>)}</select></label>
        </article>)}</div>
      </section>;
    })}</div>
    <details className="card saved-view-manager"><summary>{t("board.manageViews")}</summary><section className="saved-views"><div><h3>{t("board.savedViews")}</h3><p>{t("board.savedDescription")}</p></div>
      <form onSubmit={saveView}><input name="name" aria-label={t("board.viewName")} placeholder={t("board.viewName")} required /><button className="primary" disabled={readOnly || projectId === ""}>{t("board.saveView")}</button></form>
      <div className="saved-view-list">{savedViews.map((view) => <button className={activeViewId === view.document.id ? "selected" : ""} key={view.document.id} onClick={() => openView(view)}><strong>{text(view.document, "name")}</strong><code>{view.document.id}</code></button>)}</div>
    </section></details>
    </>
    </AsyncBoundary>
  </section>;
}
