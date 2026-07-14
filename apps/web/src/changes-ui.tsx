import { useEffect, useMemo, useState } from "react";
import type { GitPmApi } from "./api.js";
import { message, type Locale } from "./i18n.js";
import type { ChangesList, CommitResult, DraftStatus, FileChange, GitPmRole, MergeRequestStatus, SemanticChange, SemanticDiff } from "./types.js";
import { AsyncBoundary, useAsyncLoad } from "./async-data.js";

const emptyChanges: ChangesList = { files: [], changed_files_count: 0, affected_projects: [] };
const emptySemantic: SemanticDiff = {
  created: [], updated: [], archived: [], deleted: [],
  counts: { created: 0, updated: 0, archived: 0, deleted: 0 }, affected_projects: [], unclassified_files: [],
};

export function safeExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function valueText(value: unknown, empty: string): string {
  if (value === undefined) return empty;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function SemanticGroup({ title, items, empty }: { readonly title: string; readonly items: readonly SemanticChange[]; readonly empty: string }) {
  return <section className="semantic-group"><h4>{title}<span>{items.length}</span></h4>{items.map((item) => (
    <article className="semantic-item" key={`${title}-${item.path}`}>
      <strong>{item.id}</strong><code>{item.path}</code>
      {item.fields.length > 0 && <dl>{item.fields.map((field) => <div key={field.field}><dt>{field.field}</dt><dd><del>{valueText(field.before, empty)}</del><span aria-hidden="true">→</span><ins>{valueText(field.after, empty)}</ins></dd></div>)}</dl>}
    </article>
  ))}</section>;
}

function DiffViewer({ file, canRestore, busy, restoreFile, restoreHunk, labels }: {
  readonly file: FileChange;
  readonly canRestore: boolean;
  readonly busy: boolean;
  readonly restoreFile: () => void;
  readonly restoreHunk: (index: number) => void;
  readonly labels: { restoreFile: string; restoreHunk: string; kind: string };
}) {
  return <div className="diff-viewer">
    <div className="diff-heading"><div><span className={`change-kind kind-${file.kind.toLowerCase()}`}>{labels.kind}</span><code>{file.path}</code></div>
      {canRestore && file.kind !== "Added" && <button disabled={busy} onClick={restoreFile}>{labels.restoreFile}</button>}
    </div>
    {file.hunks.map((hunk, hunkIndex) => <section className="diff-hunk" key={`${file.diff_token}-${hunkIndex}`}>
      <div className="hunk-heading"><code>@@ -{hunk.old_start},{hunk.old_count} +{hunk.new_start},{hunk.new_count} @@</code>
        {canRestore && file.kind === "Modified" && <button disabled={busy} onClick={() => restoreHunk(hunkIndex)}>{labels.restoreHunk}</button>}
      </div>
      <pre>{hunk.lines.map((line, index) => <span className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-delete" : "diff-context"} key={index}>{line || " "}</span>)}</pre>
    </section>)}
    {file.hunks.length === 0 && <pre className="diff-raw">{file.diff}</pre>}
  </div>;
}

export function ChangesWorkspace({ api, draft, role, locale, onChanged, confirmAction, remoteAvailable = true, gitlabConfigured = true, gitlabSignedIn = true, onGitLabLogin = () => undefined }: {
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
  const loadRequest = useAsyncLoad();
  const canMutate = role !== "Reporter" && draft.state === "open" && draft.writer_mode === "ui";
  const selected = useMemo(() => changes.files.find((file) => file.path === selectedPath) ?? changes.files[0], [changes, selectedPath]);

  const load = async (keepData = false) => {
    await loadRequest.run(async () => {
      const [nextChanges, nextSemantic] = await Promise.all([api.listChanges(draft.draft_id), api.semanticChanges(draft.draft_id)]);
      return { nextChanges, nextSemantic };
    }, ({ nextChanges, nextSemantic }) => {
      setChanges(nextChanges); setSemantic(nextSemantic);
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
    <div className="section-heading"><span className="eyebrow draft-context-id">{draft.draft_id}</span><h2>{t("changes.heading")}</h2><p>{t("changes.description")}</p></div>
    {!canMutate && <div className="alert warning">{t("changes.readOnly")}</div>}
    {error !== null && <div className="alert error">{t("status.error", { message: error })}<button onClick={() => void load(true)}>{t("status.retry")}</button></div>}
    <AsyncBoundary state={loadRequest.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{t("status.error", { message: loadError })}<button onClick={retry}>{t("status.retry")}</button></div>}>
    <>
    <div className="changes-summary">
      <div><strong>{changes.changed_files_count}</strong><span>{t("changes.files")}</span></div>
      <div><strong>{semantic.counts.created}</strong><span>{t("changes.created")}</span></div>
      <div><strong>{semantic.counts.updated}</strong><span>{t("changes.updated")}</span></div>
      <div><strong>{semantic.counts.archived}</strong><span>{t("changes.archived")}</span></div>
      <div><strong>{semantic.counts.deleted}</strong><span>{t("changes.deleted")}</span></div>
    </div>
    <div className="changes-layout">
      <aside className="card change-files"><div className="change-files-heading"><h3>{t("changes.fileChanges")}</h3>{changes.files.length > 0 && canMutate && <button className="danger subtle" disabled={busy} onClick={() => { if (confirmAction(t("changes.discardConfirm"))) void run(() => api.discardAll(draft.draft_id, draft.fingerprint)); }}>{t("changes.discardAll")}</button>}</div>
        {changes.files.length === 0 ? <p>{t("changes.clean")}</p> : changes.files.map((file) => <button className={selected?.path === file.path ? "change-file selected" : "change-file"} key={file.path} onClick={() => setSelectedPath(file.path)}><span className={`change-dot kind-${file.kind.toLowerCase()}`} /><span><strong>{t(`changes.kind${file.kind}`)}</strong><code>{file.path}</code></span></button>)}
      </aside>
      <div className="card change-detail">{selected === undefined ? <div className="empty-change"><strong>{t("changes.clean")}</strong><span>{t("changes.cleanHint")}</span></div> : <DiffViewer file={selected} canRestore={canMutate} busy={busy} restoreFile={() => void run(() => api.restoreFile(draft.draft_id, draft.fingerprint, selected.path))} restoreHunk={(index) => void run(() => api.restoreHunk(draft.draft_id, draft.fingerprint, selected.path, selected.diff_token, index))} labels={{ restoreFile: t("changes.restoreFile"), restoreHunk: t("changes.restoreHunk"), kind: t(`changes.kind${selected.kind}`) }} />}</div>
    </div>
    <div className="card semantic-diff"><div className="semantic-heading"><div><span className="eyebrow">{t("changes.semanticEyebrow")}</span><h3>{t("changes.semanticHeading")}</h3></div><span>{t("changes.projects", { count: semantic.affected_projects.length })}</span></div>
      <div className="semantic-grid"><SemanticGroup title={t("changes.created")} items={semantic.created} empty={t("changes.emptyValue")} /><SemanticGroup title={t("changes.updated")} items={semantic.updated} empty={t("changes.emptyValue")} /><SemanticGroup title={t("changes.archived")} items={semantic.archived} empty={t("changes.emptyValue")} /><SemanticGroup title={t("changes.deleted")} items={semantic.deleted} empty={t("changes.emptyValue")} /></div>
      {semantic.unclassified_files.length > 0 && <p className="unclassified">{t("changes.unclassified", { count: semantic.unclassified_files.length })}</p>}
    </div>
    <div className="card publish-panel"><div><span className="eyebrow">{t("changes.publishEyebrow")}</span><h3>{t("changes.publishHeading")}</h3><p>{t("changes.commitAllHint")}</p></div>
      {commit === undefined ? <button className="primary" disabled={!canMutate || busy || changes.changed_files_count === 0} onClick={() => setCommitOpen(true)}>{t("changes.openCommit")}</button> : <div className="publish-flow">
        <div className="publish-step complete"><span>1</span><div><strong>{t("changes.committed")}</strong><code>{commit.commit.slice(0, 12)}</code></div></div>
        {!remoteAvailable ? <span>{t("changes.localOnly")}</span> : !gitlabConfigured ? <span>{t("changes.gitlabNotConfigured")}</span> : !gitlabSignedIn ? <button className="primary" onClick={onGitLabLogin}>{t("changes.loginForPush")}</button> : !pushed ? <button className="primary" disabled={busy} onClick={() => void push()}>{t("changes.push")}</button> : mergeRequest === undefined ? <div className="mr-form"><label>{t("changes.mrTitle")}<input value={mrTitle} onChange={(event) => setMrTitle(event.target.value)} /></label><label>{t("changes.mrDescription")}<textarea value={mrDescription} onChange={(event) => setMrDescription(event.target.value)} /></label><button className="primary" disabled={busy || !mrTitle.trim()} onClick={() => void createMr()}>{t("changes.createMr")}</button></div> : safeExternalUrl(mergeRequest.web_url) === undefined
          ? <span className="mr-result">{t("changes.mrReady", { iid: mergeRequest.iid, state: mergeRequest.state })}</span>
          : <a className="mr-result" href={safeExternalUrl(mergeRequest.web_url)} target="_blank" rel="noreferrer">{t("changes.mrReady", { iid: mergeRequest.iid, state: mergeRequest.state })}</a>}
      </div>}
    </div>
    <p className="alpha-limitations">{t("changes.alphaLimitations")}</p>
    {commitOpen && <div className="modal-backdrop" role="presentation"><section className="commit-dialog" role="dialog" aria-modal="true" aria-labelledby="commit-heading"><h3 id="commit-heading">{t("changes.commitHeading")}</h3><p>{t("changes.commitScope", { count: changes.changed_files_count })}</p><label>{t("changes.commitMessage")}<input autoFocus maxLength={500} value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} /></label><div className="actions"><button onClick={() => setCommitOpen(false)}>{t("changes.cancel")}</button><button className="primary" disabled={busy || !commitMessage.trim()} onClick={() => void commitEverything()}>{t("changes.commitAll")}</button></div></section></div>}
    </>
    </AsyncBoundary>
  </section>;
}
