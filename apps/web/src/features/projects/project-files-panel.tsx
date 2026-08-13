import type { ProjectFileItem, ProjectFileList, ProjectFileUploadResult } from "@gitpm/contracts";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { ApiError, formatApiError, type GitPmApi } from "../../api.js";
import type { AsyncLoadState } from "../../async-data.js";
import { EditorDrawer } from "../../editor-drawer.js";
import { formatDateTime, message, type Locale, type MessageKey } from "../../i18n.js";

export type ProjectFilesView = "grid" | "table";

export const PROJECT_FILES_VIEW_COOKIE = "gitpm.projectFiles.view";
export const PROJECT_FILE_LARGE_WARNING_BYTES = 50 * 1024 * 1024;
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export function readProjectFilesView(cookie = typeof document === "undefined" ? "" : document.cookie): ProjectFilesView {
  try {
    for (const entry of cookie.split(";")) {
      const separator = entry.indexOf("=");
      if (separator < 0) continue;
      const name = decodeURIComponent(entry.slice(0, separator).trim());
      if (name !== PROJECT_FILES_VIEW_COOKIE) continue;
      const value = decodeURIComponent(entry.slice(separator + 1).trim());
      return value === "table" || value === "grid" ? value : "grid";
    }
  } catch { /* A malformed or unavailable cookie must not break the Project page. */ }
  return "grid";
}

export function writeProjectFilesView(view: ProjectFilesView): void {
  if (typeof document === "undefined") return;
  try {
    document.cookie = `${encodeURIComponent(PROJECT_FILES_VIEW_COOKIE)}=${view}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
  } catch { /* Cookies may be disabled. The in-memory choice still applies. */ }
}

type FileFamily = "pdf" | "word" | "sheet" | "slides" | "image" | "text" | "archive" | "file";

function fileExtension(name: string): string {
  const separator = name.lastIndexOf(".");
  return separator <= 0 || separator === name.length - 1 ? "" : name.slice(separator + 1).toLocaleLowerCase("en-US");
}

export function projectFileFamily(name: string): FileFamily {
  const extension = fileExtension(name);
  if (extension === "pdf") return "pdf";
  if (["doc", "docx", "odt", "rtf"].includes(extension)) return "word";
  if (["xls", "xlsx", "ods", "csv", "tsv"].includes(extension)) return "sheet";
  if (["ppt", "pptx", "odp"].includes(extension)) return "slides";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff"].includes(extension)) return "image";
  if (["txt", "md", "markdown", "json", "yaml", "yml", "xml", "html", "css", "js", "jsx", "ts", "tsx", "py", "java", "c", "cpp", "cs", "go", "rs", "sql", "log"].includes(extension)) return "text";
  if (["zip", "7z", "rar", "tar", "gz", "bz2", "xz"].includes(extension)) return "archive";
  return "file";
}

const FAMILY_LABEL: Readonly<Record<FileFamily, string>> = {
  pdf: "PDF", word: "DOC", sheet: "XLS", slides: "PPT", image: "IMG", text: "TXT", archive: "ZIP", file: "FILE",
};

function FileIcon({ name }: { readonly name: string }) {
  const family = projectFileFamily(name);
  return <svg aria-hidden="true" className={`project-file-icon project-file-icon-${family}`} viewBox="0 0 52 64">
    <path className="project-file-icon-page" d="M7 1h25l13 13v49H7z" />
    <path className="project-file-icon-fold" d="M32 1v13h13" />
    <rect className="project-file-icon-badge" height="19" rx="3" width="46" x="1" y="35" />
    <text className="project-file-icon-label" textAnchor="middle" x="24" y="49">{FAMILY_LABEL[family]}</text>
  </svg>;
}

function formatFileSize(locale: Locale, bytes: number): string {
  if (bytes < 1024) return `${new Intl.NumberFormat(locale).format(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} ${unit}`;
}

function FileGrid({ items, locale, t }: { readonly items: readonly ProjectFileItem[]; readonly locale: Locale; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string }) {
  return <ul aria-label={t("projectFiles.listLabel")} className="project-files-grid">
    {items.map((item) => <li aria-label={item.name} className="project-file-tile" key={item.name} title={item.name}>
      <FileIcon name={item.name} />
      <span className="project-file-name">{item.name}</span>
      <span className="project-file-size">{formatFileSize(locale, item.size_bytes)}</span>
    </li>)}
  </ul>;
}

function FileTable({ items, locale, t }: { readonly items: readonly ProjectFileItem[]; readonly locale: Locale; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string }) {
  return <div className="project-files-table-scroll"><table className="project-files-table">
    <caption className="sr-only">{t("projectFiles.listLabel")}</caption>
    <thead><tr><th>{t("projectFiles.name")}</th><th>{t("projectFiles.type")}</th><th>{t("projectFiles.size")}</th><th>{t("projectFiles.modified")}</th></tr></thead>
    <tbody>{items.map((item) => <tr key={item.name} title={item.name}>
      <td><span className="project-file-table-name"><FileIcon name={item.name} /><span>{item.name}</span></span></td>
      <td>{FAMILY_LABEL[projectFileFamily(item.name)]}</td>
      <td>{formatFileSize(locale, item.size_bytes)}</td>
      <td>{formatDateTime(locale, item.modified_at)}</td>
    </tr>)}</tbody>
  </table></div>;
}

type UploadState = "confirmation" | "conflict" | "queued" | "uploading" | "success" | "error" | "cancelled";
interface UploadQueueItem {
  readonly id: number;
  readonly file: File;
  readonly name: string;
  readonly mode: "create" | "replace";
  readonly state: UploadState;
  readonly largeConfirmed: boolean;
  readonly existingName?: string;
  readonly loaded: number;
  readonly error?: string;
}

const comparableName = (name: string) => name.normalize("NFC").toLocaleLowerCase("en-US");

export function ProjectFilesPanel({ api, draftId, fingerprint, locale, list, loadState, onClose, onReload, onUploaded, onViewChange, open, projectId, readOnly, view }: {
  readonly api: Pick<GitPmApi, "uploadProjectFile">;
  readonly draftId: string;
  readonly fingerprint: string;
  readonly locale: Locale;
  readonly list: ProjectFileList | null;
  readonly loadState: AsyncLoadState;
  readonly onClose: () => void;
  readonly onReload: () => void;
  readonly onUploaded: (result: ProjectFileUploadResult) => void;
  readonly onViewChange: (view: ProjectFilesView) => void;
  readonly open: boolean;
  readonly projectId: string;
  readonly readOnly: boolean;
  readonly view: ProjectFilesView;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const setView = (next: ProjectFilesView) => { writeProjectFilesView(next); onViewChange(next); };
  const readyList = loadState.status === "ready" ? list : null;
  const [queue, setQueue] = useState<readonly UploadQueueItem[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const nextId = useRef(1);
  const fingerprintRef = useRef(fingerprint);
  const activeController = useRef<AbortController | null>(null);

  useEffect(() => { fingerprintRef.current = fingerprint; }, [fingerprint]);
  useEffect(() => { if (readOnly) activeController.current?.abort(); }, [readOnly]);
  useEffect(() => () => activeController.current?.abort(), []);
  const activeConfirmation = queue.find((item) => item.state === "confirmation");
  useEffect(() => { setConfirmation(""); }, [activeConfirmation?.id]);

  const existingName = (name: string, additional: readonly UploadQueueItem[] = queue): string | undefined => {
    const key = comparableName(name);
    return list?.items.find((item) => comparableName(item.name) === key)?.name
      ?? additional.find((item) => item.state !== "cancelled" && item.state !== "error" && comparableName(item.name) === key)?.name;
  };

  const addFiles = (files: readonly File[]) => {
    if (readOnly || files.length === 0) return;
    setQueue((current) => {
      const added: UploadQueueItem[] = [];
      for (const file of files) {
        const collision = existingName(file.name, [...current, ...added]);
        const large = file.size > PROJECT_FILE_LARGE_WARNING_BYTES;
        added.push({
          id: nextId.current++, file, name: file.name, mode: "create",
          state: large ? "confirmation" : collision === undefined ? "queued" : "conflict",
          largeConfirmed: !large, ...(collision === undefined ? {} : { existingName: collision }), loaded: 0,
        });
      }
      return [...current, ...added];
    });
  };

  useEffect(() => {
    if (busyId !== null || readOnly) return;
    const next = queue.find((item) => item.state === "queued");
    if (next === undefined) return;
    const controller = new AbortController();
    activeController.current = controller;
    setBusyId(next.id);
    setQueue((current) => current.map((item) => item.id === next.id ? { ...item, state: "uploading", error: undefined } : item));
    void api.uploadProjectFile(draftId, projectId, fingerprintRef.current, next.file, next.name, next.mode, {
      ...(next.file.size > PROJECT_FILE_LARGE_WARNING_BYTES ? { largeFileConfirmation: next.name } : {}),
      signal: controller.signal,
      onProgress: (loaded) => setQueue((current) => current.map((item) => item.id === next.id ? { ...item, loaded } : item)),
    }).then((result) => {
      fingerprintRef.current = result.draft_fingerprint;
      setQueue((current) => current.map((item) => item.id === next.id ? { ...item, state: "success", loaded: item.file.size } : item));
      onUploaded(result);
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        setQueue((current) => current.map((item) => item.id === next.id ? { ...item, state: "cancelled" } : item));
      } else if (error instanceof ApiError && (error.code === "PROJECT_FILE_EXISTS" || error.code === "PROJECT_FILE_NAME_CONFLICT")) {
        setQueue((current) => current.map((item) => item.id === next.id ? { ...item, state: "conflict", existingName: error.code === "PROJECT_FILE_EXISTS" ? item.name : item.existingName, error: formatApiError(error) } : item));
      } else {
        setQueue((current) => current.map((item) => item.id === next.id ? { ...item, state: "error", error: formatApiError(error) } : item));
      }
    }).finally(() => {
      activeController.current = null;
      setBusyId(null);
    });
  }, [api, busyId, draftId, onUploaded, projectId, queue, readOnly]);

  const updateQueue = (id: number, update: (item: UploadQueueItem) => UploadQueueItem) => setQueue((current) => current.map((item) => item.id === id ? update(item) : item));
  const confirmLarge = (item: UploadQueueItem) => updateQueue(item.id, (current) => ({ ...current, largeConfirmed: true, state: current.existingName === undefined ? "queued" : "conflict" }));
  const cancelItem = (item: UploadQueueItem) => {
    if (item.state === "uploading") activeController.current?.abort();
    else updateQueue(item.id, (current) => ({ ...current, state: "cancelled" }));
  };
  const chooseReplacement = (item: UploadQueueItem) => updateQueue(item.id, (current) => ({ ...current, mode: "replace", name: current.existingName ?? current.name, state: "queued", error: undefined }));
  const chooseName = (item: UploadQueueItem, name: string) => {
    const collision = existingName(name, queue.filter((other) => other.id !== item.id));
    const needsLargeConfirmation = item.file.size > PROJECT_FILE_LARGE_WARNING_BYTES && name !== item.name;
    updateQueue(item.id, (current) => ({
      ...current, name, mode: "create", existingName: collision,
      largeConfirmed: needsLargeConfirmation ? false : current.largeConfirmed,
      state: needsLargeConfirmation ? "confirmation" : collision === undefined ? "queued" : "conflict", error: undefined,
    }));
  };
  const retry = (item: UploadQueueItem) => updateQueue(item.id, (current) => ({ ...current, state: current.file.size > PROJECT_FILE_LARGE_WARNING_BYTES && !current.largeConfirmed ? "confirmation" : current.existingName === undefined ? "queued" : "conflict", loaded: 0, error: undefined }));
  const onDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragActive(false); addFiles(Array.from(event.dataTransfer.files)); };

  return <EditorDrawer closeLabel={t("projectFiles.close")} onClose={onClose} open={open} title={t("projectFiles.heading", { count: list?.count ?? 0 })}>
    <div className="project-files-panel">
      <div className="project-files-toolbar">
        <input aria-label={t("projectFiles.selectFiles")} disabled={readOnly} hidden multiple onChange={(event) => { addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} ref={fileInput} type="file" />
        <button className="primary" disabled={readOnly} onClick={() => fileInput.current?.click()} type="button">{t("projectFiles.upload")}</button>
        <button disabled={loadState.status === "loading"} onClick={onReload} type="button">{t("projectFiles.refresh")}</button>
        <div aria-label={t("projectFiles.viewLabel")} className="project-files-view-switch" role="group">
          <button aria-label={t("projectFiles.gridView")} aria-pressed={view === "grid"} onClick={() => setView("grid")} title={t("projectFiles.gridView")} type="button">▦</button>
          <button aria-label={t("projectFiles.tableView")} aria-pressed={view === "table"} onClick={() => setView("table")} title={t("projectFiles.tableView")} type="button">☷</button>
        </div>
      </div>
      {readOnly && <p className="project-files-readonly">{t("projectFiles.readOnly")}</p>}
      <div className={`project-files-dropzone${dragActive ? " is-dragging" : ""}`} onDragEnter={(event) => { event.preventDefault(); if (!readOnly) setDragActive(true); }} onDragLeave={() => setDragActive(false)} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        {t(readOnly ? "projectFiles.dropReadOnly" : "projectFiles.drop")}
      </div>
      {queue.length > 0 && <section aria-label={t("projectFiles.uploadQueue")} className="project-files-upload-queue">
        <div className="project-files-queue-heading"><strong>{t("projectFiles.uploadQueue")}</strong><button disabled={busyId !== null} onClick={() => setQueue((current) => current.filter((item) => item.state !== "success" && item.state !== "cancelled"))} type="button">{t("projectFiles.clearFinished")}</button></div>
        <ul>{queue.map((item) => {
          const percent = item.file.size === 0 ? (item.state === "success" ? 100 : 0) : Math.min(100, Math.round(item.loaded / item.file.size * 100));
          return <li className={`project-files-upload-item is-${item.state}`} key={item.id}>
            <div><strong title={item.name}>{item.name}</strong><span>{formatFileSize(locale, item.file.size)} · {t(`projectFiles.uploadState.${item.state}` as MessageKey)}</span></div>
            {(item.state === "uploading" || item.state === "success") && <progress aria-label={t("projectFiles.uploadProgress", { name: item.name })} max={100} value={percent}>{percent}%</progress>}
            {item.error !== undefined && <span className="project-files-upload-error" role="alert">{item.error}</span>}
            {item.state === "conflict" && <div className="project-files-conflict">
              <span>{t("projectFiles.nameConflict", { name: item.existingName ?? item.name })}</span>
              {item.existingName === item.name && <button onClick={() => chooseReplacement(item)} type="button">{t("projectFiles.replace")}</button>}
              <label>{t("projectFiles.otherName")}<input aria-label={t("projectFiles.otherNameFor", { name: item.name })} defaultValue={item.name} key={`${item.id}:${item.name}`} /></label>
              <button onClick={(event) => { const input = event.currentTarget.previousElementSibling?.querySelector("input"); if (input instanceof HTMLInputElement) chooseName(item, input.value); }} type="button">{t("projectFiles.uploadOtherName")}</button>
            </div>}
            <div className="project-files-upload-actions">
              {item.state === "error" && <button onClick={() => retry(item)} type="button">{t("status.retry")}</button>}
              {(item.state === "queued" || item.state === "uploading" || item.state === "confirmation" || item.state === "conflict") && <button onClick={() => cancelItem(item)} type="button">{t("core.cancel")}</button>}
            </div>
          </li>;
        })}</ul>
      </section>}
      {loadState.status === "loading" && <div className="project-files-state" role="status"><span className="loading-indicator" aria-hidden="true" />{t("projectFiles.loading")}</div>}
      {loadState.status === "error" && <div className="alert error project-files-error" role="alert"><span>{t("projectFiles.loadError", { message: loadState.error })}</span><button onClick={onReload} type="button">{t("status.retry")}</button></div>}
      {loadState.status === "ready" && loadState.refreshError !== undefined && <div className="alert error project-files-error" role="alert"><span>{t("projectFiles.loadError", { message: loadState.refreshError })}</span><button onClick={onReload} type="button">{t("status.retry")}</button></div>}
      {readyList !== null && readyList.items.length === 0 && <div className="project-files-state project-files-empty"><strong>{t("projectFiles.emptyHeading")}</strong><span>{t("projectFiles.emptyDescription")}</span></div>}
      {readyList !== null && readyList.items.length > 0 && (view === "grid"
        ? <FileGrid items={readyList.items} locale={locale} t={t} />
        : <FileTable items={readyList.items} locale={locale} t={t} />)}
      {activeConfirmation !== undefined && <div aria-labelledby="project-file-large-title" aria-modal="true" className="project-file-large-dialog" onKeyDown={(event) => { if (event.key === "Escape") cancelItem(activeConfirmation); }} role="dialog">
        <div className="project-file-large-card">
          <h3 id="project-file-large-title">{t("projectFiles.largeHeading")}</h3>
          <p>{t("projectFiles.largeDetails", { name: activeConfirmation.name, size: formatFileSize(locale, activeConfirmation.file.size) })}</p>
          <p>{t("projectFiles.largeGitWarning")}</p>
          <label>{t("projectFiles.largeTypeName", { name: activeConfirmation.name })}<input autoFocus onChange={(event) => setConfirmation(event.target.value)} value={confirmation} /></label>
          <div className="project-file-large-actions"><button onClick={() => cancelItem(activeConfirmation)} type="button">{t("core.cancel")}</button><button className="primary" disabled={confirmation !== activeConfirmation.name} onClick={() => confirmLarge(activeConfirmation)} type="button">{t("projectFiles.largeConfirm")}</button></div>
        </div>
      </div>}
    </div>
  </EditorDrawer>;
}
