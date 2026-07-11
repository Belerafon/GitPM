import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { GitPmApi } from "./api.js";
import { message, type Locale, type MessageKey } from "./i18n.js";
import type { DraftStatus, EntityResult, GitPmDocument } from "./types.js";
import { changedEntityFields, useExternalHighlights } from "./external-updates.js";

const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const value = (document: GitPmDocument, key: string) => typeof document[key] === "string" ? document[key] as string : "";
interface ConfigValue { readonly slug: string; readonly title: string; readonly active: boolean }
const configValues = (document: GitPmDocument, key: "statuses" | "issue_types"): ConfigValue[] => Array.isArray(document[key]) ? (document[key] as unknown[]).filter((item): item is ConfigValue => typeof item === "object" && item !== null && typeof (item as ConfigValue).slug === "string" && typeof (item as ConfigValue).title === "string" && (item as ConfigValue).active === true) : [];

export function newEntityId(prefix: "PRJ" | "MLS" | "TSK" | "CAL" | "PER" | "TEM" | "VIW", random: () => number = Math.random): string {
  let body = "";
  for (let index = 0; index < 26; index += 1) body += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)] ?? "0";
  return `${prefix}-${body}`;
}

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

export function CoreWorkspace({ api, draft, locale, onChanged }: {
  readonly api: GitPmApi;
  readonly draft: DraftStatus;
  readonly locale: Locale;
  readonly onChanged: () => Promise<void>;
}) {
  const t = (key: MessageKey) => message(locale, key);
  const [projects, setProjects] = useState<readonly EntityResult[]>([]);
  const [milestones, setMilestones] = useState<readonly EntityResult[]>([]);
  const [tasks, setTasks] = useState<readonly EntityResult[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [selectedTask, setSelectedTask] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [fingerprint, setFingerprint] = useState(draft.fingerprint);
  const [error, setError] = useState<string | null>(null);
  const [statusOptions, setStatusOptions] = useState<readonly ConfigValue[]>([]);
  const [typeOptions, setTypeOptions] = useState<readonly ConfigValue[]>([]);
  const previousEntities = useRef<readonly EntityResult[]>([]);
  const lastExternalFingerprint = useRef(draft.external_fingerprint);
  const { highlights, mark } = useExternalHighlights();
  const readOnly = draft.writer_mode !== "ui" || draft.state !== "open" || draft.changed_externally === true;

  const load = useCallback(async (preferredProject = projectId, externalUpdate = false) => {
    const [nextProjects, statusConfig, typeConfig] = await Promise.all([api.listEntities(draft.draft_id, "projects"), api.getConfiguration(draft.draft_id, "statuses"), api.getConfiguration(draft.draft_id, "issue-types")]);
    const nextProject = nextProjects.some((item) => item.document.id === preferredProject && item.document.lifecycle === "active") ? preferredProject : nextProjects.find((item) => item.document.lifecycle === "active")?.document.id || "";
    const [nextMilestones, nextTasks] = nextProject === "" ? [[], []] : await Promise.all([
      api.listEntities(draft.draft_id, "milestones", nextProject), api.listEntities(draft.draft_id, "tasks", nextProject),
    ]);
    const nextEntities = [...nextProjects, ...nextMilestones, ...nextTasks, statusConfig, typeConfig];
    if (externalUpdate) mark(changedEntityFields(previousEntities.current, nextEntities));
    previousEntities.current = nextEntities;
    setProjects(nextProjects); setProjectId(nextProject); setMilestones(nextMilestones); setTasks(nextTasks);
    setStatusOptions(configValues(statusConfig.document, "statuses")); setTypeOptions(configValues(typeConfig.document, "issue_types"));
    setFingerprint(nextProjects[0]?.draft_fingerprint ?? nextMilestones[0]?.draft_fingerprint ?? nextTasks[0]?.draft_fingerprint ?? draft.fingerprint);
  }, [api, draft.draft_id, draft.fingerprint, mark, projectId]);

  useEffect(() => { void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught))); }, [draft.draft_id]);
  useEffect(() => {
    if (draft.writer_mode !== "external" || draft.external_fingerprint === undefined || draft.external_fingerprint === lastExternalFingerprint.current) return;
    lastExternalFingerprint.current = draft.external_fingerprint;
    void load(projectId, true).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [draft.external_fingerprint]);

  const mutate = async (operation: () => Promise<EntityResult>, preferredProject = projectId) => {
    setError(null);
    try { const result = await operation(); setFingerprint(result.draft_fingerprint); await load(preferredProject); await onChanged(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  const remove = async (operation: () => Promise<void>) => {
    setError(null); try { await operation(); await load(); await onChanged(); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };

  const activeProjects = projects.filter((item) => item.document.lifecycle === "active");
  const activeMilestones = milestones.filter((item) => item.document.lifecycle === "active");
  const activeTasks = tasks.filter((item) => item.document.lifecycle === "active");
  const statuses = useMemo(() => [...new Set([...statusOptions.map((item) => item.slug), ...activeTasks.map((item) => value(item.document, "status"))])], [activeTasks, statusOptions]);
  const filteredTasks = activeTasks.filter((item) => filter === "" || value(item.document, "status") === filter);
  const task = tasks.find((item) => item.document.id === selectedTask);

  const createProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const id = newEntityId("PRJ");
    const document = { schema: "gitpm/project@1", id, name: String(data.get("name")), status: statusOptions[0]?.slug ?? "backlog", lifecycle: "active", description_markdown: String(data.get("description")) } as GitPmDocument;
    void mutate(async () => await api.createEntity(draft.draft_id, "projects", fingerprint, document), id); event.currentTarget.reset();
  };
  const createMilestone = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const document = { schema: "gitpm/milestone@1", id: newEntityId("MLS"), project: projectId, name: String(data.get("name")), lifecycle: "active", description_markdown: String(data.get("description")), ...(data.get("due") ? { due: String(data.get("due")) } : {}) } as GitPmDocument;
    void mutate(async () => await api.createEntity(draft.draft_id, "milestones", fingerprint, document)); event.currentTarget.reset();
  };
  const createTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const milestone = String(data.get("milestone"));
    const document = { schema: "gitpm/task@1", id: newEntityId("TSK"), project: projectId, title: String(data.get("title")), type: typeOptions[0]?.slug ?? "task", status: String(data.get("status")), lifecycle: "active", description_markdown: String(data.get("description")), ...(milestone ? { milestone } : {}) } as GitPmDocument;
    void mutate(async () => await api.createEntity(draft.draft_id, "tasks", fingerprint, document)); event.currentTarget.reset();
  };

  return <section className="core-workspace">
    <div className="section-heading"><div><span className="eyebrow">{draft.draft_id}</span><h2>{t("core.heading")}</h2></div></div>
    {readOnly && <div className="alert warning">{t("core.readOnly")}</div>}{error !== null && <div className="alert error">{error}</div>}
    <div className="core-columns">
      <section className="card entity-column"><h3>{t("core.projects")}</h3>
        <form onSubmit={createProject}><input name="name" aria-label={t("core.name")} placeholder={t("core.name")} required /><textarea name="description" aria-label={t("core.description")} placeholder={t("core.description")} /><button className="primary" disabled={readOnly}>{t("core.createProject")}</button></form>
        <div className="entity-list">{activeProjects.length === 0 ? <p>{t("core.empty")}</p> : activeProjects.map((project) => <EntityEditor api={api} key={`${project.document.id}:${project.blob_id}`} entity={project} entityType="projects" draft={draft} fingerprint={fingerprint} readOnly={readOnly} externalFields={highlights[project.document.id]} t={t} selected={projectId === project.document.id} select={() => { setProjectId(project.document.id); void load(project.document.id); }} save={mutate} remove={remove} />)}</div>
      </section>
      <section className="card entity-column"><h3>{t("core.milestones")}</h3>{projectId === "" ? <p>{t("core.selectProject")}</p> : <>
        <form onSubmit={createMilestone}><input name="name" aria-label={t("core.name")} placeholder={t("core.name")} required /><input name="due" type="date" aria-label={t("core.due")} /><textarea name="description" aria-label={t("core.description")} placeholder={t("core.description")} /><button className="primary" disabled={readOnly}>{t("core.createMilestone")}</button></form>
        <div className="entity-list">{activeMilestones.map((milestone) => <EntityEditor api={api} key={`${milestone.document.id}:${milestone.blob_id}`} entity={milestone} entityType="milestones" draft={draft} fingerprint={fingerprint} readOnly={readOnly} externalFields={highlights[milestone.document.id]} t={t} save={mutate} remove={remove} />)}</div>
      </>}</section>
    </div>
    {projectId !== "" && <section className="card task-area"><div className="task-toolbar"><h3>{t("core.tasks")}</h3><label>{t("core.filter")}<select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="">{t("core.allStatuses")}</option>{statuses.map((status) => <option key={status} value={status}>{status}</option>)}</select></label></div>
      <form className="task-create" onSubmit={createTask}><input name="title" aria-label={t("core.title")} placeholder={t("core.title")} required /><select name="status" aria-label={t("core.status")}>{statusOptions.map((status) => <option key={status.slug} value={status.slug}>{status.title}</option>)}</select><select name="milestone" aria-label={t("core.milestone")}><option value="">{t("core.noMilestone")}</option>{activeMilestones.map((milestone) => <option key={milestone.document.id} value={milestone.document.id}>{value(milestone.document, "name")}</option>)}</select><textarea name="description" aria-label={t("core.description")} placeholder={t("core.description")} /><button className="primary" disabled={readOnly}>{t("core.createTask")}</button></form>
      <div className="task-layout"><div className="task-table">{filteredTasks.length === 0 ? <p>{t("core.empty")}</p> : filteredTasks.map((item) => <div className={`task-row${highlights[item.document.id] ? " external-update" : ""}`} data-external-fields={highlights[item.document.id]?.join(",")} key={item.document.id}><button onClick={() => setSelectedTask(item.document.id)}><strong>{value(item.document, "title")}</strong><code>{item.document.id}</code></button><select aria-label={`${t("core.status")} ${value(item.document, "title")}`} disabled={readOnly} value={value(item.document, "status")} onChange={(event) => { void mutate(async () => await api.updateEntity(draft.draft_id, "tasks", item, fingerprint, { ...item.document, status: event.target.value })); }}>{statuses.map((status) => <option key={status}>{status}</option>)}</select><button disabled={readOnly} onClick={() => { void mutate(async () => await api.archiveEntity(draft.draft_id, "tasks", item, fingerprint)); if (selectedTask === item.document.id) setSelectedTask(""); }}>{t("core.archive")}</button></div>)}</div>
        {task !== undefined && <TaskPanel api={api} draft={draft} entity={task} fingerprint={fingerprint} milestones={activeMilestones} readOnly={readOnly} externalFields={highlights[task.document.id]} locale={locale} save={mutate} remove={remove} />}
      </div>
    </section>}
  </section>;
}

function EntityEditor({ api, entity, entityType, draft, fingerprint, readOnly, externalFields, t, selected = false, select, save, remove }: {
  readonly api: GitPmApi; readonly entity: EntityResult; readonly entityType: "projects" | "milestones"; readonly draft: DraftStatus; readonly fingerprint: string; readonly readOnly: boolean; readonly externalFields?: readonly string[]; readonly t: (key: MessageKey) => string; readonly selected?: boolean; readonly select?: () => void;
  readonly save: (operation: () => Promise<EntityResult>, preferredProject?: string) => Promise<void>; readonly remove: (operation: () => Promise<void>) => Promise<void>;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); const due = String(data.get("due") ?? ""); const document = { ...entity.document, name: String(data.get("name")), description_markdown: String(data.get("description")), ...(entityType === "milestones" ? (due ? { due } : { due: undefined }) : {}) }; void save(async () => await api.updateEntity(draft.draft_id, entityType, entity, fingerprint, document), entityType === "projects" ? entity.document.id : undefined); };
  return <form className={`entity-card${selected ? " selected" : ""}${externalFields ? " external-update" : ""}`} data-external-fields={externalFields?.join(",")} onSubmit={submit}>
    {select !== undefined && <button type="button" className="entity-select" onClick={select}><code>{entity.document.id}</code></button>}
    <input disabled={readOnly} name="name" aria-label={`${t("core.name")} ${value(entity.document, "name")}`} defaultValue={value(entity.document, "name")} required />
    {entityType === "milestones" && <input disabled={readOnly} name="due" type="date" aria-label={`${t("core.due")} ${value(entity.document, "name")}`} defaultValue={value(entity.document, "due")} />}
    <textarea disabled={readOnly} name="description" aria-label={`${t("core.description")} ${value(entity.document, "name")}`} defaultValue={value(entity.document, "description_markdown")} />
    <div><button className="primary" disabled={readOnly}>{t("core.save")}</button><button type="button" disabled={readOnly} onClick={() => { void save(async () => await api.archiveEntity(draft.draft_id, entityType, entity, fingerprint), entityType === "projects" ? "" : undefined); }}>{t("core.archive")}</button><button type="button" disabled={readOnly} onClick={() => { void remove(async () => await api.deleteEntity(draft.draft_id, entityType, entity, fingerprint)); }}>{t("core.delete")}</button></div>
  </form>;
}

function TaskPanel({ api, draft, entity, fingerprint, milestones, readOnly, externalFields, locale, save, remove }: { readonly api: GitPmApi; readonly draft: DraftStatus; readonly entity: EntityResult; readonly fingerprint: string; readonly milestones: readonly EntityResult[]; readonly readOnly: boolean; readonly externalFields?: readonly string[]; readonly locale: Locale; readonly save: (operation: () => Promise<EntityResult>) => Promise<void>; readonly remove: (operation: () => Promise<void>) => Promise<void> }) {
  const t = (key: MessageKey) => message(locale, key); const [description, setDescription] = useState(value(entity.document, "description_markdown")); const [milestone, setMilestone] = useState(value(entity.document, "milestone"));
  useEffect(() => { setDescription(value(entity.document, "description_markdown")); setMilestone(value(entity.document, "milestone")); }, [entity]);
  return <aside className={`task-panel${externalFields ? " external-update" : ""}`} data-external-fields={externalFields?.join(",")}><h3>{t("core.details")}</h3><strong>{value(entity.document, "title")}</strong><label>{t("core.description")}<textarea disabled={readOnly} value={description} onChange={(event) => setDescription(event.target.value)} /></label><label>{t("core.milestone")}<select disabled={readOnly} value={milestone} onChange={(event) => setMilestone(event.target.value)}><option value="">{t("core.noMilestone")}</option>{milestones.map((item) => <option key={item.document.id} value={item.document.id}>{value(item.document, "name")}</option>)}</select></label><button className="primary" disabled={readOnly} onClick={() => { void save(async () => await api.updateEntity(draft.draft_id, "tasks", entity, fingerprint, { ...entity.document, description_markdown: description, ...(milestone ? { milestone } : { milestone: undefined }) })); }}>{t("core.save")}</button><button className="danger" disabled={readOnly} onClick={() => { void remove(async () => await api.deleteEntity(draft.draft_id, "tasks", entity, fingerprint)); }}>{t("core.delete")}</button><h4>{t("core.safePreview")}</h4><SafeMarkdown source={description} /></aside>;
}
