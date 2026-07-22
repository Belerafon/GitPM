import { useEffect, useMemo, useRef, useState } from "react";
import type { GitPmApi } from "./api.js";
import type { Locale, MessageKey } from "./i18n.js";
import { message } from "./i18n.js";
import type { DraftStatus, GitPmRole, WorktreeEntry, WorktreeFile } from "./types.js";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function formatBytes(locale: Locale, bytes: number): string {
  if (bytes < 1024) return `${new Intl.NumberFormat(locale).format(bytes)} B`;
  if (bytes < 1024 * 1024) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024)} KiB`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} MiB`;
}

function joinPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

function parentOf(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? "" : relativePath.slice(0, index);
}

function baseName(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? relativePath : relativePath.slice(index + 1);
}

function crumbs(relativePath: string): readonly { readonly name: string; readonly path: string }[] {
  if (relativePath === "") return [];
  const segments = relativePath.split("/");
  let cumulative = "";
  return segments.map((segment) => {
    cumulative = cumulative === "" ? segment : `${cumulative}/${segment}`;
    return { name: segment, path: cumulative };
  });
}

const RESERVED_SEGMENT = /^(\.|\.\.|\.git)$/iu;
function isValidName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 255) return false;
  if (RESERVED_SEGMENT.test(trimmed)) return false;
  return !/[\/\\\u0000]/u.test(trimmed);
}

function errorMessage(locale: Locale, reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") { reject(new Error("File could not be read")); return; }
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("File could not be read"));
    reader.readAsDataURL(file);
  });
}

function FolderIcon() {
  return <span className="fm-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 4.2a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .66.25l1.2 1H13.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4.2z" /></svg></span>;
}

function FileIcon() {
  return <span className="fm-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M3.8 2.2h4.4L12.6 6.6V13a.8.8 0 0 1-.8.8H3.8a.8.8 0 0 1-.8-.8V3a.8.8 0 0 1 .8-.8z" /><path d="M8.2 2.4v3.6h3.6" /></svg></span>;
}

function LinkIcon() {
  return <span className="fm-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M6.5 9.5 9.5 6.5" /><path d="M7.8 4.5l.7-.7a2.4 2.4 0 0 1 3.4 3.4l-1.1 1.1" /><path d="M8.2 11.5l-.7.7a2.4 2.4 0 0 1-3.4-3.4l1.1-1.1" /></svg></span>;
}

function entryIcon(entry: WorktreeEntry) {
  if (entry.type === "directory") return <FolderIcon />;
  if (entry.type === "file") return <FileIcon />;
  return <LinkIcon />;
}

interface MoveDialogState {
  readonly kind: "move";
  readonly entry: WorktreeEntry;
}

interface NameDialogState {
  readonly kind: "newFolder" | "rename";
  readonly entry?: WorktreeEntry;
}

type DialogState = NameDialogState | MoveDialogState | null;

function FolderPicker({ api, draftId, excludePath, entryName, locale, onSelect, onCancel, t }: {
  readonly api: GitPmApi;
  readonly draftId: string;
  readonly excludePath: string;
  readonly entryName: string;
  readonly locale: Locale;
  readonly onSelect: (destination: string) => void;
  readonly onCancel: () => void;
  readonly t: (key: MessageKey) => string;
}) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<readonly WorktreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setEntries(null);
    void api.listWorktree(draftId, path)
      .then((result) => { if (active) setEntries(result.entries); })
      .catch((reason: unknown) => { if (active) setError(errorMessage(locale, reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, draftId, path, locale]);

  const excluded = (candidate: string): boolean => candidate === excludePath || (excludePath !== "" && candidate.startsWith(`${excludePath}/`));
  const resultPath = joinPath(path, entryName);
  const moveDisabled = resultPath === excludePath;
  const folders = entries?.filter((entry) => entry.type === "directory") ?? [];

  return <div className="fm-picker">
    <nav className="fm-breadcrumbs" aria-label={t("worktree.moveDestination")}>
      <button type="button" onClick={() => setPath("")}>{t("worktree.root")}</button>
      {crumbs(path).map((crumb) => <span className="fm-crumb" key={crumb.path}><span className="fm-crumb-sep" aria-hidden="true">/</span><button type="button" onClick={() => setPath(crumb.path)}>{crumb.name}</button></span>)}
    </nav>
    <div className="fm-picker-list">
      {loading && <span className="fm-empty">{t("status.loading")}</span>}
      {error !== null && <span className="fm-empty error">{error}</span>}
      {!loading && error === null && folders.length === 0 && <span className="fm-empty">{t("worktree.emptyDirectory")}</span>}
      {folders.map((entry) => {
        const disabled = excluded(entry.path);
        return <button key={entry.path} className="fm-picker-row" type="button" disabled={disabled} onClick={() => setPath(entry.path)} title={disabled ? t("worktree.moveInvalid") : entry.path}>
          <FolderIcon /><span>{entry.name}</span>
        </button>;
      })}
    </div>
    <div className="fm-dialog-actions">
      <button type="button" onClick={onCancel}>{t("worktree.cancel")}</button>
      <button type="button" className="primary" disabled={moveDisabled} onClick={() => onSelect(path)}>{t("worktree.moveHere")}</button>
    </div>
  </div>;
}

export function WorktreeWorkspace({ api, draft, role, locale, onChanged, confirmAction = () => true }: {
  readonly api: GitPmApi;
  readonly draft: DraftStatus;
  readonly role: GitPmRole;
  readonly locale: Locale;
  readonly onChanged: () => Promise<void>;
  readonly confirmAction?: (message: string) => boolean;
}) {
  const t = (key: MessageKey) => message(locale, key);
  const canMutate = role !== "Reporter" && draft.state === "open" && draft.writer_mode === "ui";

  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<readonly WorktreeEntry[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selected, setSelected] = useState<WorktreeFile | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [nameValue, setNameValue] = useState("");
  const fileRequest = useRef(0);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = (path: string) => {
    setEntries(null);
    setTreeError(null);
    void api.listWorktree(draft.draft_id, path)
      .then((result) => setEntries(result.entries))
      .catch((reason: unknown) => setTreeError(errorMessage(locale, reason)));
  };

  useEffect(() => {
    setCurrentPath("");
    setSelectedPath(undefined);
    setSelected(null);
    setFileError(null);
    setActionError(null);
    load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, draft.draft_id]);

  const navigate = (path: string) => {
    if (busy) return;
    setCurrentPath(path);
    setSelectedPath(undefined);
    setSelected(null);
    setFileError(null);
    load(path);
  };

  const selectFile = (path: string) => {
    const request = ++fileRequest.current;
    setSelectedPath(path);
    setSelected(null);
    setFileError(null);
    setFileLoading(true);
    void api.readWorktreeFile(draft.draft_id, path)
      .then((result) => { if (request === fileRequest.current) setSelected(result); })
      .catch((reason: unknown) => { if (request === fileRequest.current) setFileError(errorMessage(locale, reason)); })
      .finally(() => { if (request === fileRequest.current) setFileLoading(false); });
  };

  const run = async (operation: () => Promise<unknown>, keepSelection = false) => {
    setBusy(true);
    setActionError(null);
    try {
      await operation();
      await onChanged();
      if (!keepSelection) { setSelectedPath(undefined); setSelected(null); setFileError(null); }
      load(currentPath);
    } catch (reason) {
      setActionError(errorMessage(locale, reason));
    } finally {
      setBusy(false);
    }
  };

  const openNewFolder = () => { if (!busy) { setNameValue(""); setDialog({ kind: "newFolder" }); } };
  const openRename = (entry: WorktreeEntry) => { if (!busy) { setNameValue(entry.name); setDialog({ kind: "rename", entry }); } };
  const openMove = (entry: WorktreeEntry) => { if (!busy) setDialog({ kind: "move", entry }); };

  const submitName = () => {
    if (dialog?.kind !== "newFolder" && dialog?.kind !== "rename") return;
    const name = nameValue.trim();
    if (!isValidName(name)) { setActionError(t("worktree.nameInvalid")); return; }
    if (dialog.kind === "newFolder") {
      const target = joinPath(currentPath, name);
      void run(async () => { await api.createWorktreeDirectory(draft.draft_id, draft.fingerprint, target); }, true);
    } else {
      const entry = dialog.entry;
      if (entry === undefined || entry.name === name) { setDialog(null); return; }
      const from = entry.path;
      const to = joinPath(parentOf(entry.path), name);
      void run(async () => { await api.moveWorktreeEntry(draft.draft_id, draft.fingerprint, from, to); }, selectedPath !== from);
    }
    setDialog(null);
  };

  const removeEntry = (entry: WorktreeEntry) => {
    if (busy || !confirmAction(message(locale, "worktree.deleteConfirm", { name: entry.name }))) return;
    void run(async () => { await api.deleteWorktreeEntry(draft.draft_id, draft.fingerprint, entry.path); }, selectedPath !== entry.path);
  };

  const moveEntryTo = (entry: WorktreeEntry, destination: string) => {
    const to = joinPath(destination, entry.name);
    setDialog(null);
    void run(async () => { await api.moveWorktreeEntry(draft.draft_id, draft.fingerprint, entry.path, to); }, selectedPath !== entry.path);
  };

  const onFilesSelected = async (files: FileList | null) => {
    if (fileInput.current) fileInput.current.value = "";
    if (!canMutate || busy || files === null || files.length === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      let fingerprint = draft.fingerprint;
      for (const file of Array.from(files)) {
        if (file.size > MAX_UPLOAD_BYTES) { setActionError(message(locale, "worktree.uploadTooLarge", { name: file.name })); return; }
        const base64 = await readAsBase64(file);
        fingerprint = await api.uploadWorktreeFile(draft.draft_id, fingerprint, joinPath(currentPath, file.name), base64);
      }
      await onChanged();
      load(currentPath);
    } catch (reason) {
      setActionError(errorMessage(locale, reason));
    } finally {
      setBusy(false);
    }
  };

  const breadcrumb = useMemo(() => crumbs(currentPath), [currentPath]);

  return <section className="fm-layout">
    <div className="fm-browser card">
      <header className="fm-toolbar">
        <h2>{t("worktree.heading")}</h2>
        <p className="workspace-description">{t("worktree.description")}</p>
        <div className="fm-controls">
          <nav className="fm-breadcrumbs" aria-label={t("worktree.heading")}>
            <button type="button" onClick={() => navigate("")}>{t("worktree.root")}</button>
            {breadcrumb.map((crumb) => <span className="fm-crumb" key={crumb.path}><span className="fm-crumb-sep" aria-hidden="true">/</span><button type="button" onClick={() => navigate(crumb.path)}>{crumb.name}</button></span>)}
          </nav>
          <div className="fm-actions">
            <button type="button" onClick={() => load(currentPath)} disabled={busy}>{t("worktree.refresh")}</button>
            <button type="button" onClick={openNewFolder} disabled={!canMutate || busy}>{t("worktree.newFolder")}</button>
            <button type="button" onClick={() => fileInput.current?.click()} disabled={!canMutate || busy}>{t("worktree.upload")}</button>
            <input ref={fileInput} type="file" multiple className="fm-file-input" onChange={(event) => void onFilesSelected(event.target.files)} />
          </div>
        </div>
        {!canMutate && <div className="alert warning">{t("worktree.readOnly")}</div>}
        {actionError !== null && <div className="alert error">{actionError}</div>}
      </header>
      <div className="fm-list" role="region" aria-label={t("worktree.heading")}>
        {entries === null && treeError === null && <span className="fm-empty">{t("status.loading")}</span>}
        {treeError !== null && <span className="fm-empty error">{treeError}</span>}
        {entries !== null && entries.length === 0 && <span className="fm-empty">{t("worktree.empty")}</span>}
        {entries?.map((entry) => {
          const isFile = entry.type === "file";
          const isDir = entry.type === "directory";
          const unavailable = !isFile && !isDir;
          const main = unavailable
            ? <span className="fm-row-main unavailable" title={t(entry.type === "symlink" ? "worktree.symlinkUnavailable" : "worktree.entryUnavailable")}>{entryIcon(entry)}<span className="fm-row-name">{entry.name}</span></span>
            : <button type="button" className={`fm-row-main${selectedPath === entry.path ? " selected" : ""}`} onClick={() => (isDir ? navigate(entry.path) : selectFile(entry.path))} title={entry.path}>
              {entryIcon(entry)}<span className="fm-row-name">{entry.name}</span>
              <span className="fm-row-type">{isDir ? t("worktree.type.folder") : isFile ? t("worktree.type.file") : ""}</span>
              <span className="fm-row-size">{entry.size !== undefined ? formatBytes(locale, entry.size) : ""}</span>
            </button>;
          return <div className="fm-row" key={entry.path}>
            {main}
            {!unavailable && <div className="fm-row-actions">
              <button type="button" onClick={() => openRename(entry)} disabled={!canMutate || busy}>{t("worktree.rename")}</button>
              <button type="button" onClick={() => openMove(entry)} disabled={!canMutate || busy}>{t("worktree.move")}</button>
              <button type="button" className="danger" onClick={() => removeEntry(entry)} disabled={!canMutate || busy}>{t("worktree.delete")}</button>
            </div>}
          </div>;
        })}
      </div>
    </div>
    <div className="fm-preview card">
      {selectedPath === undefined
        ? <div className="worktree-placeholder"><h2>{t("worktree.previewHeading")}</h2><p>{t("worktree.selectFile")}</p></div>
        : <>
          <header><div><span className="eyebrow">{t("worktree.previewHeading")}</span><h2>{baseName(selectedPath)}</h2><code>{selectedPath}</code></div>{selected !== null && <span>{formatBytes(locale, selected.size)}</span>}</header>
          {fileLoading && <p>{t("status.loading")}</p>}
          {fileError !== null && <div className="alert error">{fileError}</div>}
          {selected !== null && <pre tabIndex={0}><code>{selected.content}</code></pre>}
        </>}
    </div>
    {dialog !== null && dialog.kind !== "move" && <div className="modal-backdrop" role="presentation">
      <section className="fm-dialog" role="dialog" aria-modal="true" aria-labelledby="fm-name-heading">
        <h3 id="fm-name-heading">{dialog.kind === "newFolder" ? t("worktree.newFolderHeading") : message(locale, "worktree.renameHeading", { name: dialog.entry?.name ?? "" })}</h3>
        <label className="fm-field">{t("worktree.nameLabel")}
          <input autoFocus value={nameValue} onChange={(event) => setNameValue(event.target.value)} placeholder={t("worktree.namePlaceholder")} onKeyDown={(event) => { if (event.key === "Enter") submitName(); if (event.key === "Escape") setDialog(null); }} />
        </label>
        <div className="fm-dialog-actions">
          <button type="button" onClick={() => setDialog(null)}>{t("worktree.cancel")}</button>
          <button type="button" className="primary" onClick={submitName} disabled={busy || !isValidName(nameValue.trim())}>{dialog.kind === "newFolder" ? t("worktree.create") : t("worktree.save")}</button>
        </div>
      </section>
    </div>}
    {dialog !== null && dialog.kind === "move" && <div className="modal-backdrop" role="presentation">
      <section className="fm-dialog" role="dialog" aria-modal="true" aria-labelledby="fm-move-heading">
        <h3 id="fm-move-heading">{message(locale, "worktree.moveHeading", { name: dialog.entry.name })}</h3>
        <FolderPicker
          api={api}
          draftId={draft.draft_id}
          excludePath={dialog.entry.path}
          entryName={dialog.entry.name}
          locale={locale}
          t={t}
          onSelect={(destination) => moveEntryTo(dialog.entry, destination)}
          onCancel={() => setDialog(null)}
        />
      </section>
    </div>}
  </section>;
}
