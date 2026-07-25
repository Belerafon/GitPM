import type { FastifyInstance } from "fastify";
import type { DraftManager } from "@gitpm/drafts";
import {
  EXPORT_FORMATS,
  EXPORT_SECTIONS,
  ExportError,
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
}

function exportRequest(query: ExportQuery): ExportRequest {
  if (query.format === undefined || !EXPORT_FORMATS.includes(query.format as ExportFormat)) {
    throw new ExportError("EXPORT_FORMAT_INVALID", "format must be pdf, html, csv or repository");
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
  if (query.include_git !== undefined && query.include_git !== "true" && query.include_git !== "false") {
    throw new ExportError("EXPORT_INCLUDE_GIT_INVALID", "include_git must be true or false");
  }
  return {
    format: query.format as ExportFormat,
    ...(query.locale === undefined ? {} : { locale: query.locale as ExportLocale }),
    ...(sections === undefined ? {} : { sections: sections as ExportSection[] }),
    ...(query.include_git === undefined ? {} : { include_git: query.include_git === "true" }),
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
