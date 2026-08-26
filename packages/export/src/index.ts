import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DraftManager } from "@gitpm/drafts";
import type { GitClient } from "@gitpm/git-client";
import { parseYamlDocument } from "@gitpm/repository-format";
import { discoverRepositoryFiles, validateRepository } from "@gitpm/validation";
import { renderCsvZip } from "./csv.js";
import type { ExportDocument } from "./documents.js";
import { renderHtml } from "./html.js";
import { buildExportReportModel, type ExportSnapshot } from "./model.js";
import { renderPdf } from "./pdf.js";
import { repositoryZip } from "./repository.js";
import {
  ExportError,
  ISO_DATE,
  isExportDensity,
  isExportFormat,
  isExportLifecycle,
  isExportPageSize,
  isExportScope,
  isExportSection,
  isExportTimeEntryState,
  type ExportArtifact,
  type ExportRequest,
} from "./types.js";
import { renderXlsx } from "./xlsx.js";

export {
  EXPORT_DENSITIES,
  EXPORT_FORMATS,
  EXPORT_LEGACY_SECTIONS,
  EXPORT_LIFECYCLES,
  EXPORT_PAGE_SIZES,
  EXPORT_REPORTS,
  EXPORT_SCOPES,
  EXPORT_SECTIONS,
  EXPORT_TIME_ENTRY_STATES,
  ExportError,
  ISO_DATE,
  isExportDensity,
  isExportFormat,
  isExportLifecycle,
  isExportPageSize,
  isExportScope,
  isExportSection,
  isExportTimeEntryState,
  type ExportArtifact,
  type ExportDensity,
  type ExportFormat,
  type ExportLifecycle,
  type ExportLocale,
  type ExportPageSize,
  type ExportProvider,
  type ExportReport,
  type ExportRequest,
  type ExportScope,
  type ExportSection,
  type ExportTimeEntryState,
} from "./types.js";
export { buildExportReportModel, type ExportReportModel } from "./model.js";
export { createZip, type ZipEntry } from "./zip.js";


function slugDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new ExportError("EXPORT_COMMIT_METADATA_INVALID", "Commit date is invalid");
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function validateRequest(request: ExportRequest): void {
  if (!isExportFormat(request.format)) throw new ExportError("EXPORT_FORMAT_INVALID", `Unsupported export format ${String(request.format)}`);
  const locale = request.locale ?? "en";
  if (locale !== "en" && locale !== "ru") throw new ExportError("EXPORT_LOCALE_INVALID", `Unsupported export locale ${String(locale)}`);
  for (const section of request.sections ?? []) {
    if (!isExportSection(section)) throw new ExportError("EXPORT_SECTION_INVALID", `Unsupported export section ${section}`);
  }
  if (request.scope !== undefined && !isExportScope(request.scope)) throw new ExportError("EXPORT_SCOPE_INVALID", `Unsupported export scope ${request.scope}`);
  if (request.lifecycle !== undefined && !isExportLifecycle(request.lifecycle)) throw new ExportError("EXPORT_LIFECYCLE_INVALID", `Unsupported lifecycle ${request.lifecycle}`);
  if (request.time_entry_state !== undefined && !isExportTimeEntryState(request.time_entry_state)) {
    throw new ExportError("EXPORT_TIME_ENTRY_STATE_INVALID", `Unsupported time entry state ${request.time_entry_state}`);
  }
  if (request.page_size !== undefined && !isExportPageSize(request.page_size)) throw new ExportError("EXPORT_PAGE_SIZE_INVALID", `Unsupported page size ${request.page_size}`);
  if (request.density !== undefined && !isExportDensity(request.density)) throw new ExportError("EXPORT_DENSITY_INVALID", `Unsupported density ${request.density}`);
  for (const value of [request.as_of, request.period_start, request.period_finish]) {
    if (value !== undefined && !ISO_DATE.test(value)) throw new ExportError("EXPORT_DATE_INVALID", `Invalid export date ${value}`);
  }
}

export class ExportService {
  constructor(
    private readonly drafts: DraftManager,
    private readonly git: GitClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async snapshot(draftId: string, requireValidDocuments: boolean, historyLimit: number): Promise<ExportSnapshot> {
    const workspace = await this.drafts.getWorkspace(draftId);
    const history = await this.git.history(workspace.worktree_path, historyLimit);
    const commit = history[0];
    if (commit === undefined) throw new ExportError("EXPORT_COMMIT_UNAVAILABLE", "Repository has no commit");
    let documents: readonly ExportDocument[] = [];
    if (requireValidDocuments) {
      const [discovery, validation] = await Promise.all([
        discoverRepositoryFiles(workspace.worktree_path),
        validateRepository(workspace.worktree_path),
      ]);
      const firstIssue = discovery.issues[0] ?? validation.errors[0];
      if (firstIssue !== undefined) {
        throw new ExportError("EXPORT_REPOSITORY_INVALID", `Repository validation failed: ${firstIssue.code} at ${firstIssue.path}`);
      }
      documents = await Promise.all(discovery.files.map(async (absolute): Promise<ExportDocument> => {
        const relative = path.relative(workspace.worktree_path, absolute).split(path.sep).join("/");
        return { path: relative, document: parseYamlDocument(await readFile(absolute, "utf8"), relative) };
      }));
    }
    return {
      commit: commit.commit,
      shortCommit: commit.commit.slice(0, 8),
      commitDate: commit.authored_at,
      generatedAt: this.now().toISOString(),
      root: workspace.worktree_path,
      documents,
      history,
    };
  }

  async create(draftId: string, request: ExportRequest): Promise<ExportArtifact> {
    validateRequest(request);
    const wantsAudit = request.sections?.includes("audit") === true || request.sections === undefined || request.sections.length === 0;
    const snapshot = await this.snapshot(draftId, request.format !== "repository", wantsAudit && request.format !== "repository" ? 50 : 1);
    const base = `gitpm-${slugDate(snapshot.commitDate)}-${snapshot.shortCommit}`;
    if (request.format === "repository") {
      const includeGit = request.include_git ?? false;
      return {
        content: await repositoryZip(snapshot.root, includeGit),
        content_type: "application/zip",
        filename: `${base}-repository${includeGit ? "-with-git" : ""}.zip`,
      };
    }
    const model = buildExportReportModel(snapshot, request);
    if (request.format === "pdf") {
      return { content: await renderPdf(model), content_type: "application/pdf", filename: `${base}-portfolio.pdf` };
    }
    if (request.format === "html") {
      return { content: renderHtml(model), content_type: "text/html; charset=utf-8", filename: `${base}-static.html` };
    }
    if (request.format === "xlsx") {
      return {
        content: renderXlsx(model),
        content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename: `${base}-reports.xlsx`,
      };
    }
    return { content: renderCsvZip(model), content_type: "application/zip", filename: `${base}-csv.zip` };
  }
}
