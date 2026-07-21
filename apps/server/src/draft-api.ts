import type { FastifyInstance, FastifyRequest } from "fastify";
import { DraftRuntimeError } from "@gitpm/drafts";
import type { DraftManager, DraftMetadata, WriterMode } from "@gitpm/drafts";
import { GitCommandError } from "@gitpm/git-client";
import { assertEntityType, CommentOperationError, DomainOperationError } from "@gitpm/domain";
import type { CommentActor, CommentStore, EntityStore } from "@gitpm/domain";
import type { GitPmDocument } from "@gitpm/repository-format";
import { ChangesError } from "@gitpm/changes";
import type { ChangesService } from "@gitpm/changes";
import { AuthError } from "@gitpm/gitlab";
import { PublishingError } from "@gitpm/publishing";
import { HistoryError } from "@gitpm/history";
import type { HistoryService } from "@gitpm/history";
import { validateRepository } from "@gitpm/validation";
import { WorktreeReadError } from "./worktree-api.js";

export type ProjectRole = "Reporter" | "Developer" | "Maintainer";

export interface RequestActor {
  readonly userId: string;
  readonly role: ProjectRole;
  readonly displayName?: string;
  readonly email?: string;
  readonly personId?: string;
  readonly provider?: "gitlab" | "git";
  readonly instance?: string;
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

function asCommentActor(actor: RequestActor): CommentActor {
  return {
    userId: actor.userId,
    role: actor.role,
    identity: {
      provider: actor.provider ?? "gitlab",
      ...(actor.instance === undefined ? {} : { instance: actor.instance }),
      subject: actor.provider === "git" && actor.email !== undefined ? actor.email.trim().toLocaleLowerCase() : actor.userId,
      display_name: actor.displayName?.trim() || actor.userId,
    },
    ...(actor.email === undefined ? {} : { email: actor.email }),
    ...(actor.personId === undefined ? {} : { personId: actor.personId }),
  };
}

function requireEntityMutationRole(actor: RequestActor, entityType: string): void {
  requireMutationRole(actor);
  if (["people", "teams", "calendars"].includes(entityType) && actor.role !== "Maintainer") {
    throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Administrative mutation requires Maintainer");
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
    } else if (error instanceof CommentOperationError) {
      code = error.code;
      message = error.message;
      if (["COMMENT_NOT_FOUND", "ENTITY_NOT_FOUND"].includes(error.code)) status = 404;
      else if (error.code === "COMMENT_FORBIDDEN") status = 403;
      else if (["COMMENT_BODY_REQUIRED", "COMMENT_BODY_TOO_LONG", "COMMENT_MENTION_INVALID", "COMMENT_MENTION_ARCHIVED", "ENTITY_ID_INVALID", "ENTITY_PROJECT_INVALID"].includes(error.code)) status = 400;
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
    } else if (error instanceof HistoryError) {
      code = error.code;
      message = error.message;
      status = 400;
    } else if (error instanceof WorktreeReadError) {
      code = error.code;
      message = error.message;
      if (error.code === "DRAFT_FORBIDDEN" || error.code === "WORKTREE_PATH_FORBIDDEN") status = 403;
      else if (error.code === "WORKTREE_ENTRY_NOT_FOUND") status = 404;
      else if (error.code === "WORKTREE_FILE_TOO_LARGE") status = 413;
      else if (error.code === "WORKTREE_FILE_BINARY") status = 415;
      else status = 400;
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
    return { ...publicMetadata(status.metadata), changed_externally: status.changedExternally, external_fingerprint: status.currentFingerprint };
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

export function registerCommentApi(
  app: FastifyInstance,
  manager: DraftManager,
  comments: CommentStore,
  authenticate: Authenticate,
): void {
  app.get<{ Params: { draftId: string; projectId: string; taskId: string } }>(
    "/api/drafts/:draftId/projects/:projectId/tasks/:taskId/comments",
    async (request) => {
      const actor = await authenticate(request);
      await requireDraftRead(manager, actor, request.params.draftId);
      return await comments.list(request.params.draftId, request.params.projectId, request.params.taskId, asCommentActor(actor));
    },
  );

  app.post<{ Params: { draftId: string; projectId: string; taskId: string }; Body: { expected_fingerprint: string; body_markdown: string } }>(
    "/api/drafts/:draftId/projects/:projectId/tasks/:taskId/comments",
    async (request, reply) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      const result = await comments.create(request.params.draftId, request.params.projectId, request.params.taskId, request.body.expected_fingerprint, request.body.body_markdown, asCommentActor(actor));
      await reply.code(201).send(result);
    },
  );

  app.patch<{ Params: { draftId: string; projectId: string; taskId: string; commentId: string }; Body: { expected_fingerprint: string; expected_blob_id: string; body_markdown: string } }>(
    "/api/drafts/:draftId/projects/:projectId/tasks/:taskId/comments/:commentId",
    async (request) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      return await comments.update(request.params.draftId, request.params.projectId, request.params.taskId, request.params.commentId, request.body.expected_fingerprint, request.body.expected_blob_id, request.body.body_markdown, asCommentActor(actor));
    },
  );

  app.delete<{ Params: { draftId: string; projectId: string; taskId: string; commentId: string }; Body: { expected_fingerprint: string; expected_blob_id: string } }>(
    "/api/drafts/:draftId/projects/:projectId/tasks/:taskId/comments/:commentId",
    async (request) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      return await comments.delete(request.params.draftId, request.params.projectId, request.params.taskId, request.params.commentId, request.body.expected_fingerprint, request.body.expected_blob_id, asCommentActor(actor));
    },
  );

  app.get<{ Params: { draftId: string } }>("/api/drafts/:draftId/notifications", async (request) => {
    const actor = await authenticate(request);
    await requireDraftRead(manager, actor, request.params.draftId);
    return await comments.notifications(request.params.draftId, asCommentActor(actor));
  });
}

export function registerHistoryApi(
  app: FastifyInstance,
  manager: DraftManager,
  history: HistoryService,
  authenticate: Authenticate,
): void {
  app.get<{ Params: { draftId: string }; Querystring: { limit?: string } }>("/api/drafts/:draftId/history", async (request) => {
    const actor = await authenticate(request);
    await requireDraftRead(manager, actor, request.params.draftId);
    const limit = request.query.limit === undefined ? 50 : Number.parseInt(request.query.limit, 10);
    return await history.list(request.params.draftId, limit);
  });

  app.get<{ Params: { draftId: string; commit: string } }>("/api/drafts/:draftId/history/:commit", async (request) => {
    const actor = await authenticate(request);
    await requireDraftRead(manager, actor, request.params.draftId);
    return await history.detail(request.params.draftId, request.params.commit);
  });

  app.get<{ Params: { draftId: string }; Querystring: { path: string; limit?: string } }>("/api/drafts/:draftId/file-history", async (request) => {
    const actor = await authenticate(request);
    await requireDraftRead(manager, actor, request.params.draftId);
    const limit = request.query.limit === undefined ? 50 : Number.parseInt(request.query.limit, 10);
    return await history.fileHistory(request.params.draftId, request.query.path, limit);
  });

  app.post<{ Params: { draftId: string; commit: string }; Body: { draft_id: string } }>("/api/drafts/:draftId/history/:commit/revert", async (request, reply) => {
    const actor = await authenticate(request);
    requireMutationRole(actor);
    await requireDraftRead(manager, actor, request.params.draftId);
    const result = await history.createRevertDraft(request.params.draftId, request.params.commit, request.body.draft_id, actor.userId);
    await reply.code(201).send({ ...result, draft: publicMetadata(result.draft) });
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

  app.get<{ Params: { draftId: string } }>("/api/drafts/:draftId/changes/semantic", async (request) => {
    const actor = await authenticate(request);
    await requireDraftRead(manager, actor, request.params.draftId);
    return await changes.semantic(request.params.draftId);
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
  app.get<{ Params: { draftId: string; projectId: string } }>(
    "/api/drafts/:draftId/projects/:projectId/workspace",
    async (request) => {
      const actor = await authenticate(request);
      await requireDraftRead(manager, actor, request.params.draftId);
      return await store.projectWorkspace(request.params.draftId, request.params.projectId);
    },
  );

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
      requireEntityMutationRole(actor, request.params.entityType);
      assertEntityType(request.params.entityType, request.body.document);
      const result = await store.create(request.params.draftId, actor.userId, request.body.expected_fingerprint, request.body.document);
      await reply.code(201).send(result);
    },
  );

  app.put<{ Params: { draftId: string; entityType: string; id: string }; Body: { expected_fingerprint: string; expected_blob_id: string; document: GitPmDocument } }>(
    "/api/drafts/:draftId/entities/:entityType/:id",
    async (request) => {
      const actor = await authenticate(request);
      requireEntityMutationRole(actor, request.params.entityType);
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
      requireEntityMutationRole(actor, request.params.entityType);
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

  app.post<{ Params: { draftId: string; id: string }; Body: { expected_fingerprint: string; expected_blob_id: string; target_project: string; target_milestone?: string } }>(
    "/api/drafts/:draftId/entities/tasks/:id/move",
    async (request) => {
      const actor = await authenticate(request);
      requireEntityMutationRole(actor, "tasks");
      return await store.moveTask(
        request.params.draftId,
        actor.userId,
        request.params.id,
        request.body.expected_fingerprint,
        request.body.expected_blob_id,
        request.body.target_project,
        request.body.target_milestone,
      );
    },
  );

  app.delete<{ Params: { draftId: string; entityType: string; id: string }; Body: { expected_fingerprint: string; expected_blob_id: string } }>(
    "/api/drafts/:draftId/entities/:entityType/:id",
    async (request) => {
      const actor = await authenticate(request);
      requireEntityMutationRole(actor, request.params.entityType);
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
