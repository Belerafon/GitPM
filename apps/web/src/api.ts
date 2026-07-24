import {
  decodeAuthorization,
  decodeChangesList,
  decodeCommentResult,
  decodeCommentResults,
  decodeCommitFileDiff,
  decodeCommitHistoryDetail,
  decodeCommitHistoryItems,
  decodeCommitResult,
  decodeConfigurationResult,
  decodeDraftStatus,
  decodeDraftStatuses,
  decodeEntityResult,
  decodeEntityResults,
  decodeMergeRequestStatus,
  decodeNotifications,
  decodeProjectWorkspace,
  decodePublicSession,
  decodePushResult,
  decodeRepositoryConnectionStatus,
  decodeRepositoryConnectionTest,
  decodeRevertDraftResult,
  decodeSemanticDiff,
  decodeValidationSummary,
  decodeWorktreeDirectory,
  decodeWorktreeEntryMutation,
  decodeWorktreeFile,
  decodeWorktreeFileMutation,
  decodeWorktreeMoveMutation,
  type ConfigurationDocument,
  type ConfigurationResult,
  type Decoder,
} from "@gitpm/contracts";
import type { ChangesList, CommentResult, CommitFileDiff, CommitHistoryDetail, CommitHistoryItem, CommitResult, DraftSnapshot, DraftStatus, EntityResult, GitPmDocument, MergeRequestStatus, NotificationsResult, ProjectWorkspaceResult, PublicSession, PushResult, RepositoryConnectionStatus, RepositoryConnectionTest, RepositoryConnectionUpdate, RevertDraftResult, SemanticDiff, WriterMode, WorktreeDirectory, WorktreeFile } from "./types.js";

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

function errorDetailLine(detail: unknown): string | undefined {
  if (detail === null || typeof detail !== "object") return undefined;
  const value = detail as Readonly<Record<string, unknown>>;
  const code = typeof value.code === "string" ? `[${value.code}]` : "";
  const path = typeof value.path === "string" ? value.path : "";
  const field = typeof value.field === "string" ? `field ${value.field}` : "";
  const location = [path, field].filter(Boolean).join(" · ");
  const message = typeof value.message === "string" ? value.message : "";
  const expected = typeof value.expected === "string" ? `expected ${value.expected}` : "";
  const explanation = [message, expected].filter(Boolean).join("; ");
  const prefix = [code, location].filter(Boolean).join(" ");
  if (prefix === "" && explanation === "") return undefined;
  return `${prefix}${prefix !== "" && explanation !== "" ? " — " : ""}${explanation}`;
}

export function formatApiError(reason: unknown): string {
  if (!(reason instanceof ApiError)) return reason instanceof Error ? reason.message : String(reason);
  const heading = `[${reason.code}] ${reason.message}`;
  if (!Array.isArray(reason.details)) return heading;
  const lines = reason.details.map(errorDetailLine).filter((line): line is string => line !== undefined);
  return lines.length === 0 ? heading : [heading, ...lines.map((line) => `- ${line}`)].join("\n");
}

export interface GitPmApi {
  session(): Promise<PublicSession | null>;
  login(): Promise<string>;
  logout(): Promise<void>;
  repositoryConnection(): Promise<RepositoryConnectionStatus>;
  updateRepositoryConnection(update: RepositoryConnectionUpdate): Promise<RepositoryConnectionStatus>;
  testRepositoryConnection(): Promise<RepositoryConnectionTest>;
  listDrafts(): Promise<readonly DraftStatus[]>;
  createDraft(draftId: string): Promise<DraftStatus>;
  snapshot(draftId: string): Promise<DraftSnapshot>;
  setWriterMode(draftId: string, mode: WriterMode): Promise<DraftStatus>;
  acknowledgeExternalChanges(draftId: string): Promise<DraftStatus>;
  closeDraft(draftId: string): Promise<DraftStatus>;
  reopenDraft(draftId: string): Promise<DraftStatus>;
  cleanupDraft(draftId: string): Promise<void>;
  listEntities(draftId: string, entityType: string, project?: string): Promise<readonly EntityResult[]>;
  projectWorkspace(draftId: string, projectId: string): Promise<ProjectWorkspaceResult>;
  createEntity(draftId: string, entityType: string, fingerprint: string, document: GitPmDocument): Promise<EntityResult>;
  updateEntity(draftId: string, entityType: string, entity: EntityResult, fingerprint: string, document: GitPmDocument): Promise<EntityResult>;
  moveTask(draftId: string, entity: EntityResult, fingerprint: string, targetProject: string, targetMilestone?: string): Promise<EntityResult>;
  archiveEntity(draftId: string, entityType: string, entity: EntityResult, fingerprint: string): Promise<EntityResult>;
  deleteEntity(draftId: string, entityType: string, entity: EntityResult, fingerprint: string, unlinkReferences?: boolean): Promise<void>;
  getConfiguration(draftId: string, kind: "statuses" | "issue-types"): Promise<ConfigurationResult>;
  updateConfiguration(draftId: string, kind: "statuses" | "issue-types", entity: ConfigurationResult, fingerprint: string, document: ConfigurationDocument): Promise<ConfigurationResult>;
  listChanges(draftId: string): Promise<ChangesList>;
  listWorktree(draftId: string, path?: string): Promise<WorktreeDirectory>;
  readWorktreeFile(draftId: string, path: string): Promise<WorktreeFile>;
  deleteWorktreeEntry(draftId: string, fingerprint: string, path: string): Promise<string>;
  createWorktreeDirectory(draftId: string, fingerprint: string, path: string): Promise<string>;
  uploadWorktreeFile(draftId: string, fingerprint: string, path: string, contentBase64: string): Promise<string>;
  moveWorktreeEntry(draftId: string, fingerprint: string, from: string, to: string): Promise<string>;
  semanticChanges(draftId: string): Promise<SemanticDiff>;
  restoreFile(draftId: string, fingerprint: string, path: string): Promise<void>;
  restoreHunk(draftId: string, fingerprint: string, path: string, diffToken: string, hunkIndex: number): Promise<void>;
  discardAll(draftId: string, fingerprint: string): Promise<void>;
  commitAll(draftId: string, message: string): Promise<CommitResult>;
  push(draftId: string): Promise<PushResult>;
  createMergeRequest(draftId: string, title: string, description?: string): Promise<MergeRequestStatus>;
  pollMergeRequest(draftId: string): Promise<MergeRequestStatus>;
  history(draftId: string): Promise<readonly CommitHistoryItem[]>;
  commitDetail(draftId: string, commit: string): Promise<CommitHistoryDetail>;
  commitFileDiff(draftId: string, commit: string, path: string): Promise<CommitFileDiff>;
  fileHistory(draftId: string, path: string): Promise<readonly CommitHistoryItem[]>;
  createRevertDraft(draftId: string, commit: string, newDraftId: string): Promise<RevertDraftResult>;
  listComments(draftId: string, projectId: string, taskId: string): Promise<readonly CommentResult[]>;
  createComment(draftId: string, projectId: string, taskId: string, fingerprint: string, bodyMarkdown: string): Promise<CommentResult>;
  updateComment(draftId: string, projectId: string, taskId: string, comment: CommentResult, fingerprint: string, bodyMarkdown: string): Promise<CommentResult>;
  deleteComment(draftId: string, projectId: string, taskId: string, comment: CommentResult, fingerprint: string): Promise<CommentResult>;
  notifications(draftId: string): Promise<NotificationsResult>;
}

interface ErrorBody { readonly error?: { readonly code?: string; readonly message?: string; readonly details?: unknown } }

export class HttpGitPmApi implements GitPmApi {
  constructor(private readonly baseUrl = "") {}

  private async request<T>(path: string, decoder: Decoder<T>, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers,
    });
    if (!response.ok) {
      let body: ErrorBody = {};
      try { body = await response.json() as ErrorBody; } catch { /* stable fallback below */ }
      throw new ApiError(body.error?.code ?? `HTTP_${response.status}`, body.error?.message ?? response.statusText, body.error?.details);
    }
    return decoder(await response.json());
  }

  private async requestEmpty(path: string, init?: RequestInit): Promise<void> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers: init?.body === undefined ? init?.headers : { "content-type": "application/json", ...init.headers },
    });
    if (!response.ok) {
      let body: ErrorBody = {};
      try { body = await response.json() as ErrorBody; } catch { /* stable fallback below */ }
      throw new ApiError(body.error?.code ?? `HTTP_${response.status}`, body.error?.message ?? response.statusText, body.error?.details);
    }
  }

  async session(): Promise<PublicSession | null> {
    try { return await this.request("/api/auth/session", decodePublicSession); }
    catch (error) { if (error instanceof ApiError && error.code === "SESSION_INVALID") return null; throw error; }
  }

  async login(): Promise<string> {
    return (await this.request("/api/auth/login", decodeAuthorization)).authorization_url;
  }

  async logout(): Promise<void> { await this.requestEmpty("/api/auth/logout", { method: "POST" }); }
  async repositoryConnection(): Promise<RepositoryConnectionStatus> { return await this.request("/api/repository/connection", decodeRepositoryConnectionStatus); }
  async updateRepositoryConnection(update: RepositoryConnectionUpdate): Promise<RepositoryConnectionStatus> {
    return await this.request("/api/repository/connection", decodeRepositoryConnectionStatus, { method: "PUT", body: JSON.stringify(update) });
  }
  async testRepositoryConnection(): Promise<RepositoryConnectionTest> {
    return await this.request("/api/repository/connection/test", decodeRepositoryConnectionTest, { method: "POST" });
  }
  async listDrafts(): Promise<readonly DraftStatus[]> { return await this.request("/api/drafts", decodeDraftStatuses); }
  async createDraft(draftId: string): Promise<DraftStatus> {
    return await this.request("/api/drafts", decodeDraftStatus, { method: "POST", body: JSON.stringify({ draft_id: draftId }) });
  }

  async snapshot(draftId: string): Promise<DraftSnapshot> {
    const prefix = `/api/drafts/${encodeURIComponent(draftId)}`;
    const draftPromise = this.request(prefix, decodeDraftStatus);
    const [draft, changes, validation] = await Promise.all([
      draftPromise,
      this.request(`${prefix}/changes`, decodeChangesList),
      this.request(`${prefix}/validation`, decodeValidationSummary),
    ]);
    let mergeRequest: MergeRequestStatus | undefined;
    if (draft.merge_request_iid !== undefined) mergeRequest = await this.request(`${prefix}/merge-request`, decodeMergeRequestStatus);
    return { draft, changes, validation, mergeRequest };
  }

  async setWriterMode(draftId: string, writer_mode: WriterMode): Promise<DraftStatus> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/writer-mode`, decodeDraftStatus, { method: "PATCH", body: JSON.stringify({ writer_mode }) });
  }

  async acknowledgeExternalChanges(draftId: string): Promise<DraftStatus> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/acknowledge-external-changes`, decodeDraftStatus, { method: "POST" });
  }
  async closeDraft(draftId: string): Promise<DraftStatus> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/close`, decodeDraftStatus, { method: "POST" });
  }
  async reopenDraft(draftId: string): Promise<DraftStatus> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/reopen`, decodeDraftStatus, { method: "POST" });
  }
  async cleanupDraft(draftId: string): Promise<void> {
    await this.requestEmpty(`/api/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE", body: JSON.stringify({ confirmation: draftId }) });
  }

  async listEntities(draftId: string, entityType: string, project?: string): Promise<readonly EntityResult[]> {
    const query = project === undefined ? "" : `?project=${encodeURIComponent(project)}`;
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/${encodeURIComponent(entityType)}${query}`, decodeEntityResults);
  }
  async projectWorkspace(draftId: string, projectId: string): Promise<ProjectWorkspaceResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/workspace`, decodeProjectWorkspace);
  }
  async createEntity(draftId: string, entityType: string, expected_fingerprint: string, document: GitPmDocument): Promise<EntityResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/${encodeURIComponent(entityType)}`, decodeEntityResult, { method: "POST", body: JSON.stringify({ expected_fingerprint, document }) });
  }
  async updateEntity(draftId: string, entityType: string, entity: EntityResult, expected_fingerprint: string, document: GitPmDocument): Promise<EntityResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entity.document.id)}`, decodeEntityResult, { method: "PUT", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entity.blob_id, document }) });
  }
  async moveTask(draftId: string, entity: EntityResult, expected_fingerprint: string, target_project: string, target_milestone?: string): Promise<EntityResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/tasks/${encodeURIComponent(entity.document.id)}/move`, decodeEntityResult, { method: "POST", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entity.blob_id, target_project, target_milestone }) });
  }
  async archiveEntity(draftId: string, entityType: string, entity: EntityResult, expected_fingerprint: string): Promise<EntityResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entity.document.id)}/archive`, decodeEntityResult, { method: "POST", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entity.blob_id }) });
  }
  async deleteEntity(draftId: string, entityType: string, entity: EntityResult, expected_fingerprint: string, unlinkReferences = false): Promise<void> {
    await this.requestEmpty(`/api/drafts/${encodeURIComponent(draftId)}/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entity.document.id)}`, { method: "DELETE", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entity.blob_id, ...(unlinkReferences ? { unlink_references: true } : {}) }) });
  }
  async getConfiguration(draftId: string, kind: "statuses" | "issue-types"): Promise<ConfigurationResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/config/${kind}`, decodeConfigurationResult);
  }
  async updateConfiguration(draftId: string, kind: "statuses" | "issue-types", entity: ConfigurationResult, expected_fingerprint: string, document: ConfigurationDocument): Promise<ConfigurationResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/config/${kind}`, decodeConfigurationResult, { method: "PUT", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entity.blob_id, document }) });
  }
  async listChanges(draftId: string): Promise<ChangesList> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/changes`, decodeChangesList);
  }
  async listWorktree(draftId: string, path?: string): Promise<WorktreeDirectory> {
    const query = path === undefined || path === "" ? "" : `?path=${encodeURIComponent(path)}`;
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/worktree${query}`, decodeWorktreeDirectory);
  }
  async readWorktreeFile(draftId: string, path: string): Promise<WorktreeFile> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/worktree/file?path=${encodeURIComponent(path)}`, decodeWorktreeFile);
  }
  async deleteWorktreeEntry(draftId: string, expected_fingerprint: string, path: string): Promise<string> {
    return (await this.request(`/api/drafts/${encodeURIComponent(draftId)}/worktree/entry`, decodeWorktreeEntryMutation, { method: "DELETE", body: JSON.stringify({ expected_fingerprint, path }) })).draft_fingerprint;
  }
  async createWorktreeDirectory(draftId: string, expected_fingerprint: string, path: string): Promise<string> {
    return (await this.request(`/api/drafts/${encodeURIComponent(draftId)}/worktree/directory`, decodeWorktreeEntryMutation, { method: "POST", body: JSON.stringify({ expected_fingerprint, path }) })).draft_fingerprint;
  }
  async uploadWorktreeFile(draftId: string, expected_fingerprint: string, path: string, content_base64: string): Promise<string> {
    return (await this.request(`/api/drafts/${encodeURIComponent(draftId)}/worktree/file`, decodeWorktreeFileMutation, { method: "POST", body: JSON.stringify({ expected_fingerprint, path, content_base64 }) })).draft_fingerprint;
  }
  async moveWorktreeEntry(draftId: string, expected_fingerprint: string, from: string, to: string): Promise<string> {
    return (await this.request(`/api/drafts/${encodeURIComponent(draftId)}/worktree/move`, decodeWorktreeMoveMutation, { method: "POST", body: JSON.stringify({ expected_fingerprint, from, to }) })).draft_fingerprint;
  }
  async semanticChanges(draftId: string): Promise<SemanticDiff> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/changes/semantic`, decodeSemanticDiff);
  }
  async restoreFile(draftId: string, expected_fingerprint: string, path: string): Promise<void> {
    await this.requestEmpty(`/api/drafts/${encodeURIComponent(draftId)}/changes/restore-file`, { method: "POST", body: JSON.stringify({ expected_fingerprint, path }) });
  }
  async restoreHunk(draftId: string, expected_fingerprint: string, path: string, diff_token: string, hunk_index: number): Promise<void> {
    await this.requestEmpty(`/api/drafts/${encodeURIComponent(draftId)}/changes/restore-hunk`, { method: "POST", body: JSON.stringify({ expected_fingerprint, path, diff_token, hunk_index }) });
  }
  async discardAll(draftId: string, expected_fingerprint: string): Promise<void> {
    await this.requestEmpty(`/api/drafts/${encodeURIComponent(draftId)}/changes/discard-all`, { method: "POST", body: JSON.stringify({ expected_fingerprint }) });
  }
  async commitAll(draftId: string, message: string): Promise<CommitResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/commit`, decodeCommitResult, { method: "POST", body: JSON.stringify({ message }) });
  }
  async push(draftId: string): Promise<PushResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/push`, decodePushResult, { method: "POST" });
  }
  async createMergeRequest(draftId: string, title: string, description?: string): Promise<MergeRequestStatus> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/merge-request`, decodeMergeRequestStatus, { method: "POST", body: JSON.stringify({ title, ...(description?.trim() ? { description } : {}) }) });
  }
  async pollMergeRequest(draftId: string): Promise<MergeRequestStatus> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/merge-request`, decodeMergeRequestStatus);
  }
  async history(draftId: string): Promise<readonly CommitHistoryItem[]> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/history`, decodeCommitHistoryItems);
  }
  async commitDetail(draftId: string, commit: string): Promise<CommitHistoryDetail> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/history/${encodeURIComponent(commit)}`, decodeCommitHistoryDetail);
  }
  async commitFileDiff(draftId: string, commit: string, path: string): Promise<CommitFileDiff> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/history/${encodeURIComponent(commit)}/file-diff?path=${encodeURIComponent(path)}`, decodeCommitFileDiff);
  }
  async fileHistory(draftId: string, path: string): Promise<readonly CommitHistoryItem[]> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/file-history?path=${encodeURIComponent(path)}`, decodeCommitHistoryItems);
  }
  async createRevertDraft(draftId: string, commit: string, draft_id: string): Promise<RevertDraftResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/history/${encodeURIComponent(commit)}/revert`, decodeRevertDraftResult, { method: "POST", body: JSON.stringify({ draft_id }) });
  }
  async listComments(draftId: string, projectId: string, taskId: string): Promise<readonly CommentResult[]> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments`, decodeCommentResults);
  }
  async createComment(draftId: string, projectId: string, taskId: string, expected_fingerprint: string, body_markdown: string): Promise<CommentResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments`, decodeCommentResult, { method: "POST", body: JSON.stringify({ expected_fingerprint, body_markdown }) });
  }
  async updateComment(draftId: string, projectId: string, taskId: string, comment: CommentResult, expected_fingerprint: string, body_markdown: string): Promise<CommentResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(comment.document.id)}`, decodeCommentResult, { method: "PATCH", body: JSON.stringify({ expected_fingerprint, expected_blob_id: comment.blob_id, body_markdown }) });
  }
  async deleteComment(draftId: string, projectId: string, taskId: string, comment: CommentResult, expected_fingerprint: string): Promise<CommentResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(comment.document.id)}`, decodeCommentResult, { method: "DELETE", body: JSON.stringify({ expected_fingerprint, expected_blob_id: comment.blob_id }) });
  }
  async notifications(draftId: string): Promise<NotificationsResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/notifications`, decodeNotifications);
  }
}
