import type { ChangesList, CommentResult, CommitFileDiff, CommitHistoryDetail, CommitHistoryItem, CommitResult, DraftSnapshot, DraftStatus, EntityResult, GitPmDocument, MergeRequestStatus, NotificationsResult, ProjectWorkspaceResult, PublicSession, PushResult, RepositoryConnectionStatus, RepositoryConnectionTest, RepositoryConnectionUpdate, RevertDraftResult, SemanticDiff, ValidationSummary, WriterMode, ChangesSummary, WorktreeDirectory, WorktreeFile } from "./types.js";

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "ApiError";
  }
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
  getConfiguration(draftId: string, kind: "statuses" | "issue-types"): Promise<EntityResult>;
  updateConfiguration(draftId: string, kind: "statuses" | "issue-types", entity: EntityResult, fingerprint: string, document: GitPmDocument): Promise<EntityResult>;
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

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
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
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  async session(): Promise<PublicSession | null> {
    try { return await this.request<PublicSession>("/api/auth/session"); }
    catch (error) { if (error instanceof ApiError && error.code === "SESSION_INVALID") return null; throw error; }
  }

  async login(): Promise<string> {
    return (await this.request<{ authorization_url: string }>("/api/auth/login")).authorization_url;
  }

  async logout(): Promise<void> { await this.request("/api/auth/logout", { method: "POST" }); }
  async repositoryConnection(): Promise<RepositoryConnectionStatus> { return await this.request("/api/repository/connection"); }
  async updateRepositoryConnection(update: RepositoryConnectionUpdate): Promise<RepositoryConnectionStatus> {
    return await this.request("/api/repository/connection", { method: "PUT", body: JSON.stringify(update) });
  }
  async testRepositoryConnection(): Promise<RepositoryConnectionTest> {
    return await this.request("/api/repository/connection/test", { method: "POST" });
  }
  async listDrafts(): Promise<readonly DraftStatus[]> { return await this.request("/api/drafts"); }
  async createDraft(draftId: string): Promise<DraftStatus> {
    return await this.request("/api/drafts", { method: "POST", body: JSON.stringify({ draft_id: draftId }) });
  }

  async snapshot(draftId: string): Promise<DraftSnapshot> {
    const prefix = `/api/drafts/${encodeURIComponent(draftId)}`;
    const draftPromise = this.request<DraftStatus>(prefix);
    const [draft, changes, validation] = await Promise.all([
      draftPromise,
      this.request<ChangesSummary>(`${prefix}/changes`),
      this.request<ValidationSummary>(`${prefix}/validation`),
    ]);
    let mergeRequest: MergeRequestStatus | undefined;
    if (draft.merge_request_iid !== undefined) mergeRequest = await this.request(`${prefix}/merge-request`);
    return { draft, changes, validation, mergeRequest };
  }

  async setWriterMode(draftId: string, writer_mode: WriterMode): Promise<DraftStatus> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/writer-mode`, { method: "PATCH", body: JSON.stringify({ writer_mode }) });
  }

  async acknowledgeExternalChanges(draftId: string): Promise<DraftStatus> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/acknowledge-external-changes`, { method: "POST" });
  }
  async closeDraft(draftId: string): Promise<DraftStatus> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/close`, { method: "POST" });
  }
  async reopenDraft(draftId: string): Promise<DraftStatus> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/reopen`, { method: "POST" });
  }
  async cleanupDraft(draftId: string): Promise<void> {
    await this.request(`/api/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE", body: JSON.stringify({ confirmation: draftId }) });
  }

  async listEntities(draftId: string, entityType: string, project?: string): Promise<readonly EntityResult[]> {
    const query = project === undefined ? "" : `?project=${encodeURIComponent(project)}`;
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/${encodeURIComponent(entityType)}${query}`);
  }
  async projectWorkspace(draftId: string, projectId: string): Promise<ProjectWorkspaceResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/workspace`);
  }
  async createEntity(draftId: string, entityType: string, expected_fingerprint: string, document: GitPmDocument): Promise<EntityResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/${encodeURIComponent(entityType)}`, { method: "POST", body: JSON.stringify({ expected_fingerprint, document }) });
  }
  async updateEntity(draftId: string, entityType: string, entity: EntityResult, expected_fingerprint: string, document: GitPmDocument): Promise<EntityResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entity.document.id)}`, { method: "PUT", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entity.blob_id, document }) });
  }
  async moveTask(draftId: string, entity: EntityResult, expected_fingerprint: string, target_project: string, target_milestone?: string): Promise<EntityResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/tasks/${encodeURIComponent(entity.document.id)}/move`, { method: "POST", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entity.blob_id, target_project, target_milestone }) });
  }
  async archiveEntity(draftId: string, entityType: string, entity: EntityResult, expected_fingerprint: string): Promise<EntityResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entity.document.id)}/archive`, { method: "POST", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entity.blob_id }) });
  }
  async deleteEntity(draftId: string, entityType: string, entity: EntityResult, expected_fingerprint: string, unlinkReferences = false): Promise<void> {
    await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entity.document.id)}`, { method: "DELETE", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entity.blob_id, ...(unlinkReferences ? { unlink_references: true } : {}) }) });
  }
  async getConfiguration(draftId: string, kind: "statuses" | "issue-types"): Promise<EntityResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/config/${kind}`);
  }
  async updateConfiguration(draftId: string, kind: "statuses" | "issue-types", entity: EntityResult, expected_fingerprint: string, document: GitPmDocument): Promise<EntityResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/config/${kind}`, { method: "PUT", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entity.blob_id, document }) });
  }
  async listChanges(draftId: string): Promise<ChangesList> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/changes`);
  }
  async listWorktree(draftId: string, path?: string): Promise<WorktreeDirectory> {
    const query = path === undefined || path === "" ? "" : `?path=${encodeURIComponent(path)}`;
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/worktree${query}`);
  }
  async readWorktreeFile(draftId: string, path: string): Promise<WorktreeFile> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/worktree/file?path=${encodeURIComponent(path)}`);
  }
  async deleteWorktreeEntry(draftId: string, expected_fingerprint: string, path: string): Promise<string> {
    return (await this.request<{ draft_fingerprint: string }>(`/api/drafts/${encodeURIComponent(draftId)}/worktree/entry`, { method: "DELETE", body: JSON.stringify({ expected_fingerprint, path }) })).draft_fingerprint;
  }
  async createWorktreeDirectory(draftId: string, expected_fingerprint: string, path: string): Promise<string> {
    return (await this.request<{ draft_fingerprint: string }>(`/api/drafts/${encodeURIComponent(draftId)}/worktree/directory`, { method: "POST", body: JSON.stringify({ expected_fingerprint, path }) })).draft_fingerprint;
  }
  async uploadWorktreeFile(draftId: string, expected_fingerprint: string, path: string, content_base64: string): Promise<string> {
    return (await this.request<{ draft_fingerprint: string }>(`/api/drafts/${encodeURIComponent(draftId)}/worktree/file`, { method: "POST", body: JSON.stringify({ expected_fingerprint, path, content_base64 }) })).draft_fingerprint;
  }
  async moveWorktreeEntry(draftId: string, expected_fingerprint: string, from: string, to: string): Promise<string> {
    return (await this.request<{ draft_fingerprint: string }>(`/api/drafts/${encodeURIComponent(draftId)}/worktree/move`, { method: "POST", body: JSON.stringify({ expected_fingerprint, from, to }) })).draft_fingerprint;
  }
  async semanticChanges(draftId: string): Promise<SemanticDiff> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/changes/semantic`);
  }
  async restoreFile(draftId: string, expected_fingerprint: string, path: string): Promise<void> {
    await this.request(`/api/drafts/${encodeURIComponent(draftId)}/changes/restore-file`, { method: "POST", body: JSON.stringify({ expected_fingerprint, path }) });
  }
  async restoreHunk(draftId: string, expected_fingerprint: string, path: string, diff_token: string, hunk_index: number): Promise<void> {
    await this.request(`/api/drafts/${encodeURIComponent(draftId)}/changes/restore-hunk`, { method: "POST", body: JSON.stringify({ expected_fingerprint, path, diff_token, hunk_index }) });
  }
  async discardAll(draftId: string, expected_fingerprint: string): Promise<void> {
    await this.request(`/api/drafts/${encodeURIComponent(draftId)}/changes/discard-all`, { method: "POST", body: JSON.stringify({ expected_fingerprint }) });
  }
  async commitAll(draftId: string, message: string): Promise<CommitResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/commit`, { method: "POST", body: JSON.stringify({ message }) });
  }
  async push(draftId: string): Promise<PushResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/push`, { method: "POST" });
  }
  async createMergeRequest(draftId: string, title: string, description?: string): Promise<MergeRequestStatus> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/merge-request`, { method: "POST", body: JSON.stringify({ title, ...(description?.trim() ? { description } : {}) }) });
  }
  async pollMergeRequest(draftId: string): Promise<MergeRequestStatus> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/merge-request`);
  }
  async history(draftId: string): Promise<readonly CommitHistoryItem[]> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/history`);
  }
  async commitDetail(draftId: string, commit: string): Promise<CommitHistoryDetail> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/history/${encodeURIComponent(commit)}`);
  }
  async commitFileDiff(draftId: string, commit: string, path: string): Promise<CommitFileDiff> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/history/${encodeURIComponent(commit)}/file-diff?path=${encodeURIComponent(path)}`);
  }
  async fileHistory(draftId: string, path: string): Promise<readonly CommitHistoryItem[]> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/file-history?path=${encodeURIComponent(path)}`);
  }
  async createRevertDraft(draftId: string, commit: string, draft_id: string): Promise<RevertDraftResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/history/${encodeURIComponent(commit)}/revert`, { method: "POST", body: JSON.stringify({ draft_id }) });
  }
  async listComments(draftId: string, projectId: string, taskId: string): Promise<readonly CommentResult[]> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments`);
  }
  async createComment(draftId: string, projectId: string, taskId: string, expected_fingerprint: string, body_markdown: string): Promise<CommentResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments`, { method: "POST", body: JSON.stringify({ expected_fingerprint, body_markdown }) });
  }
  async updateComment(draftId: string, projectId: string, taskId: string, comment: CommentResult, expected_fingerprint: string, body_markdown: string): Promise<CommentResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(comment.document.id)}`, { method: "PATCH", body: JSON.stringify({ expected_fingerprint, expected_blob_id: comment.blob_id, body_markdown }) });
  }
  async deleteComment(draftId: string, projectId: string, taskId: string, comment: CommentResult, expected_fingerprint: string): Promise<CommentResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(comment.document.id)}`, { method: "DELETE", body: JSON.stringify({ expected_fingerprint, expected_blob_id: comment.blob_id }) });
  }
  async notifications(draftId: string): Promise<NotificationsResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/notifications`);
  }
}
