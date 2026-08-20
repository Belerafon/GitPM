import type { ProjectFileDeleteResult, ProjectFileItem, ProjectFileList, ProjectFileReferencePreview, ProjectFileRenameResult, ProjectFileReplaceResult, ProjectFileUploadResult } from "@gitpm/contracts";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { ApiError, formatApiError, projectFileContentUrl, projectFileDownloadUrl, type GitPmApi } from "../../api.js";
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

type ProjectFileAction = "properties" | "rename" | "replace" | "delete";

function FileActionMenu({ draftId, item, onAction, onClose, onToggle, open, projectId, readOnly, t }: {
  readonly draftId: string;
  readonly item: ProjectFileItem;
  readonly onAction: (item: ProjectFileItem, action: ProjectFileAction) => void;
  readonly onClose: () => void;
  readonly onToggle: (item: ProjectFileItem, trigger: HTMLButtonElement) => void;
  readonly open: boolean;
  readonly projectId: string;
  readonly readOnly: boolean;
  readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [alignment, setAlignment] = useState<"start" | "end">("end");
  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) onClose();
    };
    document.addEventListener("pointerdown", closeFromOutside, true);
    return () => document.removeEventListener("pointerdown", closeFromOutside, true);
  }, [onClose, open]);

  return <div className={`project-file-action-menu align-${alignment}${open ? " is-open" : ""}`} onKeyDown={(event) => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    onClose();
    root.current?.querySelector<HTMLButtonElement>(".project-file-select")?.focus();
  }} ref={root}>
    <button aria-expanded={open} aria-haspopup="true" aria-label={t("projectFiles.selectActions", { name: item.name })} aria-pressed={open} className="project-file-select" onClick={(event) => {
      const boundary = event.currentTarget.closest(".editor-drawer-body")?.getBoundingClientRect();
      const trigger = event.currentTarget.getBoundingClientRect();
      setAlignment(boundary !== undefined && boundary.right - trigger.left >= 210 ? "start" : "end");
      onToggle(item, event.currentTarget);
    }} type="button">•••</button>
    {open && <div aria-label={t("projectFiles.actionsFor", { name: item.name })} className="project-file-action-popover" role="group">
      <a aria-label={t("projectFiles.openNamed", { name: item.name })} href={fileOpenUrl(draftId, projectId, item)} onClick={onClose} rel="noopener noreferrer" target="_blank">{t("projectFiles.open")}</a>
      <a aria-label={t("projectFiles.downloadNamed", { name: item.name })} href={projectFileDownloadUrl(draftId, projectId, item.name)} onClick={onClose} rel="noopener noreferrer" target="_blank">{t("projectFiles.download")}</a>
      <button aria-label={t("projectFiles.propertiesNamed", { name: item.name })} onClick={() => onAction(item, "properties")} type="button">{t("projectFiles.properties")}</button>
      <button aria-label={t("projectFiles.renameNamed", { name: item.name })} disabled={readOnly} onClick={() => onAction(item, "rename")} type="button">{t("projectFiles.rename")}</button>
      <button aria-label={t("projectFiles.replaceNamed", { name: item.name })} disabled={readOnly} onClick={() => onAction(item, "replace")} type="button">{t("projectFiles.replaceWithNew")}</button>
      <button aria-label={t("projectFiles.deleteNamed", { name: item.name })} className="danger" disabled={readOnly} onClick={() => onAction(item, "delete")} type="button">{t("projectFiles.delete")}</button>
    </div>}
  </div>;
}

export function formatFileSize(locale: Locale, bytes: number): string {
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

function fileOpenUrl(draftId: string, projectId: string, item: ProjectFileItem): string {
  return item.disposition === "inline" ? projectFileContentUrl(draftId, projectId, item.name) : projectFileDownloadUrl(draftId, projectId, item.name);
}

function FileGrid({ actionMenuName, draftId, items, locale, onAction, onCloseMenu, onToggleMenu, projectId, readOnly, selectedName, t }: { readonly actionMenuName?: string; readonly draftId: string; readonly items: readonly ProjectFileItem[]; readonly locale: Locale; readonly onAction: (item: ProjectFileItem, action: ProjectFileAction) => void; readonly onCloseMenu: () => void; readonly onToggleMenu: (item: ProjectFileItem, trigger: HTMLButtonElement) => void; readonly projectId: string; readonly readOnly: boolean; readonly selectedName?: string; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string }) {
  return <ul aria-label={t("projectFiles.listLabel")} className="project-files-grid">
    {items.map((item) => <li className={`project-file-tile${selectedName === item.name ? " is-selected" : ""}${actionMenuName === item.name ? " is-menu-open" : ""}`} key={item.name} title={item.name}>
      <a aria-label={t(item.disposition === "inline" ? "projectFiles.openNamed" : "projectFiles.downloadNamed", { name: item.name })} className="project-file-open" href={fileOpenUrl(draftId, projectId, item)} rel="noopener noreferrer" target="_blank">
        <FileIcon name={item.name} />
        <span className="project-file-name">{item.name}</span>
        <span className="project-file-size">{formatFileSize(locale, item.size_bytes)}</span>
      </a>
      <FileActionMenu draftId={draftId} item={item} onAction={onAction} onClose={onCloseMenu} onToggle={onToggleMenu} open={actionMenuName === item.name} projectId={projectId} readOnly={readOnly} t={t} />
    </li>)}
  </ul>;
}

function FileTable({ actionMenuName, draftId, items, locale, onAction, onCloseMenu, onToggleMenu, projectId, readOnly, selectedName, t }: { readonly actionMenuName?: string; readonly draftId: string; readonly items: readonly ProjectFileItem[]; readonly locale: Locale; readonly onAction: (item: ProjectFileItem, action: ProjectFileAction) => void; readonly onCloseMenu: () => void; readonly onToggleMenu: (item: ProjectFileItem, trigger: HTMLButtonElement) => void; readonly projectId: string; readonly readOnly: boolean; readonly selectedName?: string; readonly t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string }) {
  return <div className={`project-files-table-scroll${actionMenuName === undefined ? "" : " has-open-menu"}`}><table className="project-files-table">
    <caption className="sr-only">{t("projectFiles.listLabel")}</caption>
    <thead><tr><th>{t("projectFiles.name")}</th><th>{t("projectFiles.type")}</th><th>{t("projectFiles.size")}</th><th>{t("projectFiles.modified")}</th><th><span className="sr-only">{t("projectFiles.actions")}</span></th></tr></thead>
    <tbody>{items.map((item) => <tr className={selectedName === item.name ? "is-selected" : undefined} key={item.name} title={item.name}>
      <td><a aria-label={t(item.disposition === "inline" ? "projectFiles.openNamed" : "projectFiles.downloadNamed", { name: item.name })} className="project-file-table-name" href={fileOpenUrl(draftId, projectId, item)} rel="noopener noreferrer" target="_blank"><FileIcon name={item.name} /><span>{item.name}</span></a></td>
      <td>{FAMILY_LABEL[projectFileFamily(item.name)]}</td>
      <td>{formatFileSize(locale, item.size_bytes)}</td>
      <td>{formatDateTime(locale, item.modified_at)}</td>
      <td><FileActionMenu draftId={draftId} item={item} onAction={onAction} onClose={onCloseMenu} onToggle={onToggleMenu} open={actionMenuName === item.name} projectId={projectId} readOnly={readOnly} t={t} /></td>
    </tr>)}</tbody>
  </table></div>;
}

type UploadState = "confirmation" | "conflict" | "reference_check" | "replace_confirmation" | "queued" | "uploading" | "success" | "error" | "cancelled";
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
  readonly referencePreview?: ProjectFileReferencePreview;
}

const comparableName = (name: string) => name.normalize("NFC").toLocaleLowerCase("en-US");

export function ProjectFilesPanel({ api, draftId, fingerprint, locale, list, loadState, onClose, onDeleted, onReload, onRenamed, onReplaced, onUploaded, onViewChange, open, projectId, readOnly, view }: {
  readonly api: Pick<GitPmApi, "deleteProjectFile" | "projectFileReferences" | "renameProjectFile" | "replaceProjectFile" | "uploadProjectFile">;
  readonly draftId: string;
  readonly fingerprint: string;
  readonly locale: Locale;
  readonly list: ProjectFileList | null;
  readonly loadState: AsyncLoadState;
  readonly onClose: () => void;
  readonly onDeleted: (result: ProjectFileDeleteResult) => void;
  readonly onReload: () => void;
  readonly onRenamed: (result: ProjectFileRenameResult) => void;
  readonly onReplaced: (result: ProjectFileReplaceResult) => void;
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
  const [selectedName, setSelectedName] = useState<string>();
  const [actionMenuName, setActionMenuName] = useState<string>();
  const [fileAction, setFileAction] = useState<ProjectFileAction>();
  const [actionValue, setActionValue] = useState("");
  const [actionError, setActionError] = useState<string>();
  const [actionBusy, setActionBusy] = useState(false);
  const [referencePreview, setReferencePreview] = useState<{ readonly status: "loading" } | { readonly status: "ready"; readonly value: ProjectFileReferencePreview } | { readonly status: "error"; readonly error: string }>();
  const [referenceChoice, setReferenceChoice] = useState<"update" | "keep" | "restrict" | "unlink">("update");
  const [replacementFile, setReplacementFile] = useState<File>();
  const [replacementConfirmation, setReplacementConfirmation] = useState("");
  const [replacementProgress, setReplacementProgress] = useState(0);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const actionTrigger = useRef<HTMLElement | null>(null);
  const actionDialog = useRef<HTMLDivElement | null>(null);
  const actionMenuTrigger = useRef<HTMLButtonElement | null>(null);
  const replaceTrigger = useRef<HTMLElement | null>(null);
  const replaceDialog = useRef<HTMLDivElement | null>(null);
  const referenceRequest = useRef(0);
  const replaceRequest = useRef(0);
  const restoreActionFocus = useRef(false);
  const restoreReplaceFocus = useRef(false);
  const replaceReturnId = useRef<number | null>(null);
  const nextId = useRef(1);
  const fingerprintRef = useRef(fingerprint);
  const activeController = useRef<AbortController | null>(null);

  useEffect(() => { fingerprintRef.current = fingerprint; }, [fingerprint]);
  useEffect(() => { if (readOnly) activeController.current?.abort(); }, [readOnly]);
  useEffect(() => () => activeController.current?.abort(), []);
  useEffect(() => () => { referenceRequest.current += 1; replaceRequest.current += 1; }, []);
  const activeConfirmation = queue.find((item) => item.state === "confirmation");
  const activeReplaceConfirmation = queue.find((item) => item.state === "replace_confirmation");
  const selected = list?.items.find((item) => item.name === selectedName);
  useEffect(() => { setConfirmation(""); }, [activeConfirmation?.id]);
  useEffect(() => {
    if (selectedName !== undefined && list?.items.some((item) => item.name === selectedName) !== true) setSelectedName(undefined);
    if (actionMenuName !== undefined && list?.items.some((item) => item.name === actionMenuName) !== true) setActionMenuName(undefined);
  }, [actionMenuName, list, selectedName]);
  useEffect(() => {
    if (fileAction !== undefined || !restoreActionFocus.current) return;
    restoreActionFocus.current = false;
    actionTrigger.current?.focus();
  }, [fileAction]);
  useEffect(() => {
    if (activeReplaceConfirmation !== undefined || !restoreReplaceFocus.current) return;
    restoreReplaceFocus.current = false;
    const trigger = replaceTrigger.current;
    if (trigger?.isConnected) trigger.focus();
    else if (replaceReturnId.current !== null) document.querySelector<HTMLElement>(`[data-upload-id="${replaceReturnId.current}"]`)?.focus();
  }, [activeReplaceConfirmation]);
  useEffect(() => {
    if (open) return;
    referenceRequest.current += 1;
    replaceRequest.current += 1;
    setFileAction(undefined);
    setActionMenuName(undefined);
    setQueue((current) => current.map((item) => item.state === "reference_check" || item.state === "replace_confirmation" ? { ...item, state: "cancelled" } : item));
  }, [open]);

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
      ...(next.mode === "replace" ? { referenceMode: "preserve_checked" as const } : {}),
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
  const chooseReplacement = async (item: UploadQueueItem, trigger: HTMLElement) => {
    const name = item.existingName ?? item.name;
    const generation = ++replaceRequest.current;
    replaceTrigger.current = trigger;
    replaceReturnId.current = item.id;
    updateQueue(item.id, (current) => ({ ...current, state: "reference_check", error: undefined }));
    try {
      const preview = await api.projectFileReferences(draftId, projectId, name);
      if (replaceRequest.current !== generation) return;
      fingerprintRef.current = preview.draft_fingerprint;
      updateQueue(item.id, (current) => current.state === "reference_check" ? ({ ...current, mode: "replace", name, state: "replace_confirmation", referencePreview: preview, error: undefined }) : current);
    } catch (error) {
      if (replaceRequest.current !== generation) return;
      updateQueue(item.id, (current) => current.state === "reference_check" ? ({ ...current, state: "error", error: t("projectFiles.referencesCheckFailed", { message: formatApiError(error) }) }) : current);
    }
  };
  const closeReplaceConfirmation = (item: UploadQueueItem, nextState: "cancelled" | "queued") => {
    replaceRequest.current += 1;
    restoreReplaceFocus.current = true;
    updateQueue(item.id, (current) => ({ ...current, state: nextState }));
  };
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
  const loadActionReferences = (name: string) => {
    const generation = ++referenceRequest.current;
    setReferencePreview({ status: "loading" });
    void api.projectFileReferences(draftId, projectId, name).then((value) => {
      if (referenceRequest.current !== generation) return;
      fingerprintRef.current = value.draft_fingerprint;
      setReferencePreview({ status: "ready", value });
    }).catch((error: unknown) => { if (referenceRequest.current === generation) setReferencePreview({ status: "error", error: formatApiError(error) }); });
  };
  const beginAction = (item: ProjectFileItem, action: ProjectFileAction, trigger: HTMLElement) => {
    setSelectedName(item.name);
    setActionMenuName(undefined);
    actionTrigger.current = trigger;
    setActionError(undefined);
    setActionValue(action === "rename" ? item.name : "");
    setReplacementFile(undefined);
    setReplacementConfirmation("");
    setReplacementProgress(0);
    if (action !== "properties") {
      setReferenceChoice(action === "rename" ? "update" : "restrict");
    }
    loadActionReferences(item.name);
    setFileAction(action);
  };
  const toggleActionMenu = (item: ProjectFileItem, trigger: HTMLButtonElement) => {
    actionMenuTrigger.current = trigger;
    setSelectedName(item.name);
    setActionMenuName((current) => current === item.name ? undefined : item.name);
  };
  const beginMenuAction = (item: ProjectFileItem, action: ProjectFileAction) => beginAction(item, action, actionMenuTrigger.current ?? document.body);
  const closeAction = () => {
    referenceRequest.current += 1;
    restoreActionFocus.current = true;
    setFileAction(undefined);
    setActionError(undefined);
  };
  const renameSelected = async () => {
    if (selected === undefined || actionValue === selected.name) return;
    setActionBusy(true);
    setActionError(undefined);
    try {
      if (referencePreview?.status !== "ready") return;
      const result = await api.renameProjectFile(draftId, projectId, selected.name, fingerprintRef.current, actionValue, referenceChoice === "keep" ? "keep" : "update");
      fingerprintRef.current = result.draft_fingerprint;
      onRenamed(result);
      setSelectedName(result.item.name);
      closeAction();
    } catch (error) { setActionError(formatApiError(error)); }
    finally { setActionBusy(false); }
  };
  const deleteSelected = async () => {
    if (selected === undefined || actionValue !== selected.name) return;
    setActionBusy(true);
    setActionError(undefined);
    try {
      if (referencePreview?.status !== "ready") return;
      const result = await api.deleteProjectFile(draftId, projectId, selected.name, fingerprintRef.current, actionValue, referenceChoice === "unlink" ? "unlink" : "restrict");
      fingerprintRef.current = result.draft_fingerprint;
      onDeleted(result);
      setSelectedName(undefined);
      closeAction();
    } catch (error) { setActionError(formatApiError(error)); }
    finally { setActionBusy(false); }
  };
  const replaceSelected = async () => {
    if (selected === undefined || replacementFile === undefined || referencePreview?.status !== "ready") return;
    if (replacementFile.size > PROJECT_FILE_LARGE_WARNING_BYTES && replacementConfirmation !== replacementFile.name) return;
    setActionBusy(true);
    setActionError(undefined);
    const controller = new AbortController();
    activeController.current = controller;
    try {
      const result = await api.replaceProjectFile(draftId, projectId, selected.name, fingerprintRef.current, replacementFile, replacementFile.name, {
        ...(replacementFile.size > PROJECT_FILE_LARGE_WARNING_BYTES ? { largeFileConfirmation: replacementConfirmation } : {}),
        signal: controller.signal,
        onProgress: (loaded) => setReplacementProgress(loaded),
      });
      fingerprintRef.current = result.draft_fingerprint;
      onReplaced(result);
      setSelectedName(result.item.name);
      closeAction();
    } catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) setActionError(formatApiError(error)); }
    finally { activeController.current = null; setActionBusy(false); }
  };
  const extensionChanged = selected !== undefined && fileExtension(actionValue) !== fileExtension(selected.name);
  const onActionKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !actionBusy) { event.stopPropagation(); closeAction(); return; }
    if (event.key !== "Tab" || actionDialog.current === null) return;
    event.stopPropagation();
    const focusable = Array.from(actionDialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'));
    if (focusable.length === 0) { event.preventDefault(); return; }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const onReplaceKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (activeReplaceConfirmation === undefined) return;
    if (event.key === "Escape") { event.stopPropagation(); closeReplaceConfirmation(activeReplaceConfirmation, "cancelled"); return; }
    if (event.key !== "Tab" || replaceDialog.current === null) return;
    event.stopPropagation();
    const focusable = Array.from(replaceDialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'));
    if (focusable.length === 0) { event.preventDefault(); return; }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

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
      <div aria-label={t("projectFiles.actions")} className="project-files-actions" role="toolbar">
        {selected === undefined ? <span>{t("projectFiles.selectHint")}</span> : <strong title={selected.name}>{selected.name}</strong>}
        <a aria-disabled={selected === undefined} className={selected === undefined ? "is-disabled" : undefined} href={selected === undefined ? undefined : fileOpenUrl(draftId, projectId, selected)} rel="noopener noreferrer" target="_blank">{t("projectFiles.open")}</a>
        <a aria-disabled={selected === undefined} className={selected === undefined ? "is-disabled" : undefined} href={selected === undefined ? undefined : projectFileDownloadUrl(draftId, projectId, selected.name)} rel="noopener noreferrer" target="_blank">{t("projectFiles.download")}</a>
        <button disabled={selected === undefined} onClick={(event) => { if (selected !== undefined) beginAction(selected, "properties", event.currentTarget); }} type="button">{t("projectFiles.properties")}</button>
        <button disabled={readOnly || selected === undefined} onClick={(event) => { if (selected !== undefined) beginAction(selected, "rename", event.currentTarget); }} type="button">{t("projectFiles.rename")}</button>
        <button disabled={readOnly || selected === undefined} onClick={(event) => { if (selected !== undefined) beginAction(selected, "replace", event.currentTarget); }} type="button">{t("projectFiles.replaceWithNew")}</button>
        <button className="danger" disabled={readOnly || selected === undefined} onClick={(event) => { if (selected !== undefined) beginAction(selected, "delete", event.currentTarget); }} type="button">{t("projectFiles.delete")}</button>
      </div>
      {readOnly && <p className="project-files-readonly">{t("projectFiles.readOnly")}</p>}
      <div className={`project-files-dropzone${dragActive ? " is-dragging" : ""}`} onDragEnter={(event) => { event.preventDefault(); if (!readOnly) setDragActive(true); }} onDragLeave={() => setDragActive(false)} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        {t(readOnly ? "projectFiles.dropReadOnly" : "projectFiles.drop")}
      </div>
      {queue.length > 0 && <section aria-label={t("projectFiles.uploadQueue")} className="project-files-upload-queue">
        <div className="project-files-queue-heading"><strong>{t("projectFiles.uploadQueue")}</strong><button disabled={busyId !== null} onClick={() => setQueue((current) => current.filter((item) => item.state !== "success" && item.state !== "cancelled"))} type="button">{t("projectFiles.clearFinished")}</button></div>
        <ul>{queue.map((item) => {
          const percent = item.file.size === 0 ? (item.state === "success" ? 100 : 0) : Math.min(100, Math.round(item.loaded / item.file.size * 100));
          return <li className={`project-files-upload-item is-${item.state}`} data-upload-id={item.id} key={item.id} tabIndex={-1}>
            <div><strong title={item.name}>{item.name}</strong><span>{formatFileSize(locale, item.file.size)} · {t(`projectFiles.uploadState.${item.state}` as MessageKey)}</span></div>
            {(item.state === "uploading" || item.state === "success") && <progress aria-label={t("projectFiles.uploadProgress", { name: item.name })} max={100} value={percent}>{percent}%</progress>}
            {item.error !== undefined && <span className="project-files-upload-error" role="alert">{item.error}</span>}
            {item.state === "conflict" && <div className="project-files-conflict">
              <span>{t("projectFiles.nameConflict", { name: item.existingName ?? item.name })}</span>
              {item.existingName === item.name && <button onClick={(event) => { void chooseReplacement(item, event.currentTarget); }} type="button">{t("projectFiles.replace")}</button>}
              <label>{t("projectFiles.otherName")}<input aria-label={t("projectFiles.otherNameFor", { name: item.name })} defaultValue={item.name} key={`${item.id}:${item.name}`} /></label>
              <button onClick={(event) => { const input = event.currentTarget.previousElementSibling?.querySelector("input"); if (input instanceof HTMLInputElement) chooseName(item, input.value); }} type="button">{t("projectFiles.uploadOtherName")}</button>
            </div>}
            {item.state === "reference_check" && <span role="status">{t("projectFiles.referencesChecking")}</span>}
            <div className="project-files-upload-actions">
              {item.state === "error" && <button onClick={() => retry(item)} type="button">{t("status.retry")}</button>}
              {(item.state === "queued" || item.state === "uploading" || item.state === "confirmation" || item.state === "conflict" || item.state === "reference_check" || item.state === "replace_confirmation") && <button onClick={() => cancelItem(item)} type="button">{t("core.cancel")}</button>}
            </div>
          </li>;
        })}</ul>
      </section>}
      {loadState.status === "loading" && <div className="project-files-state" role="status"><span className="loading-indicator" aria-hidden="true" />{t("projectFiles.loading")}</div>}
      {loadState.status === "error" && <div className="alert error project-files-error" role="alert"><span>{t("projectFiles.loadError", { message: loadState.error })}</span><button onClick={onReload} type="button">{t("status.retry")}</button></div>}
      {loadState.status === "ready" && loadState.refreshError !== undefined && <div className="alert error project-files-error" role="alert"><span>{t("projectFiles.loadError", { message: loadState.refreshError })}</span><button onClick={onReload} type="button">{t("status.retry")}</button></div>}
      {readyList !== null && readyList.items.length === 0 && <div className="project-files-state project-files-empty"><strong>{t("projectFiles.emptyHeading")}</strong><span>{t("projectFiles.emptyDescription")}</span></div>}
      {readyList !== null && readyList.items.length > 0 && (view === "grid"
        ? <FileGrid actionMenuName={actionMenuName} draftId={draftId} items={readyList.items} locale={locale} onAction={beginMenuAction} onCloseMenu={() => setActionMenuName(undefined)} onToggleMenu={toggleActionMenu} projectId={projectId} readOnly={readOnly} selectedName={selectedName} t={t} />
        : <FileTable actionMenuName={actionMenuName} draftId={draftId} items={readyList.items} locale={locale} onAction={beginMenuAction} onCloseMenu={() => setActionMenuName(undefined)} onToggleMenu={toggleActionMenu} projectId={projectId} readOnly={readOnly} selectedName={selectedName} t={t} />)}
      {selected !== undefined && fileAction !== undefined && <div aria-labelledby="project-file-action-title" aria-modal="true" className="project-file-large-dialog" onKeyDown={onActionKeyDown} onMouseDown={(event) => { if (event.target === event.currentTarget && !actionBusy) closeAction(); }} ref={actionDialog} role="dialog">
        <div className="project-file-large-card project-file-action-card">
          <h3 id="project-file-action-title">{t(`projectFiles.${fileAction}Heading` as MessageKey)}</h3>
          {fileAction === "properties" && <dl className="project-file-properties">
            <div><dt>{t("projectFiles.name")}</dt><dd>{selected.name}</dd></div>
            <div><dt>{t("projectFiles.type")}</dt><dd>{FAMILY_LABEL[projectFileFamily(selected.name)]} · {selected.media_type}</dd></div>
            <div><dt>{t("projectFiles.size")}</dt><dd>{formatFileSize(locale, selected.size_bytes)} ({new Intl.NumberFormat(locale).format(selected.size_bytes)} B)</dd></div>
            <div><dt>{t("projectFiles.repositoryPath")}</dt><dd><code>{selected.path}</code></dd></div>
            <div><dt>{t("projectFiles.modified")}</dt><dd>{formatDateTime(locale, selected.modified_at)} · {t("projectFiles.workingCopySource")}</dd></div>
            {selected.created_at !== undefined && <div><dt>{t("projectFiles.created")}</dt><dd>{formatDateTime(locale, selected.created_at)} · {t("projectFiles.workingCopySource")}</dd></div>}
            <div><dt>{t("projectFiles.preview")}</dt><dd>{t(selected.disposition === "inline" ? "projectFiles.previewAvailable" : "projectFiles.downloadOnly")}</dd></div>
            <div><dt>{t("projectFiles.referenceCount")}</dt><dd>{referencePreview?.status === "loading" ? t("projectFiles.referencesChecking") : referencePreview?.status === "ready" ? String(referencePreview.value.count) : t("projectFiles.referencesUnknown")}</dd></div>
          </dl>}
          {fileAction === "properties" && referencePreview?.status === "ready" && referencePreview.value.locations.length > 0 && <ul>{referencePreview.value.locations.slice(0, 5).map((location) => <li key={`${location.path}:${location.start}`}>{location.entity_type} {location.entity_id} · {location.field}</li>)}</ul>}
          {fileAction === "properties" && referencePreview?.status === "error" && <div className="alert error" role="alert"><span>{t("projectFiles.referencesCheckFailed", { message: referencePreview.error })}</span><button onClick={() => loadActionReferences(selected.name)} type="button">{t("status.retry")}</button></div>}
          {fileAction === "rename" && <>
            <label>{t("projectFiles.newName")}<input autoFocus disabled={actionBusy} onChange={(event) => setActionValue(event.target.value)} value={actionValue} /></label>
            {extensionChanged && <p className="project-file-action-warning">{t("projectFiles.extensionWarning")}</p>}
            {referencePreview?.status === "loading" && <p role="status">{t("projectFiles.referencesChecking")}</p>}
            {referencePreview?.status === "error" && <div className="alert error" role="alert"><span>{t("projectFiles.referencesCheckFailed", { message: referencePreview.error })}</span><button onClick={() => loadActionReferences(selected.name)} type="button">{t("status.retry")}</button></div>}
            {referencePreview?.status === "ready" && <div className="project-file-reference-consequences">
              <p>{t("projectFiles.referencesFound", { count: referencePreview.value.count })}</p>
              <ul>{referencePreview.value.locations.slice(0, 5).map((location) => <li key={`${location.path}:${location.field}:${location.value_index ?? ""}:${location.start}`}>{location.entity_type} {location.entity_id} · {location.field}</li>)}</ul>
              <label><input checked={referenceChoice === "update"} name="rename-reference-mode" onChange={() => setReferenceChoice("update")} type="radio" />{t("projectFiles.renameUpdateReferences", { count: referencePreview.value.count })}</label>
              <label><input checked={referenceChoice === "keep"} name="rename-reference-mode" onChange={() => setReferenceChoice("keep")} type="radio" />{t("projectFiles.renameKeepReferences", { count: referencePreview.value.count })}</label>
            </div>}
          </>}
          {fileAction === "replace" && <>
            {referencePreview?.status === "loading" && <p role="status">{t("projectFiles.referencesChecking")}</p>}
            {referencePreview?.status === "error" && <div className="alert error" role="alert"><span>{t("projectFiles.referencesCheckFailed", { message: referencePreview.error })}</span><button onClick={() => loadActionReferences(selected.name)} type="button">{t("status.retry")}</button></div>}
            {referencePreview?.status === "ready" && <div className="project-file-reference-consequences"><p>{t("projectFiles.referencesFound", { count: referencePreview.value.count })}</p><ul>{referencePreview.value.locations.slice(0, 5).map((location) => <li key={`${location.path}:${location.field}:${location.value_index ?? ""}:${location.start}`}>{location.entity_type} {location.entity_id} · {location.field}</li>)}</ul></div>}
            <label>{t("projectFiles.replaceSelectFile")}<input autoFocus disabled={actionBusy} onChange={(event) => { setReplacementFile(event.currentTarget.files?.[0]); setReplacementConfirmation(""); setReplacementProgress(0); }} type="file" /></label>
            {replacementFile !== undefined && <>
              <p>{t(replacementFile.name === selected.name ? "projectFiles.replaceSameNameSummary" : "projectFiles.replaceNewNameSummary", { oldName: selected.name, newName: replacementFile.name, count: referencePreview?.status === "ready" ? referencePreview.value.count : 0 })}</p>
              {list?.items.some((item) => item.name !== selected.name && comparableName(item.name) === comparableName(replacementFile.name)) === true && <p className="project-file-action-warning" role="alert">{t("projectFiles.replaceNameConflict", { name: replacementFile.name })}</p>}
              {replacementFile.size > PROJECT_FILE_LARGE_WARNING_BYTES && <label>{t("projectFiles.largeTypeName", { name: replacementFile.name })}<input disabled={actionBusy} onChange={(event) => setReplacementConfirmation(event.target.value)} value={replacementConfirmation} /></label>}
              {actionBusy && <progress aria-label={t("projectFiles.uploadProgress", { name: replacementFile.name })} max={replacementFile.size || 1} value={replacementProgress} />}
            </>}
          </>}
          {fileAction === "delete" && <>
            <p>{t("projectFiles.deleteGitWarning", { name: selected.name })}</p>
            {referencePreview?.status === "loading" && <p role="status">{t("projectFiles.referencesChecking")}</p>}
            {referencePreview?.status === "error" && <div className="alert error" role="alert"><span>{t("projectFiles.referencesCheckFailed", { message: referencePreview.error })}</span><button onClick={() => loadActionReferences(selected.name)} type="button">{t("status.retry")}</button></div>}
            {referencePreview?.status === "ready" && <div className="project-file-reference-consequences"><p>{t("projectFiles.referencesFound", { count: referencePreview.value.count })}</p><ul>{referencePreview.value.locations.slice(0, 5).map((location) => <li key={`${location.path}:${location.field}:${location.value_index ?? ""}:${location.start}`}>{location.entity_type} {location.entity_id} · {location.field}</li>)}</ul>{referencePreview.value.count > 0 && <label><input checked={referenceChoice === "unlink"} disabled={actionBusy} onChange={(event) => setReferenceChoice(event.target.checked ? "unlink" : "restrict")} type="checkbox" />{t("projectFiles.deleteUnlinkReferences", { count: referencePreview.value.count })}</label>}</div>}
            <label>{t("projectFiles.deleteTypeName", { name: selected.name })}<input autoFocus disabled={actionBusy} onChange={(event) => setActionValue(event.target.value)} value={actionValue} /></label>
          </>}
          {actionError !== undefined && <div className="alert error" role="alert">{actionError}</div>}
          <div className="project-file-large-actions"><button autoFocus={fileAction === "properties"} disabled={actionBusy && fileAction !== "replace"} onClick={() => { if (actionBusy && fileAction === "replace") activeController.current?.abort(); closeAction(); }} type="button">{t(fileAction === "properties" ? "core.closeEditor" : "core.cancel")}</button>{fileAction === "rename" && <button className="primary" disabled={actionBusy || referencePreview?.status !== "ready" || actionValue === selected.name || actionValue === ""} onClick={() => { void renameSelected(); }} type="button">{t("projectFiles.rename")}</button>}{fileAction === "replace" && <button className="primary" disabled={actionBusy || referencePreview?.status !== "ready" || replacementFile === undefined || (replacementFile.size > PROJECT_FILE_LARGE_WARNING_BYTES && replacementConfirmation !== replacementFile.name) || list?.items.some((item) => item.name !== selected.name && comparableName(item.name) === comparableName(replacementFile.name)) === true} onClick={() => { void replaceSelected(); }} type="button">{t("projectFiles.replaceConfirm")}</button>}{fileAction === "delete" && <button className="danger" disabled={actionBusy || referencePreview?.status !== "ready" || actionValue !== selected.name || (referencePreview.value.count > 0 && referenceChoice !== "unlink")} onClick={() => { void deleteSelected(); }} type="button">{t("projectFiles.delete")}</button>}</div>
        </div>
      </div>}
      {activeConfirmation !== undefined && <div aria-labelledby="project-file-large-title" aria-modal="true" className="project-file-large-dialog" onKeyDown={(event) => { if (event.key === "Escape") cancelItem(activeConfirmation); }} role="dialog">
        <div className="project-file-large-card">
          <h3 id="project-file-large-title">{t("projectFiles.largeHeading")}</h3>
          <p>{t("projectFiles.largeDetails", { name: activeConfirmation.name, size: formatFileSize(locale, activeConfirmation.file.size) })}</p>
          <p>{t("projectFiles.largeGitWarning")}</p>
          <label>{t("projectFiles.largeTypeName", { name: activeConfirmation.name })}<input autoFocus onChange={(event) => setConfirmation(event.target.value)} value={confirmation} /></label>
          <div className="project-file-large-actions"><button onClick={() => cancelItem(activeConfirmation)} type="button">{t("core.cancel")}</button><button className="primary" disabled={confirmation !== activeConfirmation.name} onClick={() => confirmLarge(activeConfirmation)} type="button">{t("projectFiles.largeConfirm")}</button></div>
        </div>
      </div>}
      {activeReplaceConfirmation !== undefined && <div aria-labelledby="project-file-replace-title" aria-modal="true" className="project-file-large-dialog" onKeyDown={onReplaceKeyDown} onMouseDown={(event) => { if (event.target === event.currentTarget) closeReplaceConfirmation(activeReplaceConfirmation, "cancelled"); }} ref={replaceDialog} role="dialog">
        <div className="project-file-large-card">
          <h3 id="project-file-replace-title">{t("projectFiles.replaceHeading")}</h3>
          <p>{t("projectFiles.replaceReferencesPreserved", { name: activeReplaceConfirmation.name, count: activeReplaceConfirmation.referencePreview?.count ?? 0 })}</p>
          <ul>{activeReplaceConfirmation.referencePreview?.locations.slice(0, 5).map((location) => <li key={`${location.path}:${location.start}`}>{location.entity_type} {location.entity_id} · {location.field}</li>)}</ul>
          <div className="project-file-large-actions"><button autoFocus onClick={() => closeReplaceConfirmation(activeReplaceConfirmation, "cancelled")} type="button">{t("core.cancel")}</button><button className="primary" onClick={() => closeReplaceConfirmation(activeReplaceConfirmation, "queued")} type="button">{t("projectFiles.replaceConfirm")}</button></div>
        </div>
      </div>}
    </div>
  </EditorDrawer>;
}
