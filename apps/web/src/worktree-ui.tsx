import { useEffect, useRef, useState } from "react";
import type { GitPmApi } from "./api.js";
import type { Locale, MessageKey } from "./i18n.js";
import { message } from "./i18n.js";
import type { DraftStatus, WorktreeEntry, WorktreeFile } from "./types.js";

function formatBytes(locale: Locale, bytes: number): string {
  if (bytes < 1024) return `${new Intl.NumberFormat(locale).format(bytes)} B`;
  if (bytes < 1024 * 1024) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024)} KiB`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} MiB`;
}

function DirectoryEntry({ api, draftId, entry, locale, onSelect, selectedPath }: {
  readonly api: GitPmApi;
  readonly draftId: string;
  readonly entry: WorktreeEntry;
  readonly locale: Locale;
  readonly onSelect: (path: string) => void;
  readonly selectedPath?: string;
}) {
  const t = (key: MessageKey) => message(locale, key);
  const [children, setChildren] = useState<readonly WorktreeEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (entry.type === "directory") return <details className="worktree-directory" onToggle={(event) => {
    if (!event.currentTarget.open || children !== null || loading) return;
    setLoading(true);
    setError(null);
    void api.listWorktree(draftId, entry.path)
      .then((result) => setChildren(result.entries))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false));
  }}>
    <summary><span aria-hidden="true" className="worktree-icon">▸</span>{entry.name}</summary>
    <div className="worktree-children">
      {loading && <span className="worktree-note">{t("status.loading")}</span>}
      {error !== null && <span className="worktree-note error">{error}</span>}
      {children?.length === 0 && <span className="worktree-note">{t("worktree.emptyDirectory")}</span>}
      {children?.map((child) => <DirectoryEntry api={api} draftId={draftId} entry={child} key={child.path} locale={locale} onSelect={onSelect} selectedPath={selectedPath} />)}
    </div>
  </details>;
  if (entry.type === "file") return <button className={`worktree-file${selectedPath === entry.path ? " selected" : ""}`} onClick={() => onSelect(entry.path)} title={entry.path}>
    <span aria-hidden="true" className="worktree-icon">·</span><span>{entry.name}</span>{entry.size !== undefined && <small>{formatBytes(locale, entry.size)}</small>}
  </button>;
  return <span className="worktree-unavailable" title={t(entry.type === "symlink" ? "worktree.symlinkUnavailable" : "worktree.entryUnavailable")}>
    <span aria-hidden="true" className="worktree-icon">×</span>{entry.name}
  </span>;
}

export function WorktreeWorkspace({ api, draft, locale }: { readonly api: GitPmApi; readonly draft: DraftStatus; readonly locale: Locale }) {
  const t = (key: MessageKey) => message(locale, key);
  const [entries, setEntries] = useState<readonly WorktreeEntry[] | null>(null);
  const [selected, setSelected] = useState<WorktreeFile | null>(null);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [treeError, setTreeError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const fileRequest = useRef(0);

  useEffect(() => {
    let current = true;
    setEntries(null);
    setTreeError(null);
    setSelectedPath(undefined);
    setSelected(null);
    setFileError(null);
    fileRequest.current += 1;
    void api.listWorktree(draft.draft_id)
      .then((result) => { if (current) setEntries(result.entries); })
      .catch((reason: unknown) => { if (current) setTreeError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { current = false; };
  }, [api, draft.draft_id, draft.fingerprint, draft.external_fingerprint]);

  const selectFile = (path: string) => {
    const request = ++fileRequest.current;
    setSelectedPath(path);
    setSelected(null);
    setFileError(null);
    setFileLoading(true);
    void api.readWorktreeFile(draft.draft_id, path)
      .then((result) => { if (request === fileRequest.current) setSelected(result); })
      .catch((reason: unknown) => { if (request === fileRequest.current) setFileError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (request === fileRequest.current) setFileLoading(false); });
  };

  return <section className="worktree-layout">
    <div className="worktree-browser card">
      <h2>{t("worktree.heading")}</h2>
      <p className="workspace-description">{t("worktree.description")}</p>
      <div className="worktree-root" role="region" aria-label={t("worktree.heading")}>
        {entries === null && treeError === null && <span className="worktree-note">{t("status.loading")}</span>}
        {treeError !== null && <span className="worktree-note error">{treeError}</span>}
        {entries?.length === 0 && <span className="worktree-note">{t("worktree.empty")}</span>}
        {entries?.map((entry) => <DirectoryEntry api={api} draftId={draft.draft_id} entry={entry} key={entry.path} locale={locale} onSelect={selectFile} selectedPath={selectedPath} />)}
      </div>
    </div>
    <div className="worktree-preview card">
      {selectedPath === undefined
        ? <div className="worktree-placeholder"><h2>{t("worktree.previewHeading")}</h2><p>{t("worktree.selectFile")}</p></div>
        : <>
          <header><div><span className="eyebrow">{t("worktree.previewHeading")}</span><h2>{selectedPath.split("/").at(-1)}</h2><code>{selectedPath}</code></div>{selected !== null && <span>{formatBytes(locale, selected.size)}</span>}</header>
          {fileLoading && <p>{t("status.loading")}</p>}
          {fileError !== null && <div className="alert error">{fileError}</div>}
          {selected !== null && <pre tabIndex={0}><code>{selected.content}</code></pre>}
        </>}
    </div>
  </section>;
}
