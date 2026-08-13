import type { ProjectFileItem, ProjectFileList } from "@gitpm/contracts";
import type { AsyncLoadState } from "../../async-data.js";
import { EditorDrawer } from "../../editor-drawer.js";
import { formatDateTime, message, type Locale, type MessageKey } from "../../i18n.js";

export type ProjectFilesView = "grid" | "table";

export const PROJECT_FILES_VIEW_COOKIE = "gitpm.projectFiles.view";
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

export function ProjectFilesPanel({ locale, list, loadState, onClose, onReload, onViewChange, open, view }: {
  readonly locale: Locale;
  readonly list: ProjectFileList | null;
  readonly loadState: AsyncLoadState;
  readonly onClose: () => void;
  readonly onReload: () => void;
  readonly onViewChange: (view: ProjectFilesView) => void;
  readonly open: boolean;
  readonly view: ProjectFilesView;
}) {
  const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message(locale, key, values);
  const setView = (next: ProjectFilesView) => { writeProjectFilesView(next); onViewChange(next); };
  const readyList = loadState.status === "ready" ? list : null;

  return <EditorDrawer closeLabel={t("projectFiles.close")} onClose={onClose} open={open} title={t("projectFiles.heading", { count: list?.count ?? 0 })}>
    <div className="project-files-panel">
      <div className="project-files-toolbar">
        <button disabled={loadState.status === "loading"} onClick={onReload} type="button">{t("projectFiles.refresh")}</button>
        <div aria-label={t("projectFiles.viewLabel")} className="project-files-view-switch" role="group">
          <button aria-label={t("projectFiles.gridView")} aria-pressed={view === "grid"} onClick={() => setView("grid")} title={t("projectFiles.gridView")} type="button">▦</button>
          <button aria-label={t("projectFiles.tableView")} aria-pressed={view === "table"} onClick={() => setView("table")} title={t("projectFiles.tableView")} type="button">☷</button>
        </div>
      </div>
      {loadState.status === "loading" && <div className="project-files-state" role="status"><span className="loading-indicator" aria-hidden="true" />{t("projectFiles.loading")}</div>}
      {loadState.status === "error" && <div className="alert error project-files-error" role="alert"><span>{t("projectFiles.loadError", { message: loadState.error })}</span><button onClick={onReload} type="button">{t("status.retry")}</button></div>}
      {loadState.status === "ready" && loadState.refreshError !== undefined && <div className="alert error project-files-error" role="alert"><span>{t("projectFiles.loadError", { message: loadState.refreshError })}</span><button onClick={onReload} type="button">{t("status.retry")}</button></div>}
      {readyList !== null && readyList.items.length === 0 && <div className="project-files-state project-files-empty"><strong>{t("projectFiles.emptyHeading")}</strong><span>{t("projectFiles.emptyDescription")}</span></div>}
      {readyList !== null && readyList.items.length > 0 && (view === "grid"
        ? <FileGrid items={readyList.items} locale={locale} t={t} />
        : <FileTable items={readyList.items} locale={locale} t={t} />)}
    </div>
  </EditorDrawer>;
}
