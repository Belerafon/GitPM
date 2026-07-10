import type { FastifyInstance, FastifyRequest } from "fastify";
import { DraftRuntimeError } from "@gitpm/drafts";
import type { DraftManager, DraftMetadata, WriterMode } from "@gitpm/drafts";
import { GitCommandError } from "@gitpm/git-client";

export type ProjectRole = "Reporter" | "Developer" | "Maintainer";

export interface RequestActor {
  readonly userId: string;
  readonly role: ProjectRole;
}

export type Authenticate = (request: FastifyRequest) => RequestActor | Promise<RequestActor>;

interface ErrorPayload {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly correlation_id: string;
  };
}

function publicMetadata(metadata: DraftMetadata) {
  return {
    draft_id: metadata.draft_id,
    owner_gitlab_user_id: metadata.owner_gitlab_user_id,
    branch: metadata.branch,
    base_commit: metadata.base_commit,
    writer_mode: metadata.writer_mode,
    state: metadata.state,
    merge_request_iid: metadata.merge_request_iid,
    fingerprint: metadata.fingerprint,
    created_at: metadata.created_at,
    updated_at: metadata.updated_at,
  };
}

function requireMutationRole(actor: RequestActor): void {
  if (actor.role !== "Developer" && actor.role !== "Maintainer") {
    throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Project role is read-only");
  }
}

function statusFor(error: DraftRuntimeError): number {
  if (error.code === "DRAFT_NOT_FOUND") return 404;
  if (error.code === "DRAFT_FORBIDDEN") return 403;
  if (error.code === "DRAFT_IDENTITY_INVALID") return 400;
  return 409;
}

export function registerDraftApi(app: FastifyInstance, manager: DraftManager, authenticate: Authenticate): void {
  app.setErrorHandler(async (error, request, reply) => {
    let status = 500;
    let code = "INTERNAL_ERROR";
    let message = "Unexpected server error";
    if (error instanceof DraftRuntimeError) {
      status = statusFor(error);
      code = error.code;
      message = error.message;
    } else if (error instanceof GitCommandError) {
      status = error.code === "GIT_TIMEOUT" ? 504 : 502;
      code = error.code;
      message = error.message;
    } else if ((error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      status = 413;
      code = "REQUEST_TOO_LARGE";
      message = "Request body exceeds the static limit";
    }
    const payload: ErrorPayload = { error: { code, message, correlation_id: request.id } };
    await reply.code(status).send(payload);
  });

  app.post<{ Body: { draft_id: string } }>("/api/drafts", async (request, reply) => {
    const actor = await authenticate(request);
    requireMutationRole(actor);
    const metadata = await manager.createDraft(request.body.draft_id, actor.userId);
    await reply.code(201).send(publicMetadata(metadata));
  });

  app.get<{ Params: { draftId: string } }>("/api/drafts/:draftId", async (request) => {
    const actor = await authenticate(request);
    const status = await manager.poll(request.params.draftId);
    if (status.metadata.owner_gitlab_user_id !== actor.userId && actor.role !== "Maintainer") {
      throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Draft owner mismatch");
    }
    return { ...publicMetadata(status.metadata), changed_externally: status.changedExternally };
  });

  app.patch<{ Params: { draftId: string }; Body: { writer_mode: WriterMode } }>("/api/drafts/:draftId/writer-mode", async (request) => {
    const actor = await authenticate(request);
    requireMutationRole(actor);
    return publicMetadata(await manager.setWriterMode(request.params.draftId, actor.userId, request.body.writer_mode));
  });

  app.post<{ Params: { draftId: string } }>("/api/drafts/:draftId/close", async (request) => {
    const actor = await authenticate(request);
    requireMutationRole(actor);
    return publicMetadata(await manager.closeDraft(request.params.draftId, actor.userId));
  });

  app.post<{ Params: { draftId: string } }>("/api/drafts/:draftId/reopen", async (request) => {
    const actor = await authenticate(request);
    requireMutationRole(actor);
    return publicMetadata(await manager.reopenDraft(request.params.draftId, actor.userId));
  });

  app.delete<{ Params: { draftId: string }; Body: { confirmation: string } }>("/api/drafts/:draftId", async (request, reply) => {
    const actor = await authenticate(request);
    if (actor.role !== "Maintainer") throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Cleanup requires Maintainer");
    await manager.cleanupDraft(request.params.draftId, request.body.confirmation);
    await reply.code(204).send();
  });
}
