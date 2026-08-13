import { formatProjectFileReference, resolveProjectFileReference, tokenizeProjectFileReferences } from "@gitpm/shared";
import type { ProjectFileItem, ProjectFileList } from "@gitpm/contracts";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { projectFileContentUrl, projectFileDownloadUrl } from "./api.js";
import type { AsyncLoadState } from "./async-data.js";
import { message, type Locale, type MessageKey } from "./i18n.js";

export interface ProjectFileReferenceContext {
  readonly draftId: string;
  readonly projectId: string;
  readonly files: ProjectFileList | null;
  readonly loadState: AsyncLoadState;
  readonly locale: Locale;
  readonly onReload: () => void;
}

function fileUrl(context: ProjectFileReferenceContext, item: ProjectFileItem): string {
  return item.disposition === "inline"
    ? projectFileContentUrl(context.draftId, context.projectId, item.name)
    : projectFileDownloadUrl(context.draftId, context.projectId, item.name);
}

export function renderProjectFileReferenceText(source: string, context: ProjectFileReferenceContext): ReactNode[] {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(context.locale, key, values);
  const names = context.files?.items.map((item) => item.name) ?? [];
  return tokenizeProjectFileReferences(source).map((segment, index) => {
    if (segment.kind === "text") return segment.value;
    if (context.loadState.status !== "ready" || context.files === null) {
      return <span aria-label={t("projectFileReferences.unavailableLabel", { name: segment.name })} className="project-file-reference unavailable" key={`${segment.start}:${index}`} title={t("projectFileReferences.unavailableTitle")}>{segment.raw}</span>;
    }
    if (resolveProjectFileReference(segment.name, names) === "missing") {
      return <span aria-label={t("projectFileReferences.missingLabel", { name: segment.name })} className="project-file-reference missing" key={`${segment.start}:${index}`} role="note" title={t("projectFileReferences.missingTitle", { name: segment.name })}>⚠ {segment.name}</span>;
    }
    const item = context.files!.items.find((candidate) => candidate.name === segment.name)!;
    return <a aria-label={t(item.disposition === "inline" ? "projectFiles.openNamed" : "projectFiles.downloadNamed", { name: item.name })} className="project-file-reference" href={fileUrl(context, item)} key={`${segment.start}:${index}`} rel="noopener noreferrer" target="_blank">📎 {item.name}</a>;
  });
}

export function ProjectFileMarkdownField({ context, defaultValue, disabled, label, name, onValueChange, value }: {
  readonly context?: ProjectFileReferenceContext;
  readonly defaultValue?: string;
  readonly disabled: boolean;
  readonly label: string;
  readonly name?: string;
  readonly onValueChange?: (value: string) => void;
  readonly value?: string;
}) {
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const labelId = useId();
  const pickerId = useId();
  const [pickerOpen, setPickerOpen] = useState(false);
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(context?.locale ?? "en", key, values);
  const insert = (item: ProjectFileItem) => {
    const control = textarea.current;
    if (control === null) return;
    const start = control.selectionStart;
    const end = control.selectionEnd;
    const reference = formatProjectFileReference(item.name);
    const next = `${control.value.slice(0, start)}${reference}${control.value.slice(end)}`;
    if (onValueChange === undefined) control.value = next;
    else onValueChange(next);
    setPickerOpen(false);
    requestAnimationFrame(() => {
      control.focus();
      control.setSelectionRange(start + reference.length, start + reference.length);
    });
  };
  const closePicker = () => {
    setPickerOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const handlePickerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closePicker();
  };
  return <div className="project-file-markdown-field">
    <div className="project-file-markdown-label"><span id={labelId}>{label}</span>{context !== undefined && <button aria-controls={pickerOpen ? pickerId : undefined} aria-expanded={pickerOpen} aria-label={t("projectFileReferences.insert")} disabled={disabled} onClick={() => setPickerOpen((current) => !current)} ref={trigger} title={t("projectFileReferences.insertHint")} type="button">📎 {t("projectFileReferences.insert")}</button>}</div>
    <textarea {...(value === undefined ? { defaultValue } : { value, onChange: (event) => onValueChange?.(event.target.value) })} aria-labelledby={labelId} disabled={disabled} name={name} ref={textarea} />
    {pickerOpen && context !== undefined && <div className="project-file-reference-picker" id={pickerId} onKeyDown={handlePickerKeyDown}>
      {context.loadState.status === "loading" && <span role="status">{t("projectFileReferences.loading")}</span>}
      {context.loadState.status === "error" && <div className="alert error" role="alert">{t("projectFileReferences.loadError", { message: context.loadState.error })}<button onClick={context.onReload} type="button">{t("status.retry")}</button></div>}
      {context.loadState.status === "ready" && context.loadState.refreshError !== undefined && <div className="alert error" role="alert">{t("projectFileReferences.loadError", { message: context.loadState.refreshError })}<button onClick={context.onReload} type="button">{t("status.retry")}</button></div>}
      {context.loadState.status === "ready" && context.files !== null && context.files.items.length === 0 && <span>{t("projectFileReferences.empty")}</span>}
      {context.files !== null && context.files.items.length > 0 && <div aria-label={t("projectFileReferences.listLabel")} className="project-file-reference-options" role="group">{context.files.items.map((item) => <button aria-label={t("projectFileReferences.insertNamed", { name: item.name })} key={item.name} onClick={() => insert(item)} title={item.name} type="button">📎 <span>{item.name}</span></button>)}</div>}
    </div>}
  </div>;
}
