import { useState } from "react";
import type { ExportFormat, ExportSection, GitPmApi } from "./api.js";
import { formatApiError } from "./api.js";
import { message, type Locale, type MessageKey } from "./i18n.js";

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ExportMenu({ api, draftId, locale, save = saveBlob }: {
  readonly api: GitPmApi;
  readonly draftId: string;
  readonly locale: Locale;
  readonly save?: (blob: Blob, filename: string) => void;
}) {
  const t = (key: MessageKey) => message(locale, key);
  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [selected, setSelected] = useState<ReadonlySet<ExportSection>>(() => new Set(["projects", "people"]));
  const [includeGit, setIncludeGit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (section: ExportSection, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(section); else next.delete(section);
      return next;
    });
  };
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      if (api.exportData === undefined) throw new Error("Export API is unavailable");
      const artifact = await api.exportData(draftId, {
        format,
        locale: locale === "ru" ? "ru" : "en",
        ...(format === "pdf" ? { sections: [...selected] } : {}),
        ...(format === "repository" ? { includeGit } : {}),
      });
      save(artifact.blob, artifact.filename);
    } catch (reason) {
      setError(formatApiError(reason));
    } finally {
      setBusy(false);
    }
  };
  return <details className="export-menu">
    <summary>{t("export.open")}</summary>
    <div className="export-menu-panel">
      <strong>{t("export.heading")}</strong>
      <label>{t("export.format")}<select value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}>
        <option value="pdf">{t("export.pdf")}</option>
        <option value="html">{t("export.html")}</option>
        <option value="csv">{t("export.csv")}</option>
        <option value="repository">{t("export.repository")}</option>
      </select></label>
      {format === "pdf" && <fieldset><legend>{t("export.pdfSections")}</legend>
        <label><input type="checkbox" checked={selected.has("projects")} onChange={(event) => toggle("projects", event.target.checked)} />{t("export.projects")}</label>
        <label><input type="checkbox" checked={selected.has("people")} onChange={(event) => toggle("people", event.target.checked)} />{t("export.people")}</label>
        <label><input type="checkbox" checked={selected.has("project-details")} onChange={(event) => toggle("project-details", event.target.checked)} />{t("export.projectDetails")}</label>
        <label><input type="checkbox" checked={selected.has("gantt")} onChange={(event) => toggle("gantt", event.target.checked)} />{t("export.gantt")}</label>
      </fieldset>}
      {format === "html" && <p>{t("export.htmlHint")}</p>}
      {format === "csv" && <p>{t("export.csvHint")}</p>}
      {format === "repository" && <label><input type="checkbox" checked={includeGit} onChange={(event) => setIncludeGit(event.target.checked)} />{t("export.includeGit")}</label>}
      {error !== null && <div className="alert error">{error}</div>}
      <button className="primary" disabled={busy || (format === "pdf" && selected.size === 0)} onClick={() => { void download(); }} type="button">{busy ? t("export.preparing") : t("export.download")}</button>
    </div>
  </details>;
}
