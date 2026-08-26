import type { FastifyInstance } from "fastify";
import type { DraftManager } from "@gitpm/drafts";
import {
  EXPORT_FORMATS,
  EXPORT_SECTIONS,
  ExportError,
  ISO_DATE,
  isExportDensity,
  isExportLifecycle,
  isExportPageSize,
  isExportScope,
  isExportTimeEntryState,
  type ExportArtifact,
  type ExportFormat,
  type ExportLocale,
  type ExportRequest,
  type ExportSection,
} from "@gitpm/export";
import { requireDraftRead, type Authenticate } from "./draft-api.js";

export interface ExportProvider {
  create(draftId: string, request: ExportRequest): Promise<ExportArtifact>;
}

interface ExportQuery {
  readonly format?: string;
  readonly locale?: string;
  readonly sections?: string;
  readonly include_git?: string;
  readonly scope?: string;
  readonly project?: string;
  readonly person?: string;
  readonly team?: string;
  readonly as_of?: string;
  readonly period_start?: string;
  readonly period_finish?: string;
  readonly lifecycle?: string;
  readonly time_entry_state?: string;
  readonly include_email?: string;
  readonly hide_personal_data?: string;
  readonly page_size?: string;
  readonly density?: string;
  readonly report_title?: string;
}

function optionalBoolean(value: string | undefined, code: string, message: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== "true" && value !== "false") throw new ExportError(code, message);
  return value === "true";
}

function exportRequest(query: ExportQuery): ExportRequest {
  if (query.format === undefined || !EXPORT_FORMATS.includes(query.format as ExportFormat)) {
    throw new ExportError("EXPORT_FORMAT_INVALID", "format must be pdf, html, csv, xlsx or repository");
  }
  if (query.locale !== undefined && query.locale !== "en" && query.locale !== "ru") {
    throw new ExportError("EXPORT_LOCALE_INVALID", "locale must be en or ru");
  }
  const sections = query.sections === undefined || query.sections === ""
    ? undefined
    : query.sections.split(",").filter(Boolean);
  if (sections?.some((section) => !EXPORT_SECTIONS.includes(section as ExportSection)) === true) {
    throw new ExportError("EXPORT_SECTION_INVALID", "sections contains an unsupported value");
  }
  if (query.scope !== undefined && !isExportScope(query.scope)) throw new ExportError("EXPORT_SCOPE_INVALID", "scope must be portfolio, project, person or team");
  if (query.lifecycle !== undefined && !isExportLifecycle(query.lifecycle)) throw new ExportError("EXPORT_LIFECYCLE_INVALID", "lifecycle must be active, archived or all");
  if (query.time_entry_state !== undefined && !isExportTimeEntryState(query.time_entry_state)) {
    throw new ExportError("EXPORT_TIME_ENTRY_STATE_INVALID", "time_entry_state must be active, voided or all");
  }
  if (query.page_size !== undefined && !isExportPageSize(query.page_size)) throw new ExportError("EXPORT_PAGE_SIZE_INVALID", "page_size must be A4 or Letter");
  if (query.density !== undefined && !isExportDensity(query.density)) throw new ExportError("EXPORT_DENSITY_INVALID", "density must be compact or detailed");
  for (const value of [query.as_of, query.period_start, query.period_finish]) {
    if (value !== undefined && !ISO_DATE.test(value)) throw new ExportError("EXPORT_DATE_INVALID", "dates must use YYYY-MM-DD");
  }
  const includeGit = optionalBoolean(query.include_git, "EXPORT_INCLUDE_GIT_INVALID", "include_git must be true or false");
  const includeEmail = optionalBoolean(query.include_email, "EXPORT_INCLUDE_EMAIL_INVALID", "include_email must be true or false");
  const hidePersonalData = optionalBoolean(query.hide_personal_data, "EXPORT_HIDE_PERSONAL_DATA_INVALID", "hide_personal_data must be true or false");
  return {
    format: query.format as ExportFormat,
    ...(query.locale === undefined ? {} : { locale: query.locale as ExportLocale }),
    ...(sections === undefined ? {} : { sections: sections as ExportSection[] }),
    ...(includeGit === undefined ? {} : { include_git: includeGit }),
    ...(query.scope === undefined ? {} : { scope: query.scope as ExportRequest["scope"] }),
    ...(query.project === undefined ? {} : { project: query.project }),
    ...(query.person === undefined ? {} : { person: query.person }),
    ...(query.team === undefined ? {} : { team: query.team }),
    ...(query.as_of === undefined ? {} : { as_of: query.as_of }),
    ...(query.period_start === undefined ? {} : { period_start: query.period_start }),
    ...(query.period_finish === undefined ? {} : { period_finish: query.period_finish }),
    ...(query.lifecycle === undefined ? {} : { lifecycle: query.lifecycle as ExportRequest["lifecycle"] }),
    ...(query.time_entry_state === undefined ? {} : { time_entry_state: query.time_entry_state as ExportRequest["time_entry_state"] }),
    ...(includeEmail === undefined ? {} : { include_email: includeEmail }),
    ...(hidePersonalData === undefined ? {} : { hide_personal_data: hidePersonalData }),
    ...(query.page_size === undefined ? {} : { page_size: query.page_size as ExportRequest["page_size"] }),
    ...(query.density === undefined ? {} : { density: query.density as ExportRequest["density"] }),
    ...(query.report_title === undefined ? {} : { report_title: query.report_title }),
  };
}

export function registerExportApi(
  app: FastifyInstance,
  manager: DraftManager,
  service: ExportProvider,
  authenticate: Authenticate,
): void {
  app.get<{ Params: { draftId: string }; Querystring: ExportQuery }>(
    "/api/drafts/:draftId/export",
    async (request, reply) => {
      const actor = await authenticate(request);
      await requireDraftRead(manager, actor, request.params.draftId);
      const artifact = await service.create(request.params.draftId, exportRequest(request.query));
      reply.header("cache-control", "no-store");
      reply.header("content-disposition", `attachment; filename="${artifact.filename}"`);
      reply.type(artifact.content_type);
      return await reply.send(artifact.content);
    },
  );
}
