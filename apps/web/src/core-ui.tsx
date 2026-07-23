import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ENTITY_ID_PREFIX, newUniqueEntityId } from "@gitpm/shared";
import type { GitPmApi } from "./api.js";
import { formatDateOnly, message, type Locale, type MessageKey } from "./i18n.js";
import type { DraftStatus, EntityResult, GitPmDocument } from "./types.js";
import { changedEntityFields, useExternalHighlights, useReducedMotion } from "./external-updates.js";
import { AsyncBoundary, useAsyncLoad } from "./async-data.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";
import { EntityCatalog } from "./entity-catalog.js";
import { EditorDrawer } from "./editor-drawer.js";
import { upsertEntity } from "./optimistic-ui.js";
import { PersonLinks } from "./person-link.js";
import { TaskComments } from "./task-comments-ui.js";
import { DraftReadOnlyAlert, draftReadOnlyReason } from "./draft-read-only.js";

const value = (document: GitPmDocument, key: string) => typeof document[key] === "string" ? document[key] as string : "";
const values = (document: GitPmDocument, key: string): string[] => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
export interface ConfigValue { readonly slug: string; readonly title: string; readonly active: boolean }
interface MutationFeedback { readonly kind: "saving" | "saved" | "undone"; readonly text: string }
type CoreCreateEditor = "project" | "milestone" | "task" | null;
const configValues = (document: GitPmDocument, key: "statuses" | "issue_types"): ConfigValue[] => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is ConfigValue => typeof item === "object" && item !== null && typeof (item as ConfigValue).slug === "string" && typeof (item as ConfigValue).title === "string" && (item as ConfigValue).active === true) : [];
const NEW_PROJECT_GROUP = "__new__";

export interface ProjectGroupSection {
  readonly key: string;
  readonly title: string;
  readonly projects: readonly EntityResult[];
  readonly isUngrouped: boolean;
}

export function existingProjectGroups(projects: readonly EntityResult[], locale: Locale): string[] {
  return [...new Set(projects.map((project) => value(project.document, "group").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, locale));
}

export function groupProjects(projects: readonly EntityResult[], locale: Locale, ungroupedTitle: string): ProjectGroupSection[] {
  const named = new Map<string, EntityResult[]>();
  const ungrouped: EntityResult[] = [];
  for (const project of projects) {
    const group = value(project.document, "group").trim();
    if (group === "") ungrouped.push(project);
    else named.set(group, [...(named.get(group) ?? []), project]);
  }
  const byName = (left: EntityResult, right: EntityResult) =>
    value(left.document, "name").localeCompare(value(right.document, "name"), locale);
  const sections = [...named.entries()]
    .sort(([left], [right]) => left.localeCompare(right, locale))
    .map(([title, items]) => ({
      key: `group:${title}`,
      title,
      projects: [...items].sort(byName),
      isUngrouped: false,
    }));
  if (ungrouped.length > 0) {
    sections.push({
      key: "ungrouped",
      title: ungroupedTitle,
      projects: [...ungrouped].sort(byName),
      isUngrouped: true,
    });
  }
  return sections;
}

function groupOptionValue(group: string, groups: readonly string[]): string {
  const index = groups.indexOf(group.trim());
  return index < 0 ? "" : `group:${index}`;
}

function projectGroupFromForm(data: FormData, groups: readonly string[]): { readonly valid: boolean; readonly group: string; readonly duplicate: boolean } {
  const selected = String(data.get("group") ?? "");
  if (selected === "") return { valid: true, group: "", duplicate: false };
  if (selected === NEW_PROJECT_GROUP) {
    const group = String(data.get("newGroup") ?? "").trim();
    if (group === "" || [...group].length > 100) return { valid: false, group, duplicate: false };
    const duplicate = groups.includes(group);
    return { valid: !duplicate, group, duplicate };
  }
  const match = /^group:(\d+)$/u.exec(selected);
  const group = match === null ? undefined : groups[Number(match[1])];
  return group === undefined ? { valid: false, group: "", duplicate: false } : { valid: true, group, duplicate: false };
}

function ProjectGroupField({ currentGroup = "", disabled, groups, t }: {
  readonly currentGroup?: string;
  readonly disabled: boolean;
  readonly groups: readonly string[];
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const [selected, setSelected] = useState(groupOptionValue(currentGroup, groups));
  const [newGroup, setNewGroup] = useState("");
  useEffect(() => {
    setSelected(groupOptionValue(currentGroup, groups));
    setNewGroup("");
  }, [currentGroup, groups]);
  const duplicate = selected === NEW_PROJECT_GROUP && groups.includes(newGroup.trim());
  return <>
    <label>{t("core.group")}<select disabled={disabled} name="group" onChange={(event) => setSelected(event.target.value)} value={selected}>
      <option value="">{t("core.noGroup")}</option>
      {groups.map((group, index) => <option key={group} value={`group:${index}`}>{group}</option>)}
      <option value={NEW_PROJECT_GROUP}>{t("core.createNewGroup")}</option>
    </select></label>
    {selected === NEW_PROJECT_GROUP && <label>{t("core.newGroupName")}<input disabled={disabled} maxLength={100} name="newGroup" onChange={(event) => setNewGroup(event.target.value)} pattern=".*\S.*" required value={newGroup} />{duplicate && <small className="field-error" role="alert">{t("core.groupAlreadyExists")}</small>}</label>}
  </>;
}

export { newEntityId } from "@gitpm/shared";

function inlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/gu).map((part, index) => part.startsWith("**") && part.endsWith("**")
    ? <strong key={index}>{part.slice(2, -2)}</strong>
    : <Fragment key={index}>{part}</Fragment>);
}

export function SafeMarkdown({ source }: { readonly source: string }) {
  return <div className="safe-markdown">{source.split(/\r?\n/u).map((line, index) => {
    if (line.startsWith("# ")) return <h4 key={index}>{inlineMarkdown(line.slice(2))}</h4>;
    if (line.startsWith("- ")) return <div className="markdown-list-item" key={index}>• {inlineMarkdown(line.slice(2))}</div>;
    return line === "" ? <br key={index} /> : <p key={index}>{inlineMarkdown(line)}</p>;
  })}</div>;
}

export type CoreSurface = "portfolio" | "projects" | "tasks";

export function CoreWorkspace({ api, draft, locale, surface = "projects", initialProjectId = "", initialTaskId = "", initialCommentId = "", initialStatusFilter = "", initialMilestoneFilter = "", onNavigate = () => undefined, confirmAction = () => true, onChanged }: {
  readonly api: GitPmApi;
  readonly draft: DraftStatus;
  readonly locale: Locale;
  readonly surface?: CoreSurface;
  readonly initialProjectId?: string;
  readonly initialTaskId?: string;
  readonly initialCommentId?: string;
  readonly initialStatusFilter?: string;
  readonly initialMilestoneFilter?: string;
  readonly onNavigate?: WorkspaceNavigate;
  readonly confirmAction?: (message: string) => boolean;
  readonly onChanged: () => Promise<void>;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [projects, setProjects] = useState<readonly EntityResult[]>([]);
  const [milestones, setMilestones] = useState<readonly EntityResult[]>([]);
  const [tasks, setTasks] = useState<readonly EntityResult[]>([]);
  const [people, setPeople] = useState<readonly EntityResult[]>([]);
  const [projectId, setProjectId] = useState<string>(initialProjectId);
  const [selectedTask, setSelectedTask] = useState<string>(initialTaskId);
  const [filter, setFilter] = useState(initialStatusFilter);
  const [milestoneFilter, setMilestoneFilter] = useState(initialMilestoneFilter);
  const [fingerprint, setFingerprint] = useState(draft.fingerprint);
  const [error, setError] = useState<string | null>(null);
  const [statusOptions, setStatusOptions] = useState<readonly ConfigValue[]>([]);
  const [typeOptions, setTypeOptions] = useState<readonly ConfigValue[]>([]);
  const [feedback, setFeedback] = useState<MutationFeedback | null>(null);
  const [createEditor, setCreateEditor] = useState<CoreCreateEditor>(null);
  const [statusPending, setStatusPending] = useState<string | null>(null);
  const previousEntities = useRef<readonly EntityResult[]>([]);
  const lastExternalFingerprint = useRef(draft.external_fingerprint);
  const loadRequest = useAsyncLoad();
  const { highlights: externalHighlights, mark: markExternal } = useExternalHighlights();
  const { highlights: localHighlights, mark: markLocal } = useExternalHighlights(500);
  const highlights = { ...externalHighlights, ...localHighlights };
  const reducedMotion = useReducedMotion();
  const readOnly = draftReadOnlyReason(draft) !== null;
  const acknowledgeExternalChanges = () => {
    setError(null);
    void api.acknowledgeExternalChanges(draft.draft_id)
      .then(async () => await onChanged())
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  };

  const load = useCallback(async (preferredProject = projectId, externalUpdate = false) => {
    await loadRequest.run(async () => {
      const [nextProjects, nextPeople, statusConfig, typeConfig] = await Promise.all([api.listEntities(draft.draft_id, "projects"), api.listEntities(draft.draft_id, "people"), api.getConfiguration(draft.draft_id, "statuses"), api.getConfiguration(draft.draft_id, "issue-types")]);
      const nextProject = nextProjects.some((item) => item.document.id === preferredProject && item.document.lifecycle === "active") ? preferredProject : "";
      const [nextMilestones, nextTasks] = surface === "portfolio" || (surface === "projects" && nextProject === "")
        ? await Promise.all([api.listEntities(draft.draft_id, "milestones"), api.listEntities(draft.draft_id, "tasks")])
        : nextProject === "" ? [[], []]
          : surface === "projects" ? await Promise.all([api.listEntities(draft.draft_id, "milestones", nextProject), api.listEntities(draft.draft_id, "tasks", nextProject)])
            : await Promise.all([api.listEntities(draft.draft_id, "milestones"), api.listEntities(draft.draft_id, "tasks", nextProject)]);
      return { nextProjects, nextPeople, nextProject, nextMilestones, nextTasks, statusConfig, typeConfig };
    }, ({ nextProjects, nextPeople, nextProject, nextMilestones, nextTasks, statusConfig, typeConfig }) => {
      const nextEntities = [...nextProjects, ...nextPeople, ...nextMilestones, ...nextTasks, statusConfig, typeConfig];
      if (externalUpdate) markExternal(changedEntityFields(previousEntities.current, nextEntities));
      previousEntities.current = nextEntities;
      setProjects(nextProjects); setPeople(nextPeople); setProjectId(nextProject); setMilestones(nextMilestones); setTasks(nextTasks);
      setStatusOptions(configValues(statusConfig.document, "statuses")); setTypeOptions(configValues(typeConfig.document, "issue_types"));
      setFingerprint(nextProjects[0]?.draft_fingerprint ?? nextMilestones[0]?.draft_fingerprint ?? nextTasks[0]?.draft_fingerprint ?? draft.fingerprint);
    }, { keepData: true });
  }, [api, draft.draft_id, draft.fingerprint, loadRequest.run, markExternal, projectId, surface]);

  useEffect(() => { setSelectedTask(initialTaskId); void load(initialProjectId); }, [draft.draft_id, surface]);
  useEffect(() => { setFilter(initialStatusFilter); setMilestoneFilter(initialMilestoneFilter); }, [initialMilestoneFilter, initialStatusFilter]);
  useEffect(() => {
    if (draft.writer_mode !== "external" || draft.external_fingerprint === undefined || draft.external_fingerprint === lastExternalFingerprint.current) return;
    lastExternalFingerprint.current = draft.external_fingerprint;
    void load(projectId, true);
  }, [draft.external_fingerprint]);

  const mutate = async (operation: () => Promise<EntityResult>, preferredProject = projectId) => {
    setError(null); setFeedback({ kind: "saving", text: t("feedback.saving") });
    try {
      const result = await operation(); setFingerprint(result.draft_fingerprint);
      if (result.document.schema === "gitpm/project@1") setProjects((current) => upsertEntity(current, result));
      if (result.document.schema === "gitpm/person@1") setPeople((current) => upsertEntity(current, result));
      if (result.document.schema === "gitpm/milestone@1") setMilestones((current) => upsertEntity(current, result));
      if (result.document.schema === "gitpm/task@1") setTasks((current) => upsertEntity(current, result));
      markLocal({ [result.document.id]: ["$local"] }); await onChanged(); await load(preferredProject); setFeedback({ kind: "saved", text: t("feedback.saved") }); return result;
    }
    catch (caught) { setFeedback(null); setError(caught instanceof Error ? caught.message : String(caught)); return null; }
  };
  const remove = async (operation: () => Promise<void>) => {
    setError(null); setFeedback({ kind: "saving", text: t("feedback.saving") });
    try { await operation(); await load(); await onChanged(); setFeedback({ kind: "saved", text: t("feedback.saved") }); return true; } catch (caught) { setFeedback(null); setError(caught instanceof Error ? caught.message : String(caught)); return false; }
  };
  const changeTaskStatus = (task: EntityResult, status: string) => {
    if (statusPending !== null || value(task.document, "status") === status) return;
    const previous = tasks;
    const document = { ...task.document, status } as GitPmDocument;
    setStatusPending(task.document.id);
    setTasks(upsertEntity(tasks, { ...task, document }));
    void mutate(async () => { const result = await api.updateEntity(draft.draft_id, "tasks", task, fingerprint, document); setStatusPending(null); return result; })
      .then((result) => { if (result === null) setTasks(previous); })
      .finally(() => setStatusPending(null));
  };

  const activeProjects = projects.filter((item) => item.document.lifecycle === "active");
  const activeMilestones = milestones.filter((item) => item.document.lifecycle === "active");
  const activeTasks = tasks.filter((item) => item.document.lifecycle === "active");
  const existingGroups = useMemo(() => existingProjectGroups(projects, locale), [projects, locale]);
  const projectGroupSections = useMemo(
    () => groupProjects(projects.filter((item) => item.document.lifecycle === "active"), locale, message(locale, "core.ungroupedProjects")),
    [projects, locale],
  );
  const statuses = useMemo(() => [...new Set([...statusOptions.map((item) => item.slug), ...activeTasks.map((item) => value(item.document, "status"))])], [activeTasks, statusOptions]);
  const statusTitle = (slug: string) => statusOptions.find((item) => item.slug === slug)?.title ?? slug;
  const confirmDelete = (name: string) => confirmAction(t("core.deleteConfirm", { name }));
  const filteredTasks = activeTasks.filter((item) => (filter === "" || value(item.document, "status") === filter) && (milestoneFilter === "" || (milestoneFilter === "none" ? value(item.document, "milestone") === "" : value(item.document, "milestone") === milestoneFilter)));
  const task = tasks.find((item) => item.document.id === selectedTask);
  const selectedProject = projects.find((item) => item.document.id === projectId);
  const selectedProjectName = selectedProject === undefined ? "" : value(selectedProject.document, "name");
  const catalog = useMemo(() => new EntityCatalog({ projects, milestones, tasks }), [projects, milestones, tasks]);
  const filterMilestones = activeMilestones.filter((item) => projectId === "" || item.document.project === projectId);
  const completedTasks = activeTasks.filter((item) => value(item.document, "status") === "done").length;
  const openPerson = (personId: string) => onNavigate("people", { personId });
  const taskQuery = (status = filter, milestone = milestoneFilter) => ({ ...(status === "" ? {} : { status: [status] }), ...(milestone === "" ? {} : { milestone: [milestone] }) });
  const projectRisk = (project: EntityResult) => { const due = value(project.document, "due"); if (!/^\d{4}-\d{2}-\d{2}$/u.test(due)) return "unknown" as const; const days = Math.ceil((Date.parse(`${due}T00:00:00Z`) - Date.now()) / 86_400_000); return days < 0 ? "overdue" as const : days <= 14 ? "near" as const : "onTrack" as const; };
  const renderProjectRegisterHeader = () => <div className="project-register-head"><span>{t("core.projects")}</span><span>{t("core.status")}</span><span>{t("core.owner")}</span><span>{t("core.tasks")}</span><span>{t("core.milestones")}</span><span>{t("core.due")}</span><span>{t("core.risk")}</span></div>;
  const renderProjectRow = (project: EntityResult) => {
    const projectTasks = activeTasks.filter((item) => item.document.project === project.document.id).length;
    const projectMilestones = activeMilestones.filter((item) => item.document.project === project.document.id).length;
    const due = value(project.document, "due");
    const risk = projectRisk(project);
    return <button className="project-register-row" key={project.document.id} onClick={() => onNavigate("projects", { projectId: project.document.id })}><span><strong>{value(project.document, "name")}</strong><code>{project.document.id}</code><small>{value(project.document, "description_markdown") || t("core.noDescription")}</small></span><span><span className="state open">{statusTitle(value(project.document, "status"))}</span></span><span><PersonLinks empty={t("core.unassigned")} onOpen={openPerson} people={people} personIds={value(project.document, "owner") ? [value(project.document, "owner")] : []} /></span><span>{projectTasks}</span><span>{projectMilestones}</span><span>{due === "" ? "—" : formatDateOnly(locale, due)}</span><span className={`project-risk ${risk}`}>{t(`core.risk${risk === "onTrack" ? "OnTrack" : risk === "near" ? "Near" : risk === "overdue" ? "Overdue" : "Unknown"}` as MessageKey)}</span></button>;
  };
  const headingKey: MessageKey = surface === "portfolio" ? "core.portfolioHeading" : surface === "tasks" ? "core.tasksHeading" : "core.projectsHeading";
  const descriptionKey: MessageKey = surface === "portfolio" ? "core.portfolioDescription" : surface === "tasks" ? "core.tasksDescription" : "core.projectsDescription";
  const pageHeading = task !== undefined ? value(task.document, "title") : surface === "projects" && selectedProject !== undefined ? selectedProjectName : t(headingKey);
  const pageDescription = task !== undefined ? t("core.taskDetailDescription") : surface === "projects" && selectedProject !== undefined ? t("core.projectDetailDescription") : projectId === "" && surface === "tasks" ? t("core.allTasksDescription") : t(descriptionKey);

  const createProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const id = newUniqueEntityId(ENTITY_ID_PREFIX.project, new Set(projects.map((item) => item.document.id)));
    const selectedGroup = projectGroupFromForm(data, existingGroups);
    if (!selectedGroup.valid) {
      if (selectedGroup.duplicate) setError(t("core.groupAlreadyExists"));
      return;
    }
    const document = { schema: "gitpm/project@1", id, name: String(data.get("name")), status: statusOptions[0]?.slug ?? "backlog", lifecycle: "active", ...(selectedGroup.group === "" ? {} : { group: selectedGroup.group }), description_markdown: String(data.get("description")) } as GitPmDocument;
    void mutate(async () => await api.createEntity(draft.draft_id, "projects", fingerprint, document), id).then((result) => { if (result !== null) { setCreateEditor(null); onNavigate("projects", { projectId: id }); } });
  };
  const createMilestone = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const document = { schema: "gitpm/milestone@1", id: newUniqueEntityId(ENTITY_ID_PREFIX.milestone, new Set(milestones.map((item) => item.document.id))), project: projectId, name: String(data.get("name")), lifecycle: "active", description_markdown: String(data.get("description")), ...(data.get("due") ? { due: String(data.get("due")) } : {}) } as GitPmDocument;
    void mutate(async () => await api.createEntity(draft.draft_id, "milestones", fingerprint, document)).then((result) => { if (result !== null) setCreateEditor(null); });
  };
  const createTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const milestone = String(data.get("milestone")); const start = String(data.get("start")); const due = String(data.get("due")); const estimate = String(data.get("estimate"));
    const document = { schema: "gitpm/task@1", id: newUniqueEntityId(ENTITY_ID_PREFIX.task, new Set(tasks.map((item) => item.document.id))), project: projectId, title: String(data.get("title")), type: typeOptions[0]?.slug ?? "task", status: String(data.get("status")), lifecycle: "active", description_markdown: String(data.get("description")), assignees: data.getAll("assignees").map(String), ...(milestone ? { milestone } : {}), ...(start ? { start } : {}), ...(due ? { due } : {}), ...(estimate ? { estimate_hours: Number(estimate) } : {}) } as GitPmDocument;
    void mutate(async () => await api.createEntity(draft.draft_id, "tasks", fingerprint, document)).then((result) => { if (result !== null) setCreateEditor(null); });
  };

  return <section className={`core-workspace core-${surface}-workspace${reducedMotion ? " reduced-motion" : ""}`} data-reduced-motion={reducedMotion} data-surface={surface}>
    {!(surface === "projects" && projectId === "") && <div className="section-heading"><div><span className="eyebrow draft-context-id">{draft.draft_id}</span><h2 aria-hidden="true">{pageHeading}</h2><p>{pageDescription}</p></div></div>}
    <DraftReadOnlyAlert draft={draft} locale={locale} onAcknowledge={acknowledgeExternalChanges} />{error !== null && <div className="alert error">{error}</div>}
    {feedback !== null && <div aria-live="polite" className={`save-feedback ${feedback.kind}`} role="status"><span>{feedback.text}</span></div>}
    <AsyncBoundary state={loadRequest.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{loadError}<button onClick={retry}>{t("status.retry")}</button></div>}>
    <>
    {surface === "portfolio" && <>
      <div className="portfolio-stats">
        <div className="card"><span>{t("core.projectsTotal")}</span><strong>{activeProjects.length}</strong></div>
        <div className="card"><span>{t("core.tasksTotal")}</span><strong>{activeTasks.length}</strong></div>
        <div className="card"><span>{t("core.milestonesTotal")}</span><strong>{activeMilestones.length}</strong></div>
        <div className="card"><span>{t("core.completedTasks")}</span><strong>{completedTasks}</strong></div>
      </div>
      <section className="card portfolio-projects"><h3>{t("core.projects")}</h3>
        {activeProjects.length === 0 ? <p>{t("core.empty")}</p> : <div className="portfolio-project-grid">{activeProjects.map((project) => {
          const projectTasks = activeTasks.filter((item) => item.document.project === project.document.id).length;
          const projectMilestones = activeMilestones.filter((item) => item.document.project === project.document.id).length;
          const due = value(project.document, "due"); const risk = projectRisk(project);
          return <article className="portfolio-project-card" key={project.document.id}><button className="portfolio-project-link" onClick={() => onNavigate("projects", { projectId: project.document.id })}><span><strong>{value(project.document, "name")}</strong><code>{project.document.id}</code></span><span className="state open">{statusTitle(value(project.document, "status"))}</span><dl><div><dt>{t("core.tasks")}</dt><dd>{projectTasks}</dd></div><div><dt>{t("core.milestones")}</dt><dd>{projectMilestones}</dd></div><div><dt>{t("core.owner")}</dt><dd><PersonLinks empty={t("core.unassigned")} onOpen={openPerson} people={people} personIds={value(project.document, "owner") ? [value(project.document, "owner")] : []} /></dd></div><div><dt>{t("core.due")}</dt><dd>{due === "" ? "—" : formatDateOnly(locale, due)}</dd></div></dl><span className={`project-risk ${risk}`}>{t(`core.risk${risk === "onTrack" ? "OnTrack" : risk === "near" ? "Near" : risk === "overdue" ? "Overdue" : "Unknown"}` as MessageKey)}</span></button></article>;
        })}</div>}
      </section>
    </>}
    {surface === "projects" && (projectId === "" ? <section className="project-directory"><div className="card-heading"><div><h3>{t("core.projectList")}</h3><p>{t("core.portfolioDescription")}</p></div><button className="primary" disabled={readOnly} onClick={() => { setError(null); setCreateEditor("project"); }} type="button">+ {t("core.createProjectAction")}</button><EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setCreateEditor(null)} open={createEditor === "project"} title={t("core.createProjectAction")}><form className="editor-drawer-form" onSubmit={createProject}><label>{t("core.name")}<input disabled={readOnly} name="name" required /></label><ProjectGroupField currentGroup="" disabled={readOnly} groups={existingGroups} key={createEditor === "project" ? "open" : "closed"} t={t} /><label>{t("core.description")}<textarea disabled={readOnly} name="description" /></label><div className="editor-drawer-actions"><button onClick={() => setCreateEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.createProject")}</button></div></form></EditorDrawer></div>
      <dl className="project-register-summary"><div><dt>{t("core.projectsTotal")}</dt><dd>{activeProjects.length}</dd></div><div><dt>{t("core.tasksTotal")}</dt><dd>{activeTasks.length}</dd></div><div><dt>{t("core.milestonesTotal")}</dt><dd>{activeMilestones.length}</dd></div><div><dt>{t("core.completedTasks")}</dt><dd>{completedTasks}</dd></div></dl>
      {activeProjects.length === 0 ? <p>{t("core.empty")}</p> : <div className="project-groups">{projectGroupSections.map((group) => <section className="project-group" data-ungrouped={group.isUngrouped || undefined} key={group.key}><header className="project-group-heading"><h4>{group.title}</h4><span>{t("core.projectsCount", { count: group.projects.length })}</span></header><div className="project-register" aria-label={group.title}>{renderProjectRegisterHeader()}{group.projects.map(renderProjectRow)}</div></section>)}</div>}
    </section> : selectedProject === undefined ? <div className="card empty-workspace">{t("core.projectNotFound")}</div> : <div className="project-detail-layout">
      <EntityEditor api={api} confirmDelete={confirmDelete} detail entity={selectedProject} entityType="projects" draft={draft} existingGroups={existingGroups} fingerprint={fingerprint} readOnly={readOnly} externalFields={highlights[selectedProject.document.id]} t={t} statusLabel={statusTitle(value(selectedProject.document, "status"))} openTasks={() => onNavigate("tasks", { projectId })} openBoard={() => onNavigate("board", { projectId })} openGantt={() => onNavigate("gantt", { projectId })} save={mutate} remove={remove} />
      <section className="card entity-column"><h3>{t("core.milestonesFor", { project: selectedProjectName })}</h3>
        <button className="primary editor-trigger" disabled={readOnly} onClick={() => setCreateEditor("milestone")} type="button">+ {t("core.createMilestoneAction")}</button><EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setCreateEditor(null)} open={createEditor === "milestone"} title={t("core.createMilestoneAction")}><form className="editor-drawer-form" onSubmit={createMilestone}><label>{t("core.name")}<input disabled={readOnly} name="name" required /></label><label>{t("core.due")}<input disabled={readOnly} name="due" type="date" /></label><label>{t("core.description")}<textarea disabled={readOnly} name="description" /></label><div className="editor-drawer-actions"><button onClick={() => setCreateEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.createMilestone")}</button></div></form></EditorDrawer>
        <div className="entity-list">{activeMilestones.length === 0 ? <p>{t("core.noMilestones")}</p> : activeMilestones.map((milestone) => { const milestoneTasks = activeTasks.filter((item) => item.document.milestone === milestone.document.id); const completed = milestoneTasks.filter((item) => value(item.document, "status") === "done").length; return <EntityEditor api={api} confirmArchive={() => confirmAction(t("core.archiveMilestoneConfirm", { name: value(milestone.document, "name"), count: milestoneTasks.length }))} confirmDelete={confirmDelete} key={milestone.document.id} entity={milestone} entityType="milestones" draft={draft} fingerprint={fingerprint} readOnly={readOnly} externalFields={highlights[milestone.document.id]} t={t} milestoneTaskCount={milestoneTasks.length} milestoneCompletedCount={completed} openMilestoneTasks={() => onNavigate("stages", { projectId, stageId: milestone.document.id })} save={mutate} remove={remove} />; })}</div>
      </section>
    </div>)}
    {surface === "tasks" && (task !== undefined ? <div className="task-detail-page"><button className="text-link back-link" onClick={() => onNavigate("tasks", { projectId, query: taskQuery() })}>← {t("core.backToTasks")}</button><TaskPanel api={api} catalog={catalog} confirmCommentDelete={() => confirmAction(t("comments.deleteConfirm"))} confirmDelete={confirmDelete} draft={draft} entity={task} fingerprint={fingerprint} focusedCommentId={initialCommentId || undefined} milestones={milestones} people={people} projects={activeProjects} readOnly={readOnly} externalFields={highlights[task.document.id]} locale={locale} statusOptions={statusOptions} typeOptions={typeOptions} onCommentChanged={async (nextFingerprint) => { setFingerprint(nextFingerprint); await onChanged(); }} onNavigate={onNavigate} onDeleted={() => onNavigate("tasks", { projectId })} onStatusChange={(status) => changeTaskStatus(task, status)} save={mutate} remove={remove} statusBusy={statusPending !== null} /></div> : selectedTask !== "" ? <div className="card empty-workspace"><p>{t("core.taskNotFound")}</p><button onClick={() => onNavigate("tasks", { projectId, query: taskQuery() })}>{t("core.backToTasks")}</button></div> : <section className="card task-area"><div className="task-toolbar"><div><h3>{projectId === "" ? t("core.allTasks") : t("core.tasksFor", { project: selectedProjectName })}</h3><p>{t(projectId === "" ? "core.allTasksHint" : "core.projectTasksHint")}</p></div><div className="task-toolbar-controls"><label>{t("core.project")}<select aria-label={t("core.project")} value={projectId} onChange={(event) => onNavigate("tasks", { projectId: event.target.value, query: taskQuery(filter, "") })}><option value="">{t("core.chooseProjectOption")}</option>{activeProjects.map((project) => <option key={project.document.id} value={project.document.id}>{value(project.document, "name")}</option>)}</select></label><label>{t("core.filter")}<select value={filter} onChange={(event) => onNavigate("tasks", { projectId, query: taskQuery(event.target.value, milestoneFilter) })}><option value="">{t("core.allStatuses")}</option>{statuses.map((status) => <option key={status} value={status}>{statusTitle(status)}</option>)}</select></label><label>{t("core.milestone")}<select aria-label={t("core.milestone")} value={milestoneFilter} onChange={(event) => onNavigate("tasks", { projectId, query: taskQuery(filter, event.target.value) })}><option value="">{t("core.allMilestones")}</option>{projectId !== "" && <option value="none">{t("stages.withoutStage")}</option>}{filterMilestones.map((milestone) => <option key={milestone.document.id} value={milestone.document.id}>{projectId === "" ? `${catalog.project(milestone.document.project).name} · ` : ""}{value(milestone.document, "name")}</option>)}</select></label></div></div>
      {projectId === "" ? <div className="scope-hint">{t("core.selectProjectToCreate")}</div> : <><button className="primary editor-trigger" disabled={readOnly} onClick={() => setCreateEditor("task")} type="button">+ {t("core.createTaskAction")}</button><EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setCreateEditor(null)} open={createEditor === "task"} title={t("core.createTaskAction")}><form className="editor-drawer-form" onSubmit={createTask}><label>{t("core.title")}<input disabled={readOnly} name="title" required /></label><label>{t("core.status")}<select disabled={readOnly} name="status">{statusOptions.map((status) => <option key={status.slug} value={status.slug}>{status.title}</option>)}</select></label><label>{t("core.milestone")}<select disabled={readOnly} name="milestone"><option value="">{t("core.noMilestone")}</option>{filterMilestones.map((milestone) => <option key={milestone.document.id} value={milestone.document.id}>{value(milestone.document, "name")}</option>)}</select></label><AssigneeChecks disabled={readOnly} people={people.filter((person) => person.document.lifecycle === "active")} selected={[]} t={t} /><label>{t("projectPlan.start")}<input disabled={readOnly} name="start" type="date" /></label><label>{t("core.due")}<input disabled={readOnly} name="due" type="date" /></label><label>{t("projectPlan.estimate")}<input disabled={readOnly} min="0" name="estimate" step="0.25" type="number" /></label><label>{t("core.description")}<textarea disabled={readOnly} name="description" /></label><div className="editor-drawer-actions"><button onClick={() => setCreateEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.createTask")}</button></div></form></EditorDrawer></>}
      <div className="task-table">{filteredTasks.length === 0 ? <p>{t("core.empty")}</p> : filteredTasks.map((item) => { const assignees = values(item.document, "assignees"); return <div className={`task-row${highlights[item.document.id]?.includes("$local") ? " recently-changed" : highlights[item.document.id] ? " external-update" : ""}${statusPending === item.document.id ? " is-saving" : ""}`} data-external-fields={highlights[item.document.id]?.join(",")} key={item.document.id}><button onClick={() => onNavigate("tasks", { projectId: value(item.document, "project"), taskId: item.document.id, query: taskQuery() })}><strong>{value(item.document, "title")}</strong><code>{item.document.id}</code>{projectId === "" && <span>{catalog.project(item.document.project).name}</span>}{catalog.milestone(item.document.milestone) !== undefined && <span className="task-milestone">{catalog.milestone(item.document.milestone)?.name}</span>}<span className="task-assignees"><PersonLinks empty={t("core.unassigned")} onOpen={openPerson} people={people} personIds={assignees} /></span></button>{readOnly ? <span className="state open">{statusTitle(value(item.document, "status"))}</span> : <select aria-label={`${t("core.status")}: ${value(item.document, "title")}`} className="inline-status-select" disabled={statusPending !== null} onChange={(event) => changeTaskStatus(item, event.target.value)} value={value(item.document, "status")}>{statusOptions.map((status) => <option key={status.slug} value={status.slug}>{status.title}</option>)}</select>}</div>; })}</div>
    </section>)}
    </>
    </AsyncBoundary>
  </section>;
}

function EntityEditor({ api, entity, entityType, draft, existingGroups = [], fingerprint, readOnly, externalFields, t, selected = false, detail = false, statusLabel, select, openTasks, openBoard, openGantt, milestoneTaskCount, milestoneCompletedCount, openMilestoneTasks, confirmArchive, confirmDelete, save, remove }: {
  readonly api: GitPmApi; readonly entity: EntityResult; readonly entityType: "projects" | "milestones"; readonly draft: DraftStatus; readonly fingerprint: string; readonly readOnly: boolean; readonly externalFields?: readonly string[]; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string; readonly selected?: boolean; readonly select?: () => void;
  readonly existingGroups?: readonly string[];
  readonly detail?: boolean; readonly statusLabel?: string;
  readonly openTasks?: () => void; readonly openBoard?: () => void; readonly openGantt?: () => void;
  readonly milestoneTaskCount?: number; readonly milestoneCompletedCount?: number; readonly openMilestoneTasks?: () => void;
  readonly confirmArchive?: () => boolean;
  readonly confirmDelete: (name: string) => boolean;
  readonly save: (operation: () => Promise<EntityResult>, preferredProject?: string) => Promise<EntityResult | null>; readonly remove: (operation: () => Promise<void>) => Promise<boolean>;
}) {
  const [editorOpen, setEditorOpen] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const due = String(data.get("due") ?? "");
    const document = { ...entity.document, name: String(data.get("name")), description_markdown: String(data.get("description")), ...(entityType === "milestones" ? (due ? { due } : { due: undefined }) : {}) } as GitPmDocument;
    if (entityType === "projects") {
      const selectedGroup = projectGroupFromForm(data, existingGroups);
      if (!selectedGroup.valid) return;
      if (selectedGroup.group === "") delete (document as Record<string, unknown>).group;
      else (document as Record<string, unknown>).group = selectedGroup.group;
    }
    void save(async () => await api.updateEntity(draft.draft_id, entityType, entity, fingerprint, document), entityType === "projects" ? entity.document.id : undefined).then((result) => { if (result !== null) setEditorOpen(false); });
  };
  const name = value(entity.document, "name");
  return <article className={`entity-card${detail ? " entity-detail-card card" : ""}${selected ? " selected" : ""}${externalFields?.includes("$local") ? " recently-changed" : externalFields ? " external-update" : ""}`} data-external-fields={externalFields?.join(",")}>
    <div className="entity-title-row">{select !== undefined ? <button type="button" className="entity-select entity-title" onClick={select}><strong>{name}</strong><code>{entity.document.id}</code></button> : entityType === "milestones" && openMilestoneTasks !== undefined ? <button type="button" className="entity-select entity-title" onClick={openMilestoneTasks}><strong>{name}</strong><code>{entity.document.id}</code></button> : <div className="entity-title"><strong>{name}</strong><code>{entity.document.id}</code></div>}{statusLabel !== undefined && <span className="state open">{statusLabel}</span>}</div>
    {entityType === "milestones" && value(entity.document, "due") !== "" && <span className="entity-meta">{t("core.due")}: {value(entity.document, "due")}</span>}
    {entityType === "projects" && value(entity.document, "group").trim() !== "" && <span className="entity-meta">{t("core.group")}: {value(entity.document, "group").trim()}</span>}
    {entityType === "milestones" && milestoneTaskCount !== undefined && <button type="button" className="text-link milestone-task-summary" onClick={openMilestoneTasks}>{t("core.milestoneTaskProgress", { completed: milestoneCompletedCount ?? 0, count: milestoneTaskCount })}</button>}
    {value(entity.document, "description_markdown") !== "" && <p className="entity-summary">{value(entity.document, "description_markdown")}</p>}
    {entityType === "projects" && <div className="entity-links"><button type="button" className="text-link" onClick={openTasks}>{t("core.openTasks")}</button><button type="button" className="text-link" onClick={openBoard}>{t("core.openBoard")}</button><button type="button" className="text-link" onClick={openGantt}>{t("core.openGantt")}</button></div>}
    <button className="editor-trigger" onClick={() => setEditorOpen(true)} type="button">{t("core.edit")}</button>
    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditorOpen(false)} open={editorOpen} title={`${t("core.edit")}: ${name}`}><form className="editor-drawer-form" onSubmit={submit}>
      <label>{t("core.name")}<input disabled={readOnly} name="name" aria-label={`${t("core.name")} ${name}`} defaultValue={name} required /></label>
      {entityType === "projects" && <ProjectGroupField currentGroup={value(entity.document, "group")} disabled={readOnly} groups={existingGroups} key={editorOpen ? "open" : "closed"} t={t} />}
      {entityType === "milestones" && <label>{t("core.due")}<input disabled={readOnly} name="due" type="date" aria-label={`${t("core.due")} ${name}`} defaultValue={value(entity.document, "due")} /></label>}
      <label>{t("core.description")}<textarea disabled={readOnly} name="description" aria-label={`${t("core.description")} ${name}`} defaultValue={value(entity.document, "description_markdown")} /></label>
      <div className="editor-drawer-actions"><details className="more-actions"><summary>{t("core.moreActions")}</summary><div><button type="button" disabled={readOnly} onClick={() => { if (confirmArchive?.() ?? true) void save(async () => await api.archiveEntity(draft.draft_id, entityType, entity, fingerprint), entityType === "projects" ? "" : undefined).then((result) => { if (result !== null) setEditorOpen(false); }); }}>{t("core.archive")}</button><button type="button" className="danger" disabled={readOnly} onClick={() => { if (confirmDelete(name)) void remove(async () => await api.deleteEntity(draft.draft_id, entityType, entity, fingerprint)).then((success) => { if (success) setEditorOpen(false); }); }}>{t("core.delete")}</button></div></details><button onClick={() => setEditorOpen(false)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly}>{t("core.save")}</button></div>
    </form></EditorDrawer>
  </article>;
}

export function TaskPanel({ api, catalog, draft, entity, fingerprint, milestones, people, projects, readOnly, externalFields, locale, statusOptions, typeOptions, confirmDelete, confirmCommentDelete, focusedCommentId, onNavigate, onDeleted, onCommentChanged, onStatusChange, statusBusy = false, save, remove }: { readonly api: GitPmApi; readonly catalog: EntityCatalog; readonly draft: DraftStatus; readonly entity: EntityResult; readonly fingerprint: string; readonly milestones: readonly EntityResult[]; readonly people: readonly EntityResult[]; readonly projects: readonly EntityResult[]; readonly readOnly: boolean; readonly externalFields?: readonly string[]; readonly locale: Locale; readonly statusOptions: readonly ConfigValue[]; readonly typeOptions: readonly ConfigValue[]; readonly confirmDelete: (name: string) => boolean; readonly confirmCommentDelete: () => boolean; readonly focusedCommentId?: string; readonly onNavigate: WorkspaceNavigate; readonly onDeleted: () => void; readonly onCommentChanged: (fingerprint: string) => Promise<void>; readonly onStatusChange?: (status: string) => void; readonly statusBusy?: boolean; readonly save: (operation: () => Promise<EntityResult>) => Promise<EntityResult | null>; readonly remove: (operation: () => Promise<void>) => Promise<boolean> }) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [title, setTitle] = useState(value(entity.document, "title"));
  const [status, setStatus] = useState(value(entity.document, "status"));
  const [type, setType] = useState(value(entity.document, "type"));
  const [description, setDescription] = useState(value(entity.document, "description_markdown"));
  const [milestone, setMilestone] = useState(value(entity.document, "milestone"));
  const [assignees, setAssignees] = useState(values(entity.document, "assignees"));
  const [start, setStart] = useState(value(entity.document, "start"));
  const [due, setDue] = useState(value(entity.document, "due"));
  const [estimate, setEstimate] = useState(typeof entity.document.estimate_hours === "number" ? String(entity.document.estimate_hours) : "");
  const [targetProject, setTargetProject] = useState("");
  const [targetMilestone, setTargetMilestone] = useState("");
  const [editor, setEditor] = useState<"edit" | "move" | null>(null);
  useEffect(() => { setTitle(value(entity.document, "title")); setStatus(value(entity.document, "status")); setType(value(entity.document, "type")); setDescription(value(entity.document, "description_markdown")); setMilestone(value(entity.document, "milestone")); setAssignees(values(entity.document, "assignees")); setStart(value(entity.document, "start")); setDue(value(entity.document, "due")); setEstimate(typeof entity.document.estimate_hours === "number" ? String(entity.document.estimate_hours) : ""); }, [entity]);
  const entityStatus = value(entity.document, "status");
  const entityType = value(entity.document, "type");
  const statusTitle = statusOptions.find((item) => item.slug === entityStatus)?.title ?? entityStatus;
  const typeTitle = typeOptions.find((item) => item.slug === entityType)?.title ?? entityType;
  const references = catalog.referencesForTask(entity.document);
  const selectableMilestones = milestones.filter((item) => item.document.lifecycle === "active" || item.document.id === milestone);
  const selectablePeople = people.filter((item) => item.document.lifecycle === "active" || assignees.includes(item.document.id));
  const assigneeIds = values(entity.document, "assignees");
  const targetProjects = projects.filter((item) => item.document.id !== references.project.id);
  const targetMilestones = milestones.filter((item) => item.document.lifecycle === "active" && item.document.project === targetProject);
  return <section className={`card task-detail-card${externalFields?.includes("$local") ? " recently-changed" : externalFields ? " external-update" : ""}`} data-external-fields={externalFields?.join(",")}>
    <div className="detail-heading"><div><span className="eyebrow">{t("core.details")}</span><h2>{value(entity.document, "title")}</h2><code>{entity.document.id}</code></div>{onStatusChange === undefined || readOnly ? <span className="state open">{statusTitle}</span> : <select aria-label={`${t("core.status")}: ${value(entity.document, "title")}`} className="inline-status-select" disabled={statusBusy} onChange={(event) => onStatusChange(event.target.value)} value={entityStatus}>{statusOptions.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select>}</div>
    <dl className="task-detail-meta"><div><dt>{t("core.project")}</dt><dd><button className="text-link" onClick={() => onNavigate("projects", { projectId: references.project.id })}>{references.project.name}</button></dd></div><div><dt>{t("core.type")}</dt><dd>{typeTitle}</dd></div><div><dt>{t("core.milestone")}</dt><dd>{references.milestone === undefined ? t("core.noMilestone") : <button className="text-link" onClick={() => onNavigate("stages", { projectId: references.project.id, stageId: references.milestoneId })}>{references.milestone.name}{references.milestone.lifecycle === "archived" && <small className="archived-reference"> · {t("core.archived")}</small>}</button>}</dd></div><div><dt>{t("core.assignees")}</dt><dd><PersonLinks empty={t("core.unassigned")} onOpen={(personId) => onNavigate("people", { personId })} people={people} personIds={assigneeIds} /></dd></div><div><dt>{t("projectPlan.start")}</dt><dd>{value(entity.document, "start") ? formatDateOnly(locale, value(entity.document, "start")) : "—"}</dd></div><div><dt>{t("core.due")}</dt><dd>{value(entity.document, "due") ? formatDateOnly(locale, value(entity.document, "due")) : "—"}</dd></div><div><dt>{t("projectPlan.estimate")}</dt><dd>{typeof entity.document.estimate_hours === "number" ? `${entity.document.estimate_hours} h` : "—"}</dd></div></dl>
    <div className="task-description"><h3>{t("core.description")}</h3>{value(entity.document, "description_markdown") === "" ? <p className="empty-copy">{t("core.noDescription")}</p> : <SafeMarkdown source={value(entity.document, "description_markdown")} />}</div>
    <div className="editor-actions"><button className="editor-trigger" onClick={() => { setTitle(value(entity.document, "title")); setStatus(entityStatus); setType(entityType); setDescription(value(entity.document, "description_markdown")); setMilestone(value(entity.document, "milestone")); setAssignees(values(entity.document, "assignees")); setStart(value(entity.document, "start")); setDue(value(entity.document, "due")); setEstimate(typeof entity.document.estimate_hours === "number" ? String(entity.document.estimate_hours) : ""); setEditor("edit"); }} type="button">{t("core.edit")}</button><button onClick={() => { setTargetProject(""); setTargetMilestone(""); setEditor("move"); }} type="button">{t("core.moveTask")}</button></div>
    <TaskComments api={api} confirmDelete={confirmCommentDelete} draft={draft} fingerprint={fingerprint} focusCommentId={focusedCommentId} locale={locale} onFingerprintChange={onCommentChanged} onNavigate={onNavigate} people={people} projectId={references.project.id} readOnly={readOnly} taskId={entity.document.id} />
    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditor(null)} open={editor === "edit"} title={`${t("core.edit")}: ${value(entity.document, "title")}`}><div className="editor-drawer-form"><label>{t("core.title")}<input disabled={readOnly} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>{t("core.status")}<select disabled={readOnly} value={status} onChange={(event) => setStatus(event.target.value)}>{statusOptions.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select></label><label>{t("core.type")}<select disabled={readOnly} value={type} onChange={(event) => setType(event.target.value)}>{typeOptions.map((item) => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select></label><label>{t("core.milestone")}<select disabled={readOnly} value={milestone} onChange={(event) => setMilestone(event.target.value)}><option value="">{t("core.noMilestone")}</option>{selectableMilestones.map((item) => <option key={item.document.id} value={item.document.id}>{value(item.document, "name")}{item.document.lifecycle === "archived" ? ` · ${t("core.archived")}` : ""}</option>)}</select></label><AssigneeChecks disabled={readOnly} onChange={setAssignees} people={selectablePeople} selected={assignees} t={t} /><label>{t("projectPlan.start")}<input disabled={readOnly} onChange={(event) => setStart(event.target.value)} type="date" value={start} /></label><label>{t("core.due")}<input disabled={readOnly} onChange={(event) => setDue(event.target.value)} type="date" value={due} /></label><label>{t("projectPlan.estimate")}<input disabled={readOnly} min="0" onChange={(event) => setEstimate(event.target.value)} step="0.25" type="number" value={estimate} /></label><label>{t("core.description")}<textarea disabled={readOnly} value={description} onChange={(event) => setDescription(event.target.value)} /></label><div className="editor-drawer-actions"><details className="more-actions"><summary>{t("core.moreActions")}</summary><div><button disabled={readOnly} onClick={() => { void save(async () => await api.archiveEntity(draft.draft_id, "tasks", entity, fingerprint)).then((result) => { if (result !== null) { setEditor(null); onDeleted(); } }); }} type="button">{t("core.archive")}</button><button className="danger" disabled={readOnly} onClick={() => { if (confirmDelete(value(entity.document, "title"))) void remove(async () => await api.deleteEntity(draft.draft_id, "tasks", entity, fingerprint)).then((success) => { if (success) { setEditor(null); onDeleted(); } }); }} type="button">{t("core.delete")}</button></div></details><button onClick={() => setEditor(null)} type="button">{t("core.cancel")}</button><button type="button" className="primary" disabled={readOnly || title.trim() === ""} onClick={() => { void save(async () => await api.updateEntity(draft.draft_id, "tasks", entity, fingerprint, { ...entity.document, title: title.trim(), status, type, assignees, description_markdown: description, milestone: milestone || undefined, start: start || undefined, due: due || undefined, estimate_hours: estimate === "" ? undefined : Number(estimate) })).then((result) => { if (result !== null) setEditor(null); }); }}>{t("core.save")}</button></div></div></EditorDrawer>
    <EditorDrawer closeLabel={t("core.closeEditor")} onClose={() => setEditor(null)} open={editor === "move"} title={t("core.moveTask")}><div className="editor-drawer-form move-task-editor"><p>{t("core.moveTaskDescription")}</p><label>{t("core.targetProject")}<select disabled={readOnly} value={targetProject} onChange={(event) => { setTargetProject(event.target.value); setTargetMilestone(""); }}><option value="">{t("core.selectTargetProject")}</option>{targetProjects.map((project) => <option key={project.document.id} value={project.document.id}>{value(project.document, "name")}</option>)}</select></label><label>{t("core.milestone")}<select disabled={readOnly || targetProject === ""} value={targetMilestone} onChange={(event) => setTargetMilestone(event.target.value)}><option value="">{t("core.noMilestone")}</option>{targetMilestones.map((item) => <option key={item.document.id} value={item.document.id}>{value(item.document, "name")}</option>)}</select></label><div className="editor-drawer-actions"><button onClick={() => setEditor(null)} type="button">{t("core.cancel")}</button><button className="primary" disabled={readOnly || targetProject === ""} onClick={() => { const project = targetProject; const nextMilestone = targetMilestone || undefined; void save(async () => await api.moveTask(draft.draft_id, entity, fingerprint, project, nextMilestone)).then((result) => { if (result !== null) { setEditor(null); onNavigate("tasks", { projectId: project, taskId: entity.document.id }); } }); }} type="button">{t("core.moveTaskAction")}</button></div></div></EditorDrawer>
  </section>;
}

export function AssigneeChecks({ people, selected, disabled, onChange, t }: {
  readonly people: readonly EntityResult[];
  readonly selected: readonly string[];
  readonly disabled: boolean;
  readonly onChange?: (next: string[]) => void;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const [internalSelected, setInternalSelected] = useState([...selected]);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const current = onChange === undefined ? internalSelected : selected;
  const update = (next: string[]) => onChange === undefined ? setInternalSelected(next) : onChange(next);
  const selectedPeople = current.map((id) => people.find((person) => person.document.id === id)).filter((person): person is EntityResult => person !== undefined);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = people.filter((person) => !current.includes(person.document.id) && (normalizedQuery === "" || `${value(person.document, "name")} ${value(person.document, "email")}`.toLocaleLowerCase().includes(normalizedQuery)));
  const availableCount = people.filter((person) => !current.includes(person.document.id)).length;
  return <fieldset className="assignee-fieldset"><legend>{t("core.assignees")}</legend>
    <div className="assignee-current">
      {selectedPeople.length === 0 ? <span className="empty-copy">{t("core.unassigned")}</span> : selectedPeople.map((person) => { const name = value(person.document, "name") || person.document.id; return <div className="assignee-row" key={person.document.id}><span>{name}</span><button aria-label={t("core.removeAssigneeLabel", { name })} disabled={disabled} onClick={() => update(current.filter((id) => id !== person.document.id))} type="button">{t("core.removeAssignee")}</button></div>; })}
    </div>
    {current.map((id) => <input key={id} name="assignees" type="hidden" value={id} />)}
    {!adding && <button className="assignee-add" disabled={disabled || availableCount === 0} onClick={() => { setAdding(true); setQuery(""); }} type="button">+ {t("core.addAssignee")}</button>}
    {adding && <div className="assignee-search-panel">
      <label>{t("core.assigneeSearch")}<input autoFocus onChange={(event) => setQuery(event.target.value)} type="search" value={query} /></label>
      {matches.length === 0 ? <span className="assignee-search-message">{t("core.assigneeNoMatches")}</span> : <div className="assignee-search-results">{matches.map((person) => <button key={person.document.id} onClick={() => { update([...current, person.document.id]); setAdding(false); setQuery(""); }} type="button"><span>{value(person.document, "name") || person.document.id}</span>{value(person.document, "email") !== "" && <small>{value(person.document, "email")}</small>}</button>)}</div>}
      <button onClick={() => { setAdding(false); setQuery(""); }} type="button">{t("core.cancel")}</button>
    </div>}
    {people.length === 0 && <span className="empty-copy">{t("core.noPeople")}</span>}
    <small className="assignee-hint">{t("core.assigneesHint")}</small>
  </fieldset>;
}
