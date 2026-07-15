import { useEffect, useState, type FormEvent } from "react";
import type { GitPmApi } from "./api.js";
import { formatDateTime, message, type Locale } from "./i18n.js";
import type { CommitHistoryDetail, CommitHistoryItem, DraftStatus } from "./types.js";
import { AsyncBoundary, useAsyncLoad } from "./async-data.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";

export function HistoryWorkspace({ api, draft, locale, canRevert, initialCommit = "", onNavigate = () => undefined, onDraftCreated }: {
  readonly api: GitPmApi;
  readonly draft: DraftStatus;
  readonly locale: Locale;
  readonly canRevert: boolean;
  readonly initialCommit?: string;
  readonly onNavigate?: WorkspaceNavigate;
  readonly onDraftCreated: (draftId: string) => Promise<void>;
}) {
  const t = (key: Parameters<typeof message>[1], values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const [items, setItems] = useState<readonly CommitHistoryItem[]>([]);
  const [detail, setDetail] = useState<CommitHistoryDetail | null>(null);
  const [fileItems, setFileItems] = useState<readonly CommitHistoryItem[]>([]);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const [newDraftId, setNewDraftId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<readonly string[]>([]);
  const loadRequest = useAsyncLoad();

  const load = () => loadRequest.run(async () => {
    const history = await api.history(draft.draft_id);
    const selectedCommit = history.some((item) => item.commit === initialCommit) ? initialCommit : history[0]?.commit;
    const firstDetail = selectedCommit === undefined ? null : await api.commitDetail(draft.draft_id, selectedCommit);
    return { history, firstDetail };
  }, ({ history, firstDetail }) => {
    setItems(history); setDetail(firstDetail);
    setNewDraftId(firstDetail === null ? "" : `REVERT-${firstDetail.commit.slice(0, 8).toUpperCase()}`);
  });
  useEffect(() => {
    setDetail(null); setFileItems([]); setFilePath(null); setFileQuery(""); setConflicts([]);
    void load();
  }, [api, draft.draft_id]);

  const report = (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught));
  const select = async (item: CommitHistoryItem) => {
    setError(null); setFileItems([]); setFilePath(null); setFileQuery("");
    try { const next = await api.commitDetail(draft.draft_id, item.commit); setDetail(next); setNewDraftId(`REVERT-${item.commit.slice(0, 8).toUpperCase()}`); onNavigate("history", { commit: item.commit }); }
    catch (caught) { report(caught); }
  };
  const showFileHistory = async (path: string) => {
    setError(null);
    try { setFilePath(path); setFileItems(await api.fileHistory(draft.draft_id, path)); }
    catch (caught) { report(caught); }
  };
  const submitRevert = async (event: FormEvent) => {
    event.preventDefault();
    if (detail === null) return;
    setBusy(true); setError(null);
    try {
      const result = await api.createRevertDraft(draft.draft_id, detail.commit, newDraftId.trim());
      setConflicts(result.conflicted_files);
      await onDraftCreated(result.draft.draft_id);
    } catch (caught) { report(caught); }
    finally { setBusy(false); }
  };
  const visibleFiles = detail?.files.filter((file) => file.path.toLocaleLowerCase(locale).includes(fileQuery.trim().toLocaleLowerCase(locale))) ?? [];

  return <section className="history-workspace">
    <div className="section-heading"><span className="eyebrow">Git</span><h2>{t("history.heading")}</h2><p>{t("history.description")}</p></div>
    {error !== null && <div className="alert error">{error}</div>}
    {conflicts.length > 0 && <div className="alert warning">{t("history.conflict", { count: conflicts.length })}</div>}
    <AsyncBoundary state={loadRequest.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{loadError}<button onClick={retry}>{t("status.retry")}</button></div>}>
    <div className="history-layout">
      <div className="card history-list">
        {items.map((item) => <button key={item.commit} className={detail?.commit === item.commit ? "history-item selected" : "history-item"} onClick={() => { void select(item); }}>
          <strong>{item.subject}</strong><code>{item.commit.slice(0, 10)}</code><span>{item.author_name} · {formatDateTime(locale, item.authored_at)}</span>
        </button>)}
      </div>
      <div className="card history-detail">
        {detail === null ? <p>{t("history.empty")}</p> : <>
          <div className="detail-heading"><div><span className="eyebrow">{t("history.commit")}</span><h2>{detail.subject}</h2></div><code>{detail.commit.slice(0, 12)}</code></div>
          {detail.body !== "" && <p>{detail.body}</p>}
          <dl className="status-grid"><div><dt>{t("history.author")}</dt><dd>{detail.author_name} &lt;{detail.author_email}&gt;</dd></div><div><dt>{t("history.date")}</dt><dd>{formatDateTime(locale, detail.authored_at)}</dd></div><div><dt>{t("history.files")}</dt><dd>{detail.files.length}</dd></div><div><dt>{t("history.projects")}</dt><dd>{detail.semantic_summary.affected_projects.join(", ") || "—"}</dd></div></dl>
          <details className="history-file-section" open={detail.files.length <= 10 ? true : undefined}><summary>{t("history.changedFiles", { count: detail.files.length })}</summary><label>{t("history.searchFiles")}<input type="search" value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} /></label><div className="history-files">{visibleFiles.map((file) => <button key={file.path} onClick={() => { void showFileHistory(file.path); }}><code>{file.path}</code><span>+{file.additions ?? "—"} −{file.deletions ?? "—"}</span></button>)}</div></details>
          {filePath !== null && <div className="file-history"><h3>{t("history.fileHistory")}</h3><code>{filePath}</code>{fileItems.map((item) => <button key={item.commit} onClick={() => { void select(item); }}>{item.subject} · {item.commit.slice(0, 8)}</button>)}</div>}
          <details className="history-diff"><summary>{t("history.diff")}</summary><pre>{detail.diff}</pre></details>
          {canRevert && <form className="revert-form" onSubmit={submitRevert}><label>{t("history.revertDraft")}<input value={newDraftId} onChange={(event) => setNewDraftId(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9-]{0,127}" required /></label><button className="primary" disabled={busy}>{t("history.createRevert")}</button></form>}
        </>}
      </div>
    </div>
    </AsyncBoundary>
  </section>;
}
