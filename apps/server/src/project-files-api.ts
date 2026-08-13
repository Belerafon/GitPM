import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DraftManager } from "@gitpm/drafts";
import type { ProjectFileStore } from "@gitpm/domain";
import type { Authenticate } from "./draft-api.js";
import { requireDraftRead } from "./draft-api.js";

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
}
