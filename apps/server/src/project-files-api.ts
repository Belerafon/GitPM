import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DraftManager } from "@gitpm/drafts";
import { ProjectFileOperationError, type ProjectFileStore } from "@gitpm/domain";
import type { Authenticate } from "./draft-api.js";
import { requireDraftRead } from "./draft-api.js";

const FILE_NAME_HEADER = "x-gitpm-file-name";
const UPLOAD_SIZE_HEADER = "x-gitpm-upload-size";
const EXPECTED_FINGERPRINT_HEADER = "x-gitpm-expected-fingerprint";
const UPLOAD_MODE_HEADER = "x-gitpm-upload-mode";
const LARGE_CONFIRMATION_HEADER = "x-gitpm-large-file-confirmation";

function contentDisposition(disposition: "inline" | "attachment", name: string): string {
  const withoutControls = name.replace(/[\u0000-\u001f\u007f]/gu, "_");
  const fallback = withoutControls.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_") || "download";
  const encoded = encodeURIComponent(withoutControls)
    .replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function authorize(
  manager: DraftManager,
  authenticate: Authenticate,
  request: Parameters<Authenticate>[0],
  draftId: string,
): Promise<void> {
  const actor = await authenticate(request);
  await requireDraftRead(manager, actor, draftId);
}

function singleHeader(request: FastifyRequest, name: string, required = true): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value) || (required && (typeof value !== "string" || value === ""))) {
    throw new ProjectFileOperationError("PROJECT_FILE_UPLOAD_METADATA_INVALID", `Upload header ${name} is invalid`);
  }
  return typeof value === "string" ? value : undefined;
}

function encodedName(request: FastifyRequest, header: string, required = true): string | undefined {
  const value = singleHeader(request, header, required);
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ProjectFileOperationError("PROJECT_FILE_UPLOAD_METADATA_INVALID", `Upload header ${header} is not valid percent-encoded UTF-8`);
  }
}

function uploadSize(request: FastifyRequest): number {
  const value = singleHeader(request, UPLOAD_SIZE_HEADER)!;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new ProjectFileOperationError("PROJECT_FILE_UPLOAD_METADATA_INVALID", "Upload size must be a non-negative decimal integer");
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size)) {
    throw new ProjectFileOperationError("PROJECT_FILE_UPLOAD_METADATA_INVALID", "Upload size exceeds the supported integer range");
  }
  return size;
}

function requireMutationRole(role: string): void {
  if (role !== "Developer" && role !== "Maintainer") {
    throw new ProjectFileOperationError("DRAFT_FORBIDDEN", "Project role is read-only");
  }
}

function drainContent(content: unknown): void {
  if (typeof content === "object" && content !== null && "resume" in content
    && typeof (content as { resume?: unknown }).resume === "function") {
    (content as Readable).resume();
  }
}

export function registerProjectFilesApi(
  app: FastifyInstance,
  manager: DraftManager,
  files: ProjectFileStore,
  authenticate: Authenticate,
): void {
  app.get<{ Params: { draftId: string; projectId: string } }>(
    "/api/drafts/:draftId/projects/:projectId/files",
    async (request) => {
      await authorize(manager, authenticate, request, request.params.draftId);
      return await files.list(request.params.draftId, request.params.projectId);
    },
  );

  const sendFile = async (
    request: FastifyRequest<{ Params: { draftId: string; projectId: string; fileName: string } }>,
    reply: FastifyReply,
    forceDownload: boolean,
  ) => {
    await authorize(manager, authenticate, request, request.params.draftId);
    const opened = await files.open(request.params.draftId, request.params.projectId, request.params.fileName);
    const disposition = forceDownload ? "attachment" : opened.item.disposition;
    const stream = opened.handle.createReadStream({ autoClose: true });
    // Fastify destroys streamed responses on transport errors. Explicitly mirror a client
    // disconnect so FileHandle autoClose also runs when no further writes are attempted.
    reply.raw.once("close", () => stream.destroy());
    return reply
      .header("content-type", opened.item.media_type)
      .header("content-length", String(opened.item.size_bytes))
      .header("content-disposition", contentDisposition(disposition, opened.item.name))
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .send(stream);
  };

  app.get<{ Params: { draftId: string; projectId: string; fileName: string } }>(
    "/api/drafts/:draftId/projects/:projectId/files/:fileName/content",
    async (request, reply) => await sendFile(request, reply, false),
  );

  app.get<{ Params: { draftId: string; projectId: string; fileName: string } }>(
    "/api/drafts/:draftId/projects/:projectId/files/:fileName/download",
    async (request, reply) => await sendFile(request, reply, true),
  );

  app.post<{ Params: { draftId: string; projectId: string }; Body: unknown }>(
    "/api/drafts/:draftId/projects/:projectId/files/upload",
    { bodyLimit: Number.MAX_SAFE_INTEGER },
    async (request, reply) => {
      const content = request.body;
      try {
        const actor = await authenticate(request);
        requireMutationRole(actor.role);
        if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") {
          throw new ProjectFileOperationError("PROJECT_FILE_UPLOAD_CONTENT_TYPE_REQUIRED", "Project file upload requires application/octet-stream");
        }
        if (request.headers["content-encoding"] !== undefined) {
          throw new ProjectFileOperationError("PROJECT_FILE_UPLOAD_METADATA_INVALID", "Content-Encoding is not supported for Project file uploads");
        }
        const name = encodedName(request, FILE_NAME_HEADER)!;
        const sizeBytes = uploadSize(request);
        const expectedFingerprint = singleHeader(request, EXPECTED_FINGERPRINT_HEADER)!;
        const mode = singleHeader(request, UPLOAD_MODE_HEADER)!;
        if (mode !== "create" && mode !== "replace") {
          throw new ProjectFileOperationError("PROJECT_FILE_UPLOAD_METADATA_INVALID", "Upload mode must be create or replace");
        }
        const result = await files.upload(request.params.draftId, actor.userId, request.params.projectId, expectedFingerprint, {
          name,
          sizeBytes,
          mode,
          largeFileConfirmation: encodedName(request, LARGE_CONFIRMATION_HEADER, false),
          content: content as Readable,
        });
        await reply.code(mode === "create" ? 201 : 200).send(result);
      } catch (error) {
        // Metadata, permission and optimistic-lock failures can happen before the stream is read.
        // Drain the request so clients receive the stable JSON error instead of a reset socket.
        drainContent(content);
        throw error;
      }
    },
  );
}
