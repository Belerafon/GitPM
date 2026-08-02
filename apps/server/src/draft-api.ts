import type { FastifyInstance, FastifyRequest } from "fastify";
import { DraftRuntimeError } from "@gitpm/drafts";
import type { DraftManager, DraftMetadata, WriterMode } from "@gitpm/drafts";
import { GitCommandError } from "@gitpm/git-client";
import { assertEntityType, CommentOperationError, DomainOperationError, TimeEntryOperationError } from "@gitpm/domain";
import type { CommentActor, CommentStore, EntityStore, TimeEntryActor, TimeEntryStore } from "@gitpm/domain";
import {
  HTTP_REQUEST_BODY_SCHEMAS,
  ApiContractError,
  decodeConfigurationDocument,
  decodeEntityDocument,
  decodeRepositoryDocument,
  type ConfigurationDocument,
  type HttpDocument as GitPmDocument,
  type RepositoryDocument as RepositoryConfigurationDocument,
} from "@gitpm/contracts";
import { ChangesError } from "@gitpm/changes";
import type { ChangesService } from "@gitpm/changes";
import { AuthError } from "@gitpm/gitlab";
import { PublicationError } from "@gitpm/publishing";
import { HistoryError } from "@gitpm/history";
import type { HistoryService } from "@gitpm/history";
import { validateRepository } from "@gitpm/validation";
import { WorktreeReadError } from "./worktree-api.js";
import { RepositoryConnectionError } from "./repository-connection.js";
import { SecurityBoundaryError } from "@gitpm/security";
import type { GitPmDocument as RepositoryFormatDocument } from "@gitpm/repository-format";
import { ExportError } from "@gitpm/export";
import { buildWorkloadReport, type WorkloadEntityDocument } from "@gitpm/workload";
import { MemoryNotificationReadStore, type NotificationReadStore } from "./notification-read-store.js";

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
    readonly details?: unknown;
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

function repositoryDocument(document: GitPmDocument | ConfigurationDocument | RepositoryConfigurationDocument): RepositoryFormatDocument {
  return document as unknown as RepositoryFormatDocument;
}

function repositoryInput(document: GitPmDocument): Readonly<Record<string, unknown>> {
  return document as unknown as Readonly<Record<string, unknown>>;
}

function requireMutationRole(actor: RequestActor): void {
  if (actor.role !== "Developer" && actor.role !== "Maintainer") {
    throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Project role is read-only");
  }
}

function requireWorktreeDraftOperation(manager: DraftManager): void {
  if (manager.repositoryMode === "direct") {
    throw new DraftRuntimeError("DIRECT_MODE_DRAFT_OPERATION_UNAVAILABLE", "Direct repository mode uses the selected checkout and has no draft lifecycle");
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

function asTimeEntryActor(actor: RequestActor): TimeEntryActor {
  return {
    userId: actor.userId,
    identity: {
      provider: actor.provider ?? "gitlab",
      ...(actor.instance === undefined ? {} : { instance: actor.instance }),
      subject: actor.provider === "git" && actor.email !== undefined ? actor.email.trim().toLocaleLowerCase() : actor.userId,
      display_name: actor.displayName?.trim() || actor.userId,
    },
  };
}

function requireEntityMutationRole(actor: RequestActor, entityType: string): void {
  requireMutationRole(actor);
  if (["people", "teams", "calendars"].includes(entityType) && actor.role !== "Maintainer") {
    throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Administrative mutation requires Maintainer");
  }
}

export async function requireDraftRead(manager: DraftManager, actor: RequestActor, draftId: string): Promise<void> {
  const metadata = await manager.getDraft(draftId);
  if (metadata.owner_gitlab_user_id !== actor.userId) {
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
    let details: unknown;
    if (error instanceof DraftRuntimeError) {
      status = statusFor(error);
      code = error.code;
      message = error.message;
    } else if (error instanceof GitCommandError) {
      status = error.code === "GIT_TIMEOUT"
        ? 504
        : ["GIT_WRONG_BRANCH", "GIT_DETACHED_HEAD", "GIT_NON_FAST_FORWARD"].includes(error.code)
          ? 409
          : 502;
      code = error.code;
      message = error.message;
    } else if (error instanceof DomainOperationError) {
      code = error.code;
      message = error.message;
      details = error.details;
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
    } else if (error instanceof TimeEntryOperationError) {
      code = error.code;
      message = error.message;
      details = error.details;
      if (["TIME_ENTRY_NOT_FOUND", "ENTITY_NOT_FOUND"].includes(error.code)) status = 404;
      else if (["ENTITY_ID_INVALID", "ENTITY_PROJECT_INVALID", "REF_MISSING", "REF_CROSS_PROJECT", "TIME_ENTRY_VOIDED", "TIME_ENTRY_FILTER_INVALID", "TIME_ENTRY_REPLACEMENT_INVALID", "TIME_ENTRY_REPLACEMENT_MISSING", "TIME_ENTRY_REPLACEMENT_SELF", "TIME_ENTRY_REPLACEMENT_TASK_MISMATCH"].includes(error.code)) status = 400;
      else if (error.code === "VALIDATION_FAILED") status = 422;
      else status = 409;
    } else if (error instanceof AuthError) {
      code = error.code;
      message = error.message;
      status = error.code === "ROLE_READ_ONLY" || error.code === "PROJECT_MEMBERSHIP_REQUIRED"
        ? 403
        : error.code === "GITLAB_PUBLIC_EMAIL_REQUIRED" || error.code === "GITLAB_PROFILE_NAME_REQUIRED"
          ? 422
          : 401;
    } else if (error instanceof PublicationError) {
      code = error.code;
      message = error.message;
      status = error.code === "VALIDATION_FAILED" ? 422 : 409;
    } else if (error instanceof HistoryError) {
      code = error.code;
      message = error.message;
      details = error.details;
      status = error.code === "HISTORY_VALIDATION_FAILED" ? 422
        : ["HISTORY_REVERT_CONFLICT", "HISTORY_SELECTED_FILE_DIRTY", "HISTORY_WORKSPACE_DIRTY", "HISTORY_DIRECT_MODE_REQUIRED"].includes(error.code) ? 409
          : 400;
    } else if (error instanceof ExportError) {
      code = error.code;
      message = error.message;
      status = error.code === "EXPORT_REPOSITORY_INVALID" ? 422
        : error.code === "EXPORT_GIT_CLONE_FAILED" ? 502
          : 400;
    } else if (error instanceof WorktreeReadError) {
      code = error.code;
      message = error.message;
      if (error.code === "DRAFT_FORBIDDEN" || error.code === "WORKTREE_PATH_FORBIDDEN") status = 403;
      else if (error.code === "WORKTREE_ENTRY_NOT_FOUND") status = 404;
      else if (error.code === "WORKTREE_FILE_TOO_LARGE" || error.code === "WORKTREE_UPLOAD_TOO_LARGE") status = 413;
      else if (error.code === "WORKTREE_FILE_BINARY") status = 415;
      else if (error.code === "WORKTREE_ENTRY_EXISTS" || error.code === "WORKTREE_MOVE_INVALID") status = 409;
      else status = 400;
    } else if (error instanceof RepositoryConnectionError || error instanceof SecurityBoundaryError) {
      code = error.code;
      message = error.message;
      status = error.code === "REPOSITORY_CONNECTION_MANAGED_EXTERNALLY" ? 409 : 400;
    } else if (error instanceof ApiContractError || (error as { code?: string }).code === "FST_ERR_VALIDATION") {
      status = 400;
      code = "REQUEST_CONTRACT_INVALID";
      message = "Request body does not match the shared HTTP contract";
      details = error instanceof ApiContractError ? error.details : (error as { validation?: unknown }).validation;
    } else if ((error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      status = 413;
      code = "REQUEST_TOO_LARGE";
      message = "Request body exceeds the static limit";
    }
    const payload: ErrorPayload = { error: { code, message, correlation_id: request.id, ...(details === undefined ? {} : { details }) } };
    await reply.code(status).send(payload);
  });

  app.post<{ Body: { draft_id: string } }>("/api/drafts", { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.createDraft } }, async (request, reply) => {
    const actor = await authenticate(request);
    requireMutationRole(actor);
    requireWorktreeDraftOperation(manager);
    const metadata = await manager.createDraft(request.body.draft_id, actor.userId);
    await reply.code(201).send(publicMetadata(metadata));
  });

  app.get("/api/drafts", async (request) => {
    const actor = await authenticate(request);
    const drafts = await manager.listDrafts();
    return drafts
      .filter((draft) => draft.owner_gitlab_user_id === actor.userId)
      .map(publicMetadata);
  });

  app.get<{ Params: { draftId: string } }>("/api/drafts/:draftId", async (request) => {
    const actor = await authenticate(request);
    const status = await manager.poll(request.params.draftId);
    if (status.metadata.owner_gitlab_user_id !== actor.userId) {
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

  app.patch<{ Params: { draftId: string }; Body: { writer_mode: WriterMode } }>("/api/drafts/:draftId/writer-mode", { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.writerMode } }, async (request) => {
    const actor = await authenticate(request);
    requireMutationRole(actor);
    requireWorktreeDraftOperation(manager);
    return publicMetadata(await manager.setWriterMode(request.params.draftId, actor.userId, request.body.writer_mode));
  });

  app.post<{ Params: { draftId: string } }>("/api/drafts/:draftId/acknowledge-external-changes", async (request) => {
    const actor = await authenticate(request);
    requireMutationRole(actor);
    return publicMetadata(await manager.acknowledgeExternalChanges(request.params.draftId, actor.userId));
  });

  app.post<{ Params: { draftId: string } }>("/api/drafts/:draftId/close", async (request) => {
    const actor = await authenticate(request);
    requireMutationRole(actor);
    requireWorktreeDraftOperation(manager);
    return publicMetadata(await manager.closeDraft(request.params.draftId, actor.userId));
  });

  app.post<{ Params: { draftId: string } }>("/api/drafts/:draftId/reopen", async (request) => {
    const actor = await authenticate(request);
    requireMutationRole(actor);
    requireWorktreeDraftOperation(manager);
    return publicMetadata(await manager.reopenDraft(request.params.draftId, actor.userId));
  });

  app.delete<{ Params: { draftId: string }; Body: { confirmation: string } }>("/api/drafts/:draftId", { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.cleanupDraft } }, async (request, reply) => {
    const actor = await authenticate(request);
    if (actor.role !== "Maintainer") throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Cleanup requires Maintainer");
    requireWorktreeDraftOperation(manager);
    await manager.cleanupDraft(request.params.draftId, request.body.confirmation);
    await reply.code(204).send();
  });
}

export function registerCommentApi(
  app: FastifyInstance,
  manager: DraftManager,
  comments: CommentStore,
  authenticate: Authenticate,
  notificationReads: NotificationReadStore = new MemoryNotificationReadStore(),
): void {
  const withReadState = async (result: Awaited<ReturnType<CommentStore["notifications"]>>) => {
    if (result.recipient_person_id === undefined) return result;
    const readKeys = await notificationReads.read(result.recipient_person_id);
    return { ...result, items: result.items.map((item) => ({ ...item, read: readKeys.has(item.key) })) };
  };

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
    { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.createComment } },
    async (request, reply) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      const result = await comments.create(request.params.draftId, request.params.projectId, request.params.taskId, request.body.expected_fingerprint, request.body.body_markdown, asCommentActor(actor));
      await reply.code(201).send(result);
    },
  );

  app.patch<{ Params: { draftId: string; projectId: string; taskId: string; commentId: string }; Body: { expected_fingerprint: string; expected_blob_id: string; body_markdown: string } }>(
    "/api/drafts/:draftId/projects/:projectId/tasks/:taskId/comments/:commentId",
    { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.updateComment } },
    async (request) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      return await comments.update(request.params.draftId, request.params.projectId, request.params.taskId, request.params.commentId, request.body.expected_fingerprint, request.body.expected_blob_id, request.body.body_markdown, asCommentActor(actor));
    },
  );

  app.delete<{ Params: { draftId: string; projectId: string; taskId: string; commentId: string }; Body: { expected_fingerprint: string; expected_blob_id: string } }>(
    "/api/drafts/:draftId/projects/:projectId/tasks/:taskId/comments/:commentId",
    { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.deleteComment } },
    async (request) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      return await comments.delete(request.params.draftId, request.params.projectId, request.params.taskId, request.params.commentId, request.body.expected_fingerprint, request.body.expected_blob_id, asCommentActor(actor));
    },
  );

  app.get<{ Params: { draftId: string } }>("/api/drafts/:draftId/notifications", async (request) => {
    const actor = await authenticate(request);
    await requireDraftRead(manager, actor, request.params.draftId);
    return await withReadState(await comments.notifications(request.params.draftId, asCommentActor(actor)));
  });

  app.post<{ Params: { draftId: string }; Body: { keys: string[] } }>(
    "/api/drafts/:draftId/notifications/read",
    { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.markNotificationsRead } },
    async (request) => {
      const actor = await authenticate(request);
      await requireDraftRead(manager, actor, request.params.draftId);
      const result = await comments.notifications(request.params.draftId, asCommentActor(actor));
      if (result.recipient_person_id === undefined) return result;
      const visibleKeys = new Set(result.items.map((item) => item.key));
      const keys = [...new Set(request.body.keys)].filter((key) => visibleKeys.has(key));
      await notificationReads.markRead(result.recipient_person_id, keys);
      return await withReadState(result);
    },
  );
}

export function registerTimeEntryApi(
  app: FastifyInstance,
  manager: DraftManager,
  timeEntries: TimeEntryStore,
  authenticate: Authenticate,
): void {
  app.get<{
    Params: { draftId: string; projectId: string };
    Querystring: { task?: string; milestone?: string; person?: string; category?: string; performed_from?: string; performed_to?: string; state?: "active" | "voided"; offset?: number; limit?: number };
  }>(
    "/api/drafts/:draftId/projects/:projectId/time-entries",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            task: { type: "string", pattern: "^T-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$" },
            milestone: { type: "string", pattern: "^M-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$" },
            person: { type: "string", pattern: "^U-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$" },
            category: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" },
            performed_from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            performed_to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            state: { enum: ["active", "voided"] },
            offset: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 1, maximum: 200 },
          },
        },
      },
    },
    async (request) => {
      const actor = await authenticate(request);
      await requireDraftRead(manager, actor, request.params.draftId);
      return await timeEntries.listProject(request.params.draftId, request.params.projectId, request.query);
    },
  );

  app.get<{ Params: { draftId: string; projectId: string; taskId: string } }>(
    "/api/drafts/:draftId/projects/:projectId/tasks/:taskId/time-entries",
    async (request) => {
      const actor = await authenticate(request);
      await requireDraftRead(manager, actor, request.params.draftId);
      return await timeEntries.list(request.params.draftId, request.params.projectId, request.params.taskId);
    },
  );

  app.post<{ Params: { draftId: string; projectId: string; taskId: string }; Body: { expected_fingerprint: string; person: string; performed_on: string; hours: number; category: string; note_markdown?: string } }>(
    "/api/drafts/:draftId/projects/:projectId/tasks/:taskId/time-entries",
    { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.createTimeEntry } },
    async (request, reply) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      const result = await timeEntries.create(request.params.draftId, request.params.projectId, request.params.taskId, request.body.expected_fingerprint, {
        person: request.body.person,
        performed_on: request.body.performed_on,
        hours: request.body.hours,
        category: request.body.category,
        ...(request.body.note_markdown === undefined ? {} : { note_markdown: request.body.note_markdown }),
      }, asTimeEntryActor(actor));
      await reply.code(201).send(result);
    },
  );

  app.post<{ Params: { draftId: string; projectId: string; taskId: string; entryId: string }; Body: { expected_fingerprint: string; expected_blob_id: string; replacement?: string } }>(
    "/api/drafts/:draftId/projects/:projectId/tasks/:taskId/time-entries/:entryId/void",
    { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.voidTimeEntry } },
    async (request) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      return await timeEntries.void(request.params.draftId, request.params.projectId, request.params.taskId, request.params.entryId, request.body.expected_fingerprint, request.body.expected_blob_id, asTimeEntryActor(actor), request.body.replacement);
    },
  );

  app.post<{ Params: { draftId: string; projectId: string; taskId: string; entryId: string }; Body: { expected_fingerprint: string; expected_blob_id: string; person: string; performed_on: string; hours: number; category: string; note_markdown?: string } }>(
    "/api/drafts/:draftId/projects/:projectId/tasks/:taskId/time-entries/:entryId/replace",
    { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.replaceTimeEntry } },
    async (request) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      return await timeEntries.replace(request.params.draftId, request.params.projectId, request.params.taskId, request.params.entryId, request.body.expected_fingerprint, request.body.expected_blob_id, {
        person: request.body.person,
        performed_on: request.body.performed_on,
        hours: request.body.hours,
        category: request.body.category,
        ...(request.body.note_markdown === undefined ? {} : { note_markdown: request.body.note_markdown }),
      }, asTimeEntryActor(actor));
    },
  );
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

  app.get<{ Params: { draftId: string; commit: string }; Querystring: { path: string } }>("/api/drafts/:draftId/history/:commit/file-diff", async (request) => {
    const actor = await authenticate(request);
    await requireDraftRead(manager, actor, request.params.draftId);
    return await history.fileDiff(request.params.draftId, request.params.commit, request.query.path);
  });

  app.get<{ Params: { draftId: string }; Querystring: { path: string; limit?: string } }>("/api/drafts/:draftId/file-history", async (request) => {
    const actor = await authenticate(request);
    await requireDraftRead(manager, actor, request.params.draftId);
    const limit = request.query.limit === undefined ? 50 : Number.parseInt(request.query.limit, 10);
    return await history.fileHistory(request.params.draftId, request.query.path, limit);
  });

  app.post<{ Params: { draftId: string; commit: string }; Body: { draft_id: string } }>("/api/drafts/:draftId/history/:commit/revert", { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.revertDraft } }, async (request, reply) => {
    const actor = await authenticate(request);
    requireMutationRole(actor);
    requireWorktreeDraftOperation(manager);
    await requireDraftRead(manager, actor, request.params.draftId);
    const result = await history.createRevertDraft(request.params.draftId, request.params.commit, request.body.draft_id, actor.userId);
    await reply.code(201).send({ ...result, draft: publicMetadata(result.draft) });
  });

  app.post<{ Params: { draftId: string; commit: string }; Body: { expected_fingerprint: string; paths: string[] } }>(
    "/api/drafts/:draftId/history/:commit/restore-files",
    { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.restoreCommitFiles } },
    async (request) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      await requireDraftRead(manager, actor, request.params.draftId);
      return await history.restoreCommitFiles(request.params.draftId, request.params.commit, request.body.paths, actor.userId, request.body.expected_fingerprint);
    },
  );

  app.post<{ Params: { draftId: string; commit: string }; Body: { expected_fingerprint: string; message: string } }>(
    "/api/drafts/:draftId/history/:commit/revert-direct",
    { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.directRevert } },
    async (request, reply) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      await requireDraftRead(manager, actor, request.params.draftId);
      if (actor.provider === "gitlab" && actor.email === undefined) throw new AuthError("GITLAB_PUBLIC_EMAIL_REQUIRED", "Configure a Public email in your GitLab profile before creating a commit");
      if (actor.provider === "gitlab" && !actor.displayName?.trim()) throw new AuthError("GITLAB_PROFILE_NAME_REQUIRED", "GitLab profile name is required before creating a commit");
      const result = await history.revertDirect(
        request.params.draftId,
        request.params.commit,
        request.body.message,
        actor.userId,
        request.body.expected_fingerprint,
        actor.displayName?.trim() || actor.userId,
        actor.email?.trim() || `${actor.userId}@localhost`,
      );
      await reply.code(201).send(result);
    },
  );
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
    { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.expectedFingerprintPath } },
    async (request) => {
      const actor = await authenticate(request);
      requireMutationRole(actor);
      return await changes.restoreFile(request.params.draftId, actor.userId, request.body.expected_fingerprint, request.body.path);
    },
  );

  app.post<{ Params: { draftId: string }; Body: { expected_fingerprint: string; path: string; diff_token: string; hunk_index: number } }>(
    "/api/drafts/:draftId/changes/restore-hunk",
    { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.restoreHunk } },
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
    { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.expectedFingerprint } },
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
  app.get<{
    Params: { draftId: string };
    Querystring: { project?: string; milestone?: string; team?: string };
  }>(
    "/api/drafts/:draftId/workload",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            project: { type: "string", pattern: "^P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$" },
            milestone: { type: "string", pattern: "^M-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$" },
            team: { type: "string", pattern: "^G-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$" },
          },
        },
      },
    },
    async (request) => {
      const actor = await authenticate(request);
      await requireDraftRead(manager, actor, request.params.draftId);
      const [tasks, projects, people, calendars, teams, tracks] = await Promise.all([
        store.list(request.params.draftId, "tasks"),
        store.list(request.params.draftId, "projects"),
        store.list(request.params.draftId, "people"),
        store.list(request.params.draftId, "calendars"),
        store.list(request.params.draftId, "teams"),
        store.getConfiguration(request.params.draftId, "schedule-tracks"),
      ]);
      const documents = (items: readonly { readonly document: unknown }[]) => items.map((item) => item.document as WorkloadEntityDocument);
      return buildWorkloadReport({
        tasks: documents(tasks), projects: documents(projects), people: documents(people), calendars: documents(calendars), teams: documents(teams),
        scheduleTracks: tracks.document as WorkloadEntityDocument,
        filters: request.query,
      });
    },
  );

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
    {
      schema: { body: HTTP_REQUEST_BODY_SCHEMAS.createEntity },
      preValidation: async (request) => { decodeEntityDocument(request.body.document); },
    },
    async (request, reply) => {
      const actor = await authenticate(request);
      requireEntityMutationRole(actor, request.params.entityType);
      assertEntityType(request.params.entityType, repositoryDocument(request.body.document));
      const result = await store.create(request.params.draftId, actor.userId, request.body.expected_fingerprint, repositoryInput(request.body.document), request.params.entityType);
      await reply.code(201).send(result);
    },
  );

  app.put<{ Params: { draftId: string; entityType: string; id: string }; Body: { expected_fingerprint: string; expected_blob_id: string; document: GitPmDocument } }>(
    "/api/drafts/:draftId/entities/:entityType/:id",
    {
      schema: { body: HTTP_REQUEST_BODY_SCHEMAS.updateEntity },
      preValidation: async (request) => { decodeEntityDocument(request.body.document); },
    },
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
        repositoryDocument(request.body.document),
      );
    },
  );

  app.post<{ Params: { draftId: string; entityType: string; id: string }; Body: { expected_fingerprint: string; expected_blob_id: string } }>(
    "/api/drafts/:draftId/entities/:entityType/:id/archive",
    { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.entityFingerprint } },
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

  app.post<{ Params: { draftId: string; entityType: string; id: string }; Body: { expected_fingerprint: string; expected_blob_id: string } }>(
    "/api/drafts/:draftId/entities/:entityType/:id/restore",
    { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.entityFingerprint } },
    async (request) => {
      const actor = await authenticate(request);
      requireEntityMutationRole(actor, request.params.entityType);
      return await store.restore(
        request.params.draftId,
        actor.userId,
        request.params.entityType,
        request.params.id,
        request.body.expected_fingerprint,
        request.body.expected_blob_id,
      );
    },
  );

  app.post<{ Params: { draftId: string; id: string }; Body: { expected_fingerprint: string; expected_blob_id: string; target_project: string; target_milestone?: string; target_parent?: string } }>(
    "/api/drafts/:draftId/entities/tasks/:id/move",
    { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.moveTask } },
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
        request.body.target_parent,
      );
    },
  );

  app.delete<{ Params: { draftId: string; entityType: string; id: string }; Body: { expected_fingerprint: string; expected_blob_id: string; unlink_references?: boolean; cascade_references?: boolean } }>(
    "/api/drafts/:draftId/entities/:entityType/:id",
    { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.deleteEntity } },
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
        request.body.unlink_references ?? false,
        request.body.cascade_references ?? false,
      );
    },
  );

  app.get<{ Params: { draftId: string; kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks" } }>(
    "/api/drafts/:draftId/config/:kind",
    async (request) => {
      const actor = await authenticate(request);
      await requireDraftRead(manager, actor, request.params.draftId);
      return await store.getConfiguration(request.params.draftId, request.params.kind);
    },
  );

  app.get<{ Params: { draftId: string } }>(
    "/api/drafts/:draftId/config/repository",
    async (request) => {
      const actor = await authenticate(request);
      await requireDraftRead(manager, actor, request.params.draftId);
      return await store.getRepositoryConfiguration(request.params.draftId);
    },
  );

  app.put<{ Params: { draftId: string }; Body: { expected_fingerprint: string; expected_blob_id: string; document: RepositoryConfigurationDocument } }>(
    "/api/drafts/:draftId/config/repository",
    {
      schema: { body: HTTP_REQUEST_BODY_SCHEMAS.updateConfiguration },
      preValidation: async (request) => { decodeRepositoryDocument(request.body.document); },
    },
    async (request) => {
      const actor = await authenticate(request);
      if (actor.role !== "Maintainer") throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Repository configuration mutation requires Maintainer");
      return await store.updateRepositoryConfiguration(
        request.params.draftId,
        actor.userId,
        request.body.expected_fingerprint,
        request.body.expected_blob_id,
        repositoryDocument(request.body.document),
      );
    },
  );

  app.post<{ Params: { draftId: string; kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks" }; Body: { document: ConfigurationDocument } }>(
    "/api/drafts/:draftId/config/:kind/impact",
    {
      schema: { body: HTTP_REQUEST_BODY_SCHEMAS.configurationImpact },
      preValidation: async (request) => { decodeConfigurationDocument(request.body.document); },
    },
    async (request) => {
      const actor = await authenticate(request);
      await requireDraftRead(manager, actor, request.params.draftId);
      return await store.getConfigurationImpact(request.params.draftId, request.params.kind, repositoryDocument(request.body.document));
    },
  );

  app.put<{ Params: { draftId: string; kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks" }; Body: { expected_fingerprint: string; expected_blob_id: string; document: ConfigurationDocument } }>(
    "/api/drafts/:draftId/config/:kind",
    {
      schema: { body: HTTP_REQUEST_BODY_SCHEMAS.updateConfiguration },
      preValidation: async (request) => { decodeConfigurationDocument(request.body.document); },
    },
    async (request) => {
      const actor = await authenticate(request);
      if (actor.role !== "Maintainer") throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Configuration mutation requires Maintainer");
      return await store.updateConfiguration(
        request.params.draftId,
        actor.userId,
        request.params.kind,
        request.body.expected_fingerprint,
        request.body.expected_blob_id,
        repositoryDocument(request.body.document),
      );
    },
  );
}
