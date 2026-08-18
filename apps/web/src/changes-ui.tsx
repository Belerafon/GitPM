import { useEffect, useMemo, useState } from "react";
import type { GitPmApi } from "./api.js";
import { message, type Locale, type MessageKey } from "./i18n.js";
import { ProjectLink } from "./project-link.js";
import type { ChangesList, CommitResult, DraftStatus, FileChange, GitPmRole, MergeRequestStatus, ProjectFileChange, SemanticChange, SemanticDiff, SemanticFileEntity } from "./types.js";
import { AsyncBoundary, useAsyncLoad } from "./async-data.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";

const emptyChanges: ChangesList = { files: [], changed_files_count: 0, affected_projects: [], project_files: [] };
const emptySemantic: SemanticDiff = {
  created: [], updated: [], archived: [], deleted: [],
  counts: { created: 0, updated: 0, archived: 0, deleted: 0 }, affected_projects: [], file_entities: [], unclassified_files: [],
};

const entityTypeKeys: Readonly<Record<string, MessageKey>> = {
  "gitpm/project@2": "changes.entityProject",
  "gitpm/task@2": "changes.entityTask",
  "gitpm/milestone@2": "changes.entityMilestone",
  "gitpm/person@1": "changes.entityPerson",
  "gitpm/team@1": "changes.entityTeam",
  "gitpm/calendar@1": "changes.entityCalendar",
  "gitpm/availability-event@1": "changes.entityAvailability",
  "gitpm/saved-view@1": "changes.entityView",
  "gitpm/comment@1": "changes.entityComment",
  "gitpm/repository@1": "changes.entityRepository",
  "gitpm/statuses@2": "changes.entityStatuses",
  "gitpm/issue-types@1": "changes.entityIssueTypes",
};

const fieldKeys: Readonly<Record<string, MessageKey>> = {
  archived_at: "changes.fieldArchivedAt",
  assignees: "changes.fieldAssignees",
  calendar: "changes.fieldCalendar",
  dependencies: "changes.fieldDependencies",
  description: "changes.fieldDescription",
  due: "changes.fieldDue",
  email: "changes.fieldEmail",
  estimate_hours: "changes.fieldEstimate",
  issue_type: "changes.fieldIssueType",
  lifecycle: "changes.fieldLifecycle",
  members: "changes.fieldMembers",
  milestone: "changes.fieldMilestone",
  name: "changes.fieldName",
  owner: "changes.fieldOwner",
  parent: "changes.fieldParent",
  project: "changes.fieldProject",
  start: "changes.fieldStart",
  status: "changes.fieldStatus",
  title: "changes.fieldTitle",
  weekly_capacity_hours: "changes.fieldCapacity",
};

const projectFileOperationKeys: Readonly<Record<ProjectFileChange["operation"], MessageKey>> = {
  Added: "changes.projectFileAdded",
  Modified: "changes.projectFileModified",
  Replaced: "changes.projectFileReplaced",
  Renamed: "changes.projectFileRenamed",
  Deleted: "changes.projectFileDeleted",
};

export function safeExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === ""
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function valueText(value: unknown, empty: string, namesById: ReadonlyMap<string, string>): string {
  if (value === undefined) return empty;
  if (typeof value === "string") {
    const name = namesById.get(value);
    return name === undefined ? value : `${name} (${value})`;
  }
  if (Array.isArray(value)) return value.map((item) => valueText(item, empty, namesById)).join(", ");
  return JSON.stringify(value);
}

function fieldLabel(field: string, t: (key: MessageKey) => string): string {
  return field.split(".").map((segment) => {
    const key = fieldKeys[segment];
    if (key !== undefined) return t(key);
    const words = segment.replaceAll("_", " ");
    return `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}`;
  }).join(" › ");
}

function entityType(schema: string, t: (key: MessageKey) => string): string {
  const key = entityTypeKeys[schema];
  return key === undefined ? schema.replace(/^gitpm\//u, "").replace(/@.*$/u, "") : t(key);
}

function ChangeFileButton({ file, entity, selected, select, t }: {
  readonly file: FileChange;
  readonly entity?: SemanticFileEntity;
  readonly selected: boolean;
  readonly select: () => void;
  readonly t: (key: MessageKey) => string;
}) {
  const name = entity?.display_name ?? entity?.id;
  return <button className={selected ? "change-file selected" : "change-file"} onClick={select}>
    <span className={`change-dot kind-${file.kind.toLowerCase()}`} />
    <span className="change-file-body">
      {entity !== undefined && <span className="change-file-entity"><span>{entityType(entity.schema, t)}</span>{name !== undefined && <strong>{name}</strong>}</span>}
      <span className="change-file-meta"><strong>{t(`changes.kind${file.kind}`)}</strong><code>{file.path}</code></span>
    </span>
  </button>;
}

function SemanticGroup({ title, items, entitiesByPath, namesById, empty, fieldCount, t }: {
  readonly title: string;
  readonly items: readonly SemanticChange[];
  readonly entitiesByPath: ReadonlyMap<string, SemanticFileEntity>;
  readonly namesById: ReadonlyMap<string, string>;
  readonly empty: string;
  readonly fieldCount: (count: number) => string;
  readonly t: (key: MessageKey) => string;
}) {
  if (items.length === 0) return null;
  return <section className="semantic-group"><h4>{title}<span>{items.length}</span></h4><div className="semantic-items">{items.map((item) => {
    const entity = entitiesByPath.get(item.path);
    const name = entity?.display_name ?? entity?.id ?? item.id;
    return <details className="semantic-item" key={`${title}-${item.path}`}>
      <summary>
        <span className="semantic-identity"><span>{entityType(item.schema, t)}</span><strong>{name}</strong><code>{item.id}</code></span>
        <span className="semantic-field-count">{fieldCount(item.fields.length)}</span>
      </summary>
      {item.fields.length > 0 && <dl>{item.fields.map((field) => <div key={field.field}><dt>{fieldLabel(field.field, t)}</dt><dd><del>{valueText(field.before, empty, namesById)}</del><span aria-hidden="true">→</span><ins>{valueText(field.after, empty, namesById)}</ins></dd></div>)}</dl>}
    </details>;
  })}</div></section>;
}

function projectDisplayName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function ProjectFileGroups({ items, namesById, onOpenProject, select, t }: {
  readonly items: readonly ProjectFileChange[];
  readonly namesById: ReadonlyMap<string, string>;
  readonly onOpenProject?: (projectId: string) => void;
  readonly select: (path: string) => void;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const groups = new Map<string, ProjectFileChange[]>();
  for (const item of items) groups.set(item.project_id, [...(groups.get(item.project_id) ?? []), item]);
  if (groups.size === 0) return null;
  return <section className="card project-file-changes" aria-labelledby="project-file-changes-heading">
    <div className="semantic-heading"><div><span className="eyebrow">{t("changes.projectFilesEyebrow")}</span><h3 id="project-file-changes-heading">{t("changes.projectFilesHeading")}</h3><p>{t("changes.projectFilesHint")}</p></div><span>{items.length}</span></div>
    <div className="project-file-change-groups">{[...groups].map(([projectId, projectItems]) => {
      const name = namesById.get(projectId) ?? projectId;
      return <section key={projectId}>
        <h4><span className="project-file-group-kind">{t("changes.entityProject")}</span><ProjectLink name={name} onOpen={onOpenProject} projectId={projectId} />{name !== projectId && <code>{projectId}</code>}</h4>
        <ul>{projectItems.map((item) => <li key={`${item.operation}:${item.path}`}>
          <button type="button" onClick={() => select(item.path)}>
            <span className={`project-file-operation operation-${item.operation.toLowerCase()}`}>{t(projectFileOperationKeys[item.operation])}</span>
            <strong>{item.previous_name === undefined ? item.name : `${item.previous_name} → ${item.name}`}</strong>
            <small>{item.content_kind === "text" ? t("changes.projectFileTextDiff") : item.content_kind === "binary" ? t("changes.projectFileBinary") : t("changes.projectFileUnknown")}</small>
          </button>
        </li>)}</ul>
      </section>;
    })}</div>
  </section>;
}

function DiffViewer({ file, canRestore, busy, restoreFile, restoreHunk, labels }: {
  readonly file: FileChange;
  readonly canRestore: boolean;
  readonly busy: boolean;
  readonly restoreFile: () => void;
  readonly restoreHunk: (index: number) => void;
  readonly labels: { restoreFile: string; restoreHunk: string; kind: string; tooLarge: string };
}) {
  return <div className="diff-viewer">
    <div className="diff-heading"><div><span className={`change-kind kind-${file.kind.toLowerCase()}`}>{labels.kind}</span><code>{file.path}</code></div>
      {canRestore && file.kind !== "Added" && <button disabled={busy} onClick={restoreFile}>{labels.restoreFile}</button>}
    </div>
    {file.oversized
      ? <p className="diff-oversized">{labels.tooLarge}</p>
      : <>
        {file.hunks.map((hunk, hunkIndex) => <section className="diff-hunk" key={`${file.diff_token}-${hunkIndex}`}>
          <div className="hunk-heading"><code>@@ -{hunk.old_start},{hunk.old_count} +{hunk.new_start},{hunk.new_count} @@</code>
            {canRestore && file.kind === "Modified" && <button disabled={busy} onClick={() => restoreHunk(hunkIndex)}>{labels.restoreHunk}</button>}
          </div>
          <pre>{hunk.lines.map((line, index) => <span className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-delete" : "diff-context"} key={index}>{line || " "}</span>)}</pre>
        </section>)}
        {file.hunks.length === 0 && <pre className="diff-raw">{file.diff}</pre>}
      </>}
  </div>;
}

export function ChangesWorkspace({ api, draft, role, locale, onChanged, confirmAction, remoteAvailable = true, gitlabConfigured = true, gitlabSignedIn = true, onGitLabLogin = () => undefined, onNavigate, directMode = false }: {
  readonly api: GitPmApi;
  readonly draft: DraftStatus;
  readonly role: GitPmRole;
  readonly locale: Locale;
  readonly onChanged: () => Promise<void>;
  readonly confirmAction: (message: string) => boolean;
  readonly remoteAvailable?: boolean;
  readonly gitlabConfigured?: boolean;
  readonly gitlabSignedIn?: boolean;
  readonly onGitLabLogin?: () => void;
  readonly onNavigate?: WorkspaceNavigate;
  readonly directMode?: boolean;
}) {
  const t = (key: Parameters<typeof message>[1], values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [changes, setChanges] = useState<ChangesList>(emptyChanges);
  const [semantic, setSemantic] = useState<SemanticDiff>(emptySemantic);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [commit, setCommit] = useState<CommitResult>();
  const [pushed, setPushed] = useState(false);
  const [mrTitle, setMrTitle] = useState("");
  const [mrDescription, setMrDescription] = useState("");
  const [mergeRequest, setMergeRequest] = useState<MergeRequestStatus>();
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const loadRequest = useAsyncLoad();
  const canMutate = role !== "Reporter" && draft.state === "open" && draft.writer_mode === "ui";
  const selected = useMemo(() => changes.files.find((file) => file.path === selectedPath) ?? changes.files[0], [changes, selectedPath]);
  const entitiesByPath = useMemo(() => new Map((semantic.file_entities ?? []).map((entity) => [entity.path, entity])), [semantic.file_entities]);
  const namesById = useMemo(() => new Map((semantic.file_entities ?? []).flatMap((entity) => entity.id === undefined || entity.display_name === undefined ? [] : [[entity.id, entity.display_name] as const])), [semantic.file_entities]);
  const [projectNames, setProjectNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  const projectGroupNames = useMemo(() => {
    const merged = new Map(projectNames);
    for (const [id, name] of namesById) merged.set(id, name);
    return merged;
  }, [namesById, projectNames]);
  const changedEntitiesCount = semantic.counts.created + semantic.counts.updated + semantic.counts.archived + semantic.counts.deleted;

  const load = async (keepData = true) => {
    await loadRequest.run(async () => {
      const [nextChanges, nextSemantic] = await Promise.all([api.listChanges(draft.draft_id), api.semanticChanges(draft.draft_id)]);
      const projectIds = [...new Set(nextChanges.project_files.map((item) => item.project_id))];
      let nextProjectNames: ReadonlyArray<readonly [string, string]> = [];
      if (projectIds.length > 0) {
        try {
          nextProjectNames = (await api.listEntities(draft.draft_id, "projects")).flatMap((project) => {
            const name = projectDisplayName(project.document.name);
            return name === "" ? [] : [[project.document.id, name] as const];
          });
        } catch {
          nextProjectNames = [];
        }
      }
      return { nextChanges, nextSemantic, nextProjectNames };
    }, ({ nextChanges, nextSemantic, nextProjectNames }) => {
      setChanges(nextChanges); setSemantic(nextSemantic); setProjectNames(new Map(nextProjectNames));
      setSelectedPath((current) => nextChanges.files.some((file) => file.path === current) ? current : nextChanges.files[0]?.path);
    }, { keepData });
  };
  useEffect(() => { setError(null); void load(); }, [draft.draft_id, draft.fingerprint, draft.external_fingerprint]);
  useEffect(() => {
    if (mergeRequest === undefined) return;
    const timer = window.setInterval(() => { void api.pollMergeRequest(draft.draft_id).then(setMergeRequest).catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [api, draft.draft_id, mergeRequest?.iid]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await operation(); await onChanged(); await load(true); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const commitEverything = async () => {
    setBusy(true); setError(null);
    try {
      const result = await api.commitAll(draft.draft_id, commitMessage.trim());
      setCommit(result); setCommitOpen(false); setMrTitle(commitMessage.trim()); await onChanged(); await load(true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const push = async () => {
    setBusy(true); setError(null);
    try { await api.push(draft.draft_id); setPushed(true); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const createMr = async () => {
    setBusy(true); setError(null);
    try { const result = await api.createMergeRequest(draft.draft_id, mrTitle.trim(), mrDescription.trim()); setMergeRequest(result); await onChanged(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  return <section className="changes-workspace">
    <div className="section-heading"><span className="eyebrow draft-context-id">{draft.draft_id}</span><h2 aria-hidden="true">{t("changes.heading")}</h2><p>{t("changes.description")}</p></div>
    {!canMutate && <div className="alert warning">{t("changes.readOnly")}</div>}
    {error !== null && <div className="alert error">{t("status.error", { message: error })}<button onClick={() => void load(true)}>{t("status.retry")}</button></div>}
    <AsyncBoundary state={loadRequest.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{t("status.error", { message: loadError })}<button onClick={retry}>{t("status.retry")}</button></div>}>
    <>
    <div className="changes-summary">
      <div><strong>{changedEntitiesCount}</strong><span>{t("changes.entities")}</span></div>
      <div><strong>{changes.changed_files_count}</strong><span>{t("changes.files")}</span></div>
      <div><strong>{semantic.affected_projects.length}</strong><span>{t("changes.projectsShort")}</span></div>
    </div>
    <div className="card semantic-diff"><div className="semantic-heading"><div><span className="eyebrow">{t("changes.semanticEyebrow")}</span><h3>{t("changes.semanticHeading")}</h3><p>{t("changes.semanticHint")}</p></div><span>{t("changes.projects", { count: semantic.affected_projects.length })}</span></div>
      <div className="semantic-groups">
        <SemanticGroup title={t("changes.created")} items={semantic.created} entitiesByPath={entitiesByPath} namesById={namesById} empty={t("changes.emptyValue")} fieldCount={(count) => t("changes.fieldCount", { count })} t={t} />
        <SemanticGroup title={t("changes.updated")} items={semantic.updated} entitiesByPath={entitiesByPath} namesById={namesById} empty={t("changes.emptyValue")} fieldCount={(count) => t("changes.fieldCount", { count })} t={t} />
        <SemanticGroup title={t("changes.archived")} items={semantic.archived} entitiesByPath={entitiesByPath} namesById={namesById} empty={t("changes.emptyValue")} fieldCount={(count) => t("changes.fieldCount", { count })} t={t} />
        <SemanticGroup title={t("changes.deleted")} items={semantic.deleted} entitiesByPath={entitiesByPath} namesById={namesById} empty={t("changes.emptyValue")} fieldCount={(count) => t("changes.fieldCount", { count })} t={t} />
      </div>
      {semantic.unclassified_files.length > 0 && <p className="unclassified">{t("changes.unclassified", { count: semantic.unclassified_files.length })}</p>}
    </div>
    <ProjectFileGroups items={changes.project_files} namesById={projectGroupNames} onOpenProject={onNavigate === undefined ? undefined : (projectId) => onNavigate("projects", { projectId })} select={(path) => { setSelectedPath(path); setTechnicalOpen(true); }} t={t} />
    <details className="technical-changes" open={technicalOpen} onToggle={(event) => setTechnicalOpen(event.currentTarget.open)}><summary><span><strong>{t("changes.fileChanges")}</strong><small>{t("changes.fileChangesHint")}</small></span><span>{changes.changed_files_count}</span></summary>
      <div className={`changes-layout${changes.files.length === 0 ? " clean" : ""}`}>
        <aside className="card change-files"><div className="change-files-heading"><h3>{t("changes.changedFiles")}</h3>{changes.files.length > 0 && canMutate && <button className="danger subtle" disabled={busy} onClick={() => { if (confirmAction(t("changes.discardConfirm"))) void run(() => api.discardAll(draft.draft_id, draft.fingerprint)); }}>{t("changes.discardAll")}</button>}</div>
          {changes.files.length === 0 ? <p>{t("changes.clean")}</p> : changes.files.map((file) => <ChangeFileButton entity={entitiesByPath.get(file.path)} file={file} key={file.path} select={() => setSelectedPath(file.path)} selected={selected?.path === file.path} t={t} />)}
        </aside>
        <div className="card change-detail">{selected === undefined ? <div className="empty-change"><strong>{t("changes.clean")}</strong><span>{t("changes.cleanHint")}</span></div> : <DiffViewer file={selected} canRestore={canMutate} busy={busy} restoreFile={() => void run(() => api.restoreFile(draft.draft_id, draft.fingerprint, selected.path))} restoreHunk={(index) => void run(() => api.restoreHunk(draft.draft_id, draft.fingerprint, selected.path, selected.diff_token, index))} labels={{ restoreFile: t("changes.restoreFile"), restoreHunk: t("changes.restoreHunk"), kind: t(`changes.kind${selected.kind}`), tooLarge: t("changes.diffTooLarge") }} />}</div>
      </div>
    </details>
    <div className="card publish-panel"><div><span className="eyebrow">{t("changes.publishEyebrow")}</span><h3>{t("changes.publishHeading")}</h3><p>{t("changes.commitAllHint")}</p></div>
      {commit === undefined ? <div className="publish-action"><button className="primary" disabled={!canMutate || busy || changes.changed_files_count === 0} onClick={() => setCommitOpen(true)}>{t("changes.openCommit")}</button>{changes.changed_files_count === 0 && <span>{t("changes.cleanHint")}</span>}</div> : <div className="publish-flow">
        <div className="publish-step complete"><span>1</span><div><strong>{t("changes.committed")}</strong><code>{commit.commit.slice(0, 12)}</code></div></div>
        {!remoteAvailable ? <span>{t("changes.localOnly")}</span> : !gitlabConfigured ? <span>{t("changes.gitlabNotConfigured")}</span> : !gitlabSignedIn ? <button className="primary" onClick={onGitLabLogin}>{t("changes.loginForPush")}</button> : !pushed ? <button className="primary" disabled={busy} onClick={() => void push()}>{t("changes.push")}</button> : directMode ? <span className="mr-result">{t("changes.pushed", { branch: draft.branch })}</span> : mergeRequest === undefined ? <div className="mr-form"><label>{t("changes.mrTitle")}<input maxLength={255} value={mrTitle} onChange={(event) => setMrTitle(event.target.value)} /></label><label>{t("changes.mrDescription")}<textarea value={mrDescription} onChange={(event) => setMrDescription(event.target.value)} /></label><button className="primary" disabled={busy || !mrTitle.trim()} onClick={() => void createMr()}>{t("changes.createMr")}</button></div> : safeExternalUrl(mergeRequest.web_url) === undefined
          ? <span className="mr-result">{t("changes.mrReady", { iid: mergeRequest.iid, state: mergeRequest.state })}</span>
          : <a className="mr-result" href={safeExternalUrl(mergeRequest.web_url)} target="_blank" rel="noreferrer">{t("changes.mrReady", { iid: mergeRequest.iid, state: mergeRequest.state })}</a>}
      </div>}
    </div>
    <details className="repository-rules"><summary>{t("changes.repositoryRules")}</summary><p>{t("changes.alphaLimitations")}</p></details>
    {commitOpen && <div className="modal-backdrop" role="presentation"><section className="commit-dialog" role="dialog" aria-modal="true" aria-labelledby="commit-heading"><h3 id="commit-heading">{t("changes.commitHeading")}</h3><p>{t("changes.commitScope", { count: changes.changed_files_count })}</p><label>{t("changes.commitMessage")}<input autoFocus maxLength={500} value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} /></label><div className="actions"><button onClick={() => setCommitOpen(false)}>{t("changes.cancel")}</button><button className="primary" disabled={busy || !commitMessage.trim()} onClick={() => void commitEverything()}>{t("changes.commitAll")}</button></div></section></div>}
    </>
    </AsyncBoundary>
  </section>;
}
