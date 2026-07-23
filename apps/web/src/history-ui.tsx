import { useEffect, useState, type FormEvent } from "react";
import type { GitPmApi } from "./api.js";
import { formatDateTime, message, type Locale } from "./i18n.js";
import type { CommitHistoryDetail, CommitHistoryItem, DraftStatus } from "./types.js";
import { AsyncBoundary, useAsyncLoad } from "./async-data.js";
import type { WorkspaceNavigate } from "./workspace-navigation.js";

interface DiffLine {
  readonly kind: "add" | "delete" | "context" | "hunk" | "meta";
  readonly oldNumber?: number;
  readonly newNumber?: number;
  readonly text: string;
}

function renderDiffLines(diff: string): readonly DiffLine[] {
  let oldNumber: number | undefined;
  let newNumber: number | undefined;
  return diff.replaceAll("\r\n", "\n").replace(/\n$/u, "").split("\n").map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk?.[1] !== undefined && hunk[2] !== undefined) {
      oldNumber = Number.parseInt(hunk[1], 10);
      newNumber = Number.parseInt(hunk[2], 10);
      return { kind: "hunk", text };
    }
    if (oldNumber === undefined || newNumber === undefined) return { kind: "meta", text };
    if (text.startsWith("+") && !text.startsWith("+++")) return { kind: "add", newNumber: newNumber++, text };
    if (text.startsWith("-") && !text.startsWith("---")) return { kind: "delete", oldNumber: oldNumber++, text };
    if (text.startsWith(" ")) return { kind: "context", oldNumber: oldNumber++, newNumber: newNumber++, text };
    return { kind: "meta", text };
  });
}

function FileDiff({ diff, oversized, loading, emptyLabel, tooLargeLabel, loadingLabel }: { readonly diff: string; readonly oversized: boolean; readonly loading: boolean; readonly emptyLabel: string; readonly tooLargeLabel: string; readonly loadingLabel: string }) {
  if (oversized) return <p className="diff-oversized">{tooLargeLabel}</p>;
  if (loading) return <div className="history-diff-empty">{loadingLabel}</div>;
  if (diff.trim() === "") return <div className="history-diff-empty">{emptyLabel}</div>;
  return <div className="history-diff-code" role="region" aria-live="polite">
    {renderDiffLines(diff).map((line, index) => <div className={`history-diff-line diff-line-${line.kind}`} key={`${index}:${line.text}`}>
      <span className="diff-old-number" aria-hidden="true">{line.oldNumber ?? ""}</span>
      <span className="diff-new-number" aria-hidden="true">{line.newNumber ?? ""}</span>
      <code>{line.text || " "}</code>
    </div>)}
  </div>;
}

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
  const [historyQuery, setHistoryQuery] = useState("");
  const [authorFilter, setAuthorFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [detail, setDetail] = useState<CommitHistoryDetail | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileDiffText, setFileDiffText] = useState<string>("");
  const [fileDiffOversized, setFileDiffOversized] = useState(false);
  const [fileDiffLoading, setFileDiffLoading] = useState(false);
  const [fileItems, setFileItems] = useState<readonly CommitHistoryItem[]>([]);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const [newDraftId, setNewDraftId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<readonly string[]>([]);
  const loadRequest = useAsyncLoad();

  const applyDetail = (next: CommitHistoryDetail | null) => {
    setDetail(next);
    setSelectedPath(next?.files[0]?.path ?? null);
    setNewDraftId(next === null ? "" : `REVERT-${next.commit.slice(0, 8).toUpperCase()}`);
  };
  const load = () => loadRequest.run(async () => {
    const history = await api.history(draft.draft_id);
    const selectedCommit = history.some((item) => item.commit === initialCommit) ? initialCommit : history[0]?.commit;
    const firstDetail = selectedCommit === undefined ? null : await api.commitDetail(draft.draft_id, selectedCommit);
    return { history, firstDetail };
  }, ({ history, firstDetail }) => { setItems(history); applyDetail(firstDetail); });
  useEffect(() => {
    applyDetail(null); setHistoryQuery(""); setAuthorFilter(""); setProjectFilter(""); setDateFilter(""); setFileItems([]); setFilePath(null); setFileQuery(""); setConflicts([]);
    void load();
  }, [api, draft.draft_id]);

  useEffect(() => {
    if (detail === null || selectedPath === null) { setFileDiffText(""); setFileDiffOversized(false); setFileDiffLoading(false); return; }
    let cancelled = false;
    const commit = detail.commit;
    const path = selectedPath;
    setFileDiffLoading(true); setFileDiffText(""); setFileDiffOversized(false); setError(null);
    void api.commitFileDiff(draft.draft_id, commit, path)
      .then((result) => { if (!cancelled) { setFileDiffText(result.diff); setFileDiffOversized(result.oversized); } })
      .catch((caught) => { if (!cancelled) report(caught); })
      .finally(() => { if (!cancelled) setFileDiffLoading(false); });
    return () => { cancelled = true; };
  }, [detail?.commit, selectedPath]);

  const report = (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught));
  const select = async (item: CommitHistoryItem) => {
    setError(null); setFileItems([]); setFilePath(null); setFileQuery("");
    try { const next = await api.commitDetail(draft.draft_id, item.commit); applyDetail(next); onNavigate("history", { commit: item.commit }); }
    catch (caught) { report(caught); }
  };
  const selectFile = async (path: string) => {
    setSelectedPath(path); setError(null); setFilePath(path); setFileItems([]);
    try { setFileItems(await api.fileHistory(draft.draft_id, path)); }
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
  const normalizedHistoryQuery = historyQuery.trim().toLocaleLowerCase(locale);
  const authors = [...new Set(items.map((item) => item.author_name))].sort((left, right) => left.localeCompare(right, locale));
  const projects = [...new Set(items.flatMap((item) => item.semantic_summary.affected_projects))].sort((left, right) => left.localeCompare(right, locale));
  const visibleItems = items.filter((item) => (normalizedHistoryQuery === "" || `${item.subject} ${item.author_name} ${item.commit}`.toLocaleLowerCase(locale).includes(normalizedHistoryQuery)) && (authorFilter === "" || item.author_name === authorFilter) && (projectFilter === "" || item.semantic_summary.affected_projects.includes(projectFilter)) && (dateFilter === "" || item.authored_at.slice(0, 10) === dateFilter));
  const selectedFile = detail?.files.find((file) => file.path === selectedPath);

  return <section className="history-workspace">
    <div className="section-heading"><span className="eyebrow">Git</span><h2 aria-hidden="true">{t("history.heading")}</h2><p>{t("history.description")}</p></div>
    {error !== null && <div className="alert error">{error}</div>}
    {conflicts.length > 0 && <div className="alert warning">{t("history.conflict", { count: conflicts.length })}</div>}
    <AsyncBoundary state={loadRequest.state} loading={t("status.loading")} retry={() => { void load(); }} error={(loadError, retry) => <div className="alert error">{loadError}<button onClick={retry}>{t("status.retry")}</button></div>}>
      <div className="history-chrome">
        <div className="history-toolbar">
          <label className="history-search"><span>{t("history.searchCommits")}</span><input type="search" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} /></label>
          <label><span>{t("history.authorFilter")}</span><select value={authorFilter} onChange={(event) => setAuthorFilter(event.target.value)}><option value="">{t("history.allAuthors")}</option>{authors.map((author) => <option key={author}>{author}</option>)}</select></label>
          <label><span>{t("history.projectFilter")}</span><select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="">{t("history.allProjects")}</option>{projects.map((project) => <option key={project}>{project}</option>)}</select></label>
          <label><span>{t("history.dateFilter")}</span><input type="date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} /></label>
        </div>
        <div className="history-log" aria-label={t("history.heading")}>
          <div className="history-log-head"><span aria-hidden="true" /><span>{t("history.message")}</span><span>{t("history.author")}</span><span>{t("history.date")}</span><span>{t("history.commit")}</span></div>
          <div className="history-log-body">
            {visibleItems.map((item) => <button key={item.commit} className={detail?.commit === item.commit ? "history-log-row selected" : "history-log-row"} onClick={() => { void select(item); }}>
              <span className="history-graph"><i /></span>
              <span className="history-subject"><strong>{item.subject}</strong>{item.semantic_summary.affected_projects.length > 0 && <small>{item.semantic_summary.affected_projects.join(", ")}</small>}</span>
              <span>{item.author_name}</span><time dateTime={item.authored_at}>{formatDateTime(locale, item.authored_at)}</time><code>{item.commit.slice(0, 8)}</code>
            </button>)}
            {items.length > 0 && visibleItems.length === 0 && <p className="filter-empty">{t("history.noMatches")}</p>}
          </div>
        </div>
        {detail === null ? <div className="history-empty">{t("history.empty")}</div> : <>
          <div className="history-commit-bar">
            <div><span className="eyebrow">{t("history.commit")}</span><h2>{detail.subject}</h2>{detail.body !== "" && <small>{detail.body}</small>}</div>
            <dl><div><dt>{t("history.author")}</dt><dd>{detail.author_name}</dd></div><div><dt>{t("history.date")}</dt><dd>{formatDateTime(locale, detail.authored_at)}</dd></div><div><dt>{t("history.projects")}</dt><dd>{detail.semantic_summary.affected_projects.join(", ") || "—"}</dd></div></dl>
          </div>
          <div className="history-inspector">
            <aside className="history-file-pane">
              <header><strong>{t("history.changedFiles", { count: detail.files.length })}</strong><code>{detail.commit.slice(0, 8)}</code></header>
              <label><span>{t("history.searchFiles")}</span><input type="search" value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} /></label>
              <div className="history-files">{visibleFiles.map((file) => <button key={file.path} className={selectedPath === file.path ? "selected" : ""} aria-pressed={selectedPath === file.path} onClick={() => { void selectFile(file.path); }}><span className="history-file-icon" aria-hidden="true">{file.status[0]}</span><code>{file.path}</code><span>+{file.additions ?? "—"} −{file.deletions ?? "—"}</span></button>)}</div>
              {filePath !== null && <div className="file-history"><h3>{t("history.fileHistory")}</h3><code title={filePath}>{filePath}</code>{fileItems.map((item) => <button key={item.commit} onClick={() => { void select(item); }}><span>{item.subject}</span><code>{item.commit.slice(0, 8)}</code></button>)}</div>}
            </aside>
            <section className="history-diff-pane" aria-label={t("history.diff")}>
              <header><div><span className="eyebrow">{t("history.diff")}</span><h3>{selectedPath ?? t("history.selectFile")}</h3></div>{selectedFile !== undefined && <span className="history-diff-stats"><b>+{selectedFile.additions ?? "—"}</b><b>−{selectedFile.deletions ?? "—"}</b></span>}</header>
              <FileDiff diff={fileDiffText} oversized={fileDiffOversized} loading={fileDiffLoading} emptyLabel={t(selectedPath === null ? "history.selectFile" : "history.noTextDiff")} tooLargeLabel={t("history.diffTooLarge")} loadingLabel={t("status.loading")} />
            </section>
          </div>
          {canRevert && <details className="history-actions"><summary>{t("history.revertActions")}</summary><form className="revert-form" onSubmit={submitRevert}><label>{t("history.revertDraft")}<input value={newDraftId} onChange={(event) => setNewDraftId(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9-]{0,127}" required /></label><button className="primary" disabled={busy}>{t("history.createRevert")}</button></form></details>}
        </>}
      </div>
    </AsyncBoundary>
  </section>;
}
