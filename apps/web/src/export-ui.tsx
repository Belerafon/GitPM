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

const REPORT_SECTIONS: readonly { readonly id: ExportSection; readonly label: MessageKey }[] = [
  { id: "projects", label: "export.projects" },
  { id: "people", label: "export.people" },
  { id: "project-details", label: "export.projectDetails" },
  { id: "gantt", label: "export.gantt" },
  { id: "plan-fact", label: "export.planFact" },
  { id: "workload", label: "export.workload" },
  { id: "vacations", label: "export.vacations" },
  { id: "person-profile", label: "export.personProfile" },
  { id: "audit", label: "export.audit" },
];

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
  const [includeEmail, setIncludeEmail] = useState(false);
  const [lifecycle, setLifecycle] = useState<"active" | "archived" | "all">("active");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usesSections = format === "pdf" || format === "html" || format === "csv" || format === "xlsx";
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
        ...(usesSections ? { sections: [...selected], lifecycle, includeEmail } : {}),
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
        <option value="xlsx">{t("export.xlsx")}</option>
        <option value="repository">{t("export.repository")}</option>
      </select></label>
      {usesSections && <fieldset><legend>{t("export.pdfSections")}</legend>
        {REPORT_SECTIONS.map((section) => <label key={section.id}><input type="checkbox" checked={selected.has(section.id)} onChange={(event) => toggle(section.id, event.target.checked)} />{t(section.label)}</label>)}
      </fieldset>}
      {usesSections && <label data-field-hint={t("fieldHint.exportLifecycle")}>{t("export.lifecycle")}<select value={lifecycle} onChange={(event) => setLifecycle(event.target.value as "active" | "archived" | "all")}>
        <option value="active">{t("export.lifecycleActive")}</option>
        <option value="archived">{t("export.lifecycleArchived")}</option>
        <option value="all">{t("export.lifecycleAll")}</option>
      </select></label>}
      {usesSections && <label><input type="checkbox" checked={includeEmail} onChange={(event) => setIncludeEmail(event.target.checked)} />{t("export.includeEmail")}</label>}
      {format === "html" && <p>{t("export.htmlHint")}</p>}
      {format === "csv" && <p>{t("export.csvHint")}</p>}
      {format === "xlsx" && <p>{t("export.xlsxHint")}</p>}
      {format === "repository" && <label><input type="checkbox" checked={includeGit} onChange={(event) => setIncludeGit(event.target.checked)} />{t("export.includeGit")}</label>}
      {error !== null && <div className="alert error">{error}</div>}
      <button className="primary" disabled={busy || (usesSections && selected.size === 0)} onClick={() => { void download(); }} type="button">{busy ? t("export.preparing") : t("export.download")}</button>
    </div>
  </details>;
}
