import type { FastifyInstance, FastifyRequest } from "fastify";
import { DraftRuntimeError } from "@gitpm/drafts";
import type { DraftManager, DraftMetadata, WriterMode } from "@gitpm/drafts";
import { GitCommandError } from "@gitpm/git-client";
import { assertEntityType, DomainOperationError } from "@gitpm/domain";
import type { EntityStore } from "@gitpm/domain";
import type { GitPmDocument } from "@gitpm/repository-format";
import { ChangesError } from "@gitpm/changes";
import type { ChangesService } from "@gitpm/changes";
import { AuthError } from "@gitpm/gitlab";
import { PublishingError } from "@gitpm/publishing";
import { validateRepository } from "@gitpm/validation";

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

async function requireDraftRead(manager: DraftManager, actor: RequestActor, draftId: string): Promise<void> {
  const metadata = await manager.getDraft(draftId);
  if (metadata.owner_gitlab_user_id !== actor.userId && actor.role !== "Maintainer") {
    throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Draft owner mismatch");
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
    } else if (error instanceof DomainOperationError) {
      code = error.code;
      message = error.message;
      if (error.code === "ENTITY_NOT_FOUND") status = 404;
      else if (["ENTITY_TYPE_INVALID", "ENTITY_ID_INVALID", "ENTITY_PROJECT_INVALID"].includes(error.code)) status = 400;
      else if (error.code === "VALIDATION_FAILED") status = 422;
      else status = 409;
    } else if (error instanceof ChangesError) {
      code = error.code;
      message = error.message;
      status = error.code === "CHANGE_PATH_INVALID" ? 400 : 409;
    } else if (error instanceof AuthError) {
      code = error.code;
      message = error.message;
      status = error.code === "ROLE_READ_ONLY" || error.code === "PROJECT_MEMBERSHIP_REQUIRED" ? 403 : 401;
    } else if (error instanceof PublishingError) {
      code = error.code;
      message = error.message;
      status = error.code === "VALIDATION_FAILED" ? 422 : 409;
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

  app.get("/api/drafts", async (request) => {
    const actor = await authenticate(request);
    const drafts = await manager.listDrafts();
    return drafts
      .filter((draft) => draft.owner_gitlab_user_id === actor.userId || actor.role === "Maintainer")
      .map(publicMetadata);
  });

  app.get<{ Params: { draftId: string } }>("/api/drafts/:draftId", async (request) => {
    const actor = await authenticate(request);
    const status = await manager.poll(request.params.draftId);
    if (status.metadata.owner_gitlab_user_id !== actor.userId && actor.role !== "Maintainer") {
      throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Draft owner mismatch");
    }
    return { ...publicMetadata(status.metadata), changed_externally: status.changedExternally };
  });

  app.get<{ Params: { draftId: string } }>("/api/drafts/:draftId/validation", async (request) => {
    const actor = await authenticate(request);
    await requireDraftRead(manager, actor, request.params.draftId);
    const metadata = await manager.getDraft(request.params.draftId);
    const report = await validateRepository(metadata.worktree_path);
    return {
      valid: report.valid,
      error_count: report.errors.length,
      warning_count: report.warnings.length,
      document_count: report.documentCount,
    };
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

export function registerChangesApi(
  app: FastifyInstance,
  manager: DraftManager,
  changes: ChangesService,
  authenticate: Authenticate,
): void {
  app.get<{ Params: { draftId: string } }>("/api/drafts/:draftId/changes", async (request) => {
    const actor = await authenticate(request);
    await requireDraftRead(manager, actor, request.params.draftId);
    return await changes.list(request.params.draftId);
  });

  app.post<{ Params: { draftId: string }; Body: { expected_fingerprint: string; path: string } }>(
    "/api/drafts/:draftId/changes/restore-file",
    async (request) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      return await changes.restoreFile(request.params.draftId, actor.userId, request.body.expected_fingerprint, request.body.path);
    },
  );

  app.post<{ Params: { draftId: string }; Body: { expected_fingerprint: string; path: string; diff_token: string; hunk_index: number } }>(
    "/api/drafts/:draftId/changes/restore-hunk",
    async (request) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      return await changes.restoreHunk(
        request.params.draftId,
        actor.userId,
        request.body.expected_fingerprint,
        request.body.path,
        request.body.diff_token,
        request.body.hunk_index,
      );
    },
  );

  app.post<{ Params: { draftId: string }; Body: { expected_fingerprint: string } }>(
    "/api/drafts/:draftId/changes/discard-all",
    async (request) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      return await changes.discardAll(request.params.draftId, actor.userId, request.body.expected_fingerprint);
    },
  );
}

export function registerEntityApi(
  app: FastifyInstance,
  manager: DraftManager,
  store: EntityStore,
  authenticate: Authenticate,
): void {
  app.get<{ Params: { draftId: string; entityType: string }; Querystring: { project?: string } }>(
    "/api/drafts/:draftId/entities/:entityType",
    async (request) => {
      const actor = await authenticate(request);
      await requireDraftRead(manager, actor, request.params.draftId);
      return await store.list(request.params.draftId, request.params.entityType, request.query.project);
    },
  );

  app.get<{ Params: { draftId: string; entityType: string; id: string } }>(
    "/api/drafts/:draftId/entities/:entityType/:id",
    async (request) => {
      const actor = await authenticate(request);
      await requireDraftRead(manager, actor, request.params.draftId);
      return await store.get(request.params.draftId, request.params.entityType, request.params.id);
    },
  );

  app.post<{ Params: { draftId: string; entityType: string }; Body: { expected_fingerprint: string; document: GitPmDocument } }>(
    "/api/drafts/:draftId/entities/:entityType",
    async (request, reply) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      assertEntityType(request.params.entityType, request.body.document);
      const result = await store.create(request.params.draftId, actor.userId, request.body.expected_fingerprint, request.body.document);
      await reply.code(201).send(result);
    },
  );

  app.put<{ Params: { draftId: string; entityType: string; id: string }; Body: { expected_fingerprint: string; expected_blob_id: string; document: GitPmDocument } }>(
    "/api/drafts/:draftId/entities/:entityType/:id",
    async (request) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      return await store.update(
        request.params.draftId,
        actor.userId,
        request.params.entityType,
        request.params.id,
        request.body.expected_fingerprint,
        request.body.expected_blob_id,
        request.body.document,
      );
    },
  );

  app.post<{ Params: { draftId: string; entityType: string; id: string }; Body: { expected_fingerprint: string; expected_blob_id: string } }>(
    "/api/drafts/:draftId/entities/:entityType/:id/archive",
    async (request) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      return await store.archive(
        request.params.draftId,
        actor.userId,
        request.params.entityType,
        request.params.id,
        request.body.expected_fingerprint,
        request.body.expected_blob_id,
      );
    },
  );

  app.delete<{ Params: { draftId: string; entityType: string; id: string }; Body: { expected_fingerprint: string; expected_blob_id: string } }>(
    "/api/drafts/:draftId/entities/:entityType/:id",
    async (request) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      return await store.delete(
        request.params.draftId,
        actor.userId,
        request.params.entityType,
        request.params.id,
        request.body.expected_fingerprint,
        request.body.expected_blob_id,
      );
    },
  );

  app.get<{ Params: { draftId: string; kind: "statuses" | "issue-types" } }>(
    "/api/drafts/:draftId/config/:kind",
    async (request) => {
      const actor = await authenticate(request);
      await requireDraftRead(manager, actor, request.params.draftId);
      return await store.getConfiguration(request.params.draftId, request.params.kind);
    },
  );

  app.put<{ Params: { draftId: string; kind: "statuses" | "issue-types" }; Body: { expected_fingerprint: string; expected_blob_id: string; document: GitPmDocument } }>(
    "/api/drafts/:draftId/config/:kind",
    async (request) => {
      const actor = await authenticate(request);
      if (actor.role !== "Maintainer") throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Configuration mutation requires Maintainer");
      return await store.updateConfiguration(
        request.params.draftId,
        actor.userId,
        request.params.kind,
        request.body.expected_fingerprint,
        request.body.expected_blob_id,
        request.body.document,
      );
    },
  );
}
