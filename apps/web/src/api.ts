import {
  decodeAuthorization,
  decodeChangesList,
  decodeCommentResult,
  decodeCommentResults,
  decodeCommitFileDiff,
  decodeCommitHistoryDetail,
  decodeCommitHistoryItems,
  decodeCommitResult,
  decodeConfigurationImpact,
  decodeConfigurationResult,
  decodeDraftStatus,
    decodeDraftStatuses,
    decodeDirectRevertResult,
  decodeEntityResult,
  decodeEntityResults,
  decodeGlobalSearchResult,
  decodeMergeRequestStatus,
  decodeNotifications,
  decodeProjectWorkspace,
  decodeProjectFileDeleteResult,
  decodeProjectFileList,
  decodeProjectFileReferencePreview,
  decodeProjectFileReplaceResult,
  decodeProjectFileRenameResult,
  decodeProjectFileUploadResult,
  decodePublicSession,
  decodePushResult,
  decodeRepositoryConnectionStatus,
  decodeRepositoryConnectionTest,
  decodeRepositoryResult,
    decodeRevertDraftResult,
    decodeRestoreCommitFilesResult,
  decodeSemanticDiff,
  decodeValidationSummary,
  decodeWorktreeDirectory,
  decodeWorktreeEntryMutation,
  decodeWorktreeFile,
  decodeWorktreeFileMutation,
  decodeWorktreeMoveMutation,
  decodeWorkloadReport,
  decodeTimeEntryDocument,
  type ConfigurationDocument,
  type ConfigurationResult,
  type Decoder,
  type ProjectFileList,
  type ProjectFileReferencePreview,
  type ProjectFileReplaceResult,
  type ProjectFileRenameReferenceMode,
  type ProjectFileDeleteReferenceMode,
  type ProjectFileDeleteResult,
  type ProjectFileRenameResult,
  type ProjectFileUploadResult,
} from "@gitpm/contracts";
import type { ChangesList, CommentResult, CommitFileDiff, CommitHistoryDetail, CommitHistoryItem, CommitResult, ConfigurationImpact, DirectRevertResult, DraftSnapshot, DraftStatus, EntityResult, GitPmDocument, GlobalSearchResult, MergeRequestStatus, NotificationsResult, ProjectWorkspaceResult, PublicSession, PushResult, RepositoryConnectionStatus, RepositoryConnectionTest, RepositoryConnectionUpdate, RepositoryDocument, RepositoryResult, RestoreCommitFilesResult, RevertDraftResult, SemanticDiff, TimeEntryDocument, WorkloadReport, WriterMode, WorktreeDirectory, WorktreeFile } from "./types.js";

export interface TimeEntryResult {
  readonly document: TimeEntryDocument;
  readonly path: string;
  readonly blob_id: string;
  readonly draft_fingerprint: string;
}

export interface TimeEntryReplacementResult {
  readonly voided: TimeEntryResult;
  readonly created: TimeEntryResult;
}

function asTimeEntryResult(input: unknown): TimeEntryResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new ApiError("API_RESPONSE_CONTRACT_INVALID", "TimeEntryResult: expected an object");
  const value = input as Record<string, unknown>;
  return {
    document: decodeTimeEntryDocument(value.document),
    path: String(value.path ?? ""),
    blob_id: String(value.blob_id ?? ""),
    draft_fingerprint: String(value.draft_fingerprint ?? ""),
  };
}

const decodeTimeEntryResult: Decoder<TimeEntryResult> = (input) => asTimeEntryResult(input);
const decodeTimeEntryResults: Decoder<readonly TimeEntryResult[]> = (input) =>
  Array.isArray(input) ? input.map(asTimeEntryResult) : (() => { throw new ApiError("API_RESPONSE_CONTRACT_INVALID", "TimeEntryResult[]: expected an array"); })();
const decodeTimeEntryReplacementResult: Decoder<TimeEntryReplacementResult> = (input) => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new ApiError("API_RESPONSE_CONTRACT_INVALID", "TimeEntryReplacementResult: expected an object");
  const value = input as Record<string, unknown>;
  return { voided: asTimeEntryResult(value.voided), created: asTimeEntryResult(value.created) };
};

export interface TimeEntryProjectList {
  readonly items: readonly TimeEntryResult[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}

export type ProjectTimeEntryFilters = {
  readonly task?: string;
  readonly milestone?: string;
  readonly person?: string;
  readonly category?: string;
  readonly performed_from?: string;
  readonly performed_to?: string;
  readonly state?: "active" | "voided";
  readonly offset?: number;
  readonly limit?: number;
};

function asTimeEntryProjectList(input: unknown): TimeEntryProjectList {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new ApiError("API_RESPONSE_CONTRACT_INVALID", "TimeEntryProjectList: expected an object");
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.items) || typeof value.total !== "number" || !Number.isInteger(value.total) || typeof value.offset !== "number" || !Number.isInteger(value.offset) || typeof value.limit !== "number" || !Number.isInteger(value.limit)) throw new ApiError("API_RESPONSE_CONTRACT_INVALID", "TimeEntryProjectList: invalid pagination envelope");
  return { items: value.items.map(asTimeEntryResult), total: value.total, offset: value.offset, limit: value.limit };
}

const decodeTimeEntryProjectList: Decoder<TimeEntryProjectList> = (input) => asTimeEntryProjectList(input);

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export type ExportFormat = "pdf" | "html" | "csv" | "xlsx" | "repository";
export type ExportSection =
  | "portfolio"
  | "project-plan"
  | "plan-fact"
  | "workload"
  | "vacations"
  | "person-profile"
  | "audit"
  | "projects"
  | "people"
  | "project-details"
  | "gantt";
export interface ExportOptions {
  readonly format: ExportFormat;
  readonly locale: string;
  readonly sections?: readonly ExportSection[];
  readonly includeGit?: boolean;
  readonly scope?: "portfolio" | "project" | "person" | "team";
  readonly project?: string;
  readonly person?: string;
  readonly team?: string;
  readonly asOf?: string;
  readonly periodStart?: string;
  readonly periodFinish?: string;
  readonly lifecycle?: "active" | "archived" | "all";
  readonly includeEmail?: boolean;
  readonly hidePersonalData?: boolean;
  readonly pageSize?: "A4" | "Letter";
  readonly density?: "compact" | "detailed";
}
export interface ExportDownload {
  readonly blob: Blob;
  readonly filename: string;
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

export function deleteRestrictionLabels(details: unknown): readonly string[] {
  if (!Array.isArray(details)) return [];
  return [...new Set(details.flatMap((detail) => {
    if (detail === null || typeof detail !== "object") return [];
    const value = detail as { readonly label?: unknown; readonly path?: unknown };
    if (typeof value.path !== "string") return [];
    return [typeof value.label === "string" && value.label.trim() !== "" ? `${value.label} (${value.path})` : value.path];
  }))];
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
  exportData?(draftId: string, options: ExportOptions): Promise<ExportDownload>;
  listEntities(draftId: string, entityType: string, project?: string): Promise<readonly EntityResult[]>;
  searchEntities?(draftId: string, query: string, limit?: number): Promise<GlobalSearchResult>;
  getEntity(draftId: string, entityType: string, id: string): Promise<EntityResult>;
  projectWorkspace(draftId: string, projectId: string): Promise<ProjectWorkspaceResult>;
  listProjectFiles(draftId: string, projectId: string): Promise<ProjectFileList>;
  projectFileReferences(draftId: string, projectId: string, name: string): Promise<ProjectFileReferencePreview>;
  replaceProjectFile(draftId: string, projectId: string, previousName: string, expectedFingerprint: string, file: Blob, newName: string, options?: Omit<ProjectFileUploadOptions, "referenceMode">): Promise<ProjectFileReplaceResult>;
  uploadProjectFile(draftId: string, projectId: string, expectedFingerprint: string, file: Blob, name: string, mode: "create" | "replace", options?: ProjectFileUploadOptions): Promise<ProjectFileUploadResult>;
  renameProjectFile(draftId: string, projectId: string, name: string, expectedFingerprint: string, newName: string, referenceMode?: ProjectFileRenameReferenceMode): Promise<ProjectFileRenameResult>;
  deleteProjectFile(draftId: string, projectId: string, name: string, expectedFingerprint: string, confirmationName: string, referenceMode?: ProjectFileDeleteReferenceMode): Promise<ProjectFileDeleteResult>;
  createEntity(draftId: string, entityType: string, fingerprint: string, document: GitPmDocument): Promise<EntityResult>;
  updateEntity(draftId: string, entityType: string, entity: EntityResult, fingerprint: string, document: GitPmDocument): Promise<EntityResult>;
  moveTask(draftId: string, entity: EntityResult, fingerprint: string, targetProject: string, targetMilestone?: string, targetParent?: string): Promise<EntityResult>;
  archiveEntity(draftId: string, entityType: string, entity: EntityResult, fingerprint: string, options?: LifecycleMutationOptions): Promise<EntityResult>;
  restoreEntity(draftId: string, entityType: string, entity: EntityResult, fingerprint: string, options?: LifecycleMutationOptions): Promise<EntityResult>;
  deleteEntity(draftId: string, entityType: string, entity: EntityResult, fingerprint: string, unlinkReferences?: boolean, cascadeReferences?: boolean): Promise<void>;
  getConfiguration(draftId: string, kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks"): Promise<ConfigurationResult>;
  getRepositoryConfiguration(draftId: string): Promise<RepositoryResult>;
  getConfigurationImpact(draftId: string, kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks", document: ConfigurationDocument): Promise<ConfigurationImpact>;
  updateConfiguration(draftId: string, kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks", entity: ConfigurationResult, fingerprint: string, document: ConfigurationDocument): Promise<ConfigurationResult>;
  updateRepositoryConfiguration(draftId: string, entity: RepositoryResult, fingerprint: string, document: RepositoryDocument): Promise<RepositoryResult>;
  listChanges(draftId: string): Promise<ChangesList>;
  listWorktree(draftId: string, path?: string): Promise<WorktreeDirectory>;
  readWorktreeFile(draftId: string, path: string): Promise<WorktreeFile>;
  downloadWorktreeFile(draftId: string, path: string): Promise<ExportDownload>;
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
  restoreCommitFiles(draftId: string, commit: string, expectedFingerprint: string, paths: readonly string[]): Promise<RestoreCommitFilesResult>;
  revertDirect(draftId: string, commit: string, expectedFingerprint: string, message: string): Promise<DirectRevertResult>;
  listComments(draftId: string, projectId: string, taskId: string): Promise<readonly CommentResult[]>;
  createComment(draftId: string, projectId: string, taskId: string, fingerprint: string, bodyMarkdown: string): Promise<CommentResult>;
  updateComment(draftId: string, projectId: string, taskId: string, comment: CommentResult, fingerprint: string, bodyMarkdown: string): Promise<CommentResult>;
  deleteComment(draftId: string, projectId: string, taskId: string, comment: CommentResult, fingerprint: string): Promise<CommentResult>;
  notifications(draftId: string): Promise<NotificationsResult>;
  markNotificationsRead(draftId: string, keys: readonly string[]): Promise<NotificationsResult>;
  listTimeEntries(draftId: string, projectId: string, taskId: string): Promise<readonly TimeEntryResult[]>;
  listProjectTimeEntries(draftId: string, projectId: string, filters?: ProjectTimeEntryFilters): Promise<TimeEntryProjectList>;
  createTimeEntry(draftId: string, projectId: string, taskId: string, fingerprint: string, input: { readonly person: string; readonly performed_on: string; readonly hours: number; readonly category: string; readonly note_markdown?: string }): Promise<TimeEntryResult>;
  voidTimeEntry(draftId: string, projectId: string, taskId: string, entry: TimeEntryResult, fingerprint: string): Promise<TimeEntryResult>;
  replaceTimeEntry(draftId: string, projectId: string, taskId: string, entry: TimeEntryResult, fingerprint: string, input: { readonly person: string; readonly performed_on: string; readonly hours: number; readonly category: string; readonly note_markdown?: string }): Promise<TimeEntryReplacementResult>;
}

export interface ProjectFileUploadOptions {
  readonly largeFileConfirmation?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (loaded: number, total: number) => void;
  readonly referenceMode?: "preserve_checked" | "ignore_unchecked";
}

function projectFilePath(draftId: string, projectId: string, name: string): string {
  return `/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(name)}`;
}

export function projectFileContentUrl(draftId: string, projectId: string, name: string): string {
  return `${projectFilePath(draftId, projectId, name)}/content`;
}

export function projectFileDownloadUrl(draftId: string, projectId: string, name: string): string {
  return `${projectFilePath(draftId, projectId, name)}/download`;
}

export interface LifecycleMutationOptions {
  readonly includeTasks?: boolean;
  readonly restoreMilestone?: boolean;
}

export async function listAllProjectTimeEntries(api: Pick<GitPmApi, "listProjectTimeEntries">, draftId: string, projectId: string, filters: ProjectTimeEntryFilters = {}): Promise<readonly TimeEntryResult[]> {
  const items: TimeEntryResult[] = [];
  const limit = filters.limit ?? 200;
  let offset = filters.offset ?? 0;
  while (true) {
    const page = await api.listProjectTimeEntries(draftId, projectId, { ...filters, offset, limit });
    items.push(...page.items);
    const nextOffset = page.offset + page.items.length;
    if (nextOffset >= page.total) return items;
    if (page.items.length === 0 || nextOffset <= offset) throw new ApiError("TIME_ENTRY_PAGINATION_STALLED", "Project time-entry pagination did not advance");
    offset = nextOffset;
  }
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

  private async requestDownload(path: string, invalidFilenameCode = "EXPORT_FILENAME_INVALID"): Promise<ExportDownload> {
    const response = await fetch(`${this.baseUrl}${path}`, { credentials: "include" });
    if (!response.ok) {
      let body: ErrorBody = {};
      try { body = await response.json() as ErrorBody; } catch { /* stable fallback below */ }
      throw new ApiError(body.error?.code ?? `HTTP_${response.status}`, body.error?.message ?? response.statusText, body.error?.details);
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const extended = /filename\*\s*=\s*UTF-8''([^;]+)/iu.exec(disposition)?.[1]?.trim();
    let filename: string | undefined;
    try {
      filename = extended === undefined ? undefined : decodeURIComponent(extended);
    } catch {
      filename = undefined;
    }
    filename ??= /filename\s*=\s*"([^"]+)"/iu.exec(disposition)?.[1];
    if (filename === undefined || filename === "" || filename === "." || filename === ".." || /[\/\\\u0000-\u001f\u007f]/u.test(filename)) {
      throw new ApiError(invalidFilenameCode, "Download response has no safe filename");
    }
    return { blob: await response.blob(), filename };
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
  async exportData(draftId: string, options: ExportOptions): Promise<ExportDownload> {
    const query = new URLSearchParams({ format: options.format, locale: options.locale });
    if (options.sections !== undefined) query.set("sections", options.sections.join(","));
    if (options.includeGit !== undefined) query.set("include_git", String(options.includeGit));
    if (options.scope !== undefined) query.set("scope", options.scope);
    if (options.project !== undefined) query.set("project", options.project);
    if (options.person !== undefined) query.set("person", options.person);
    if (options.team !== undefined) query.set("team", options.team);
    if (options.asOf !== undefined) query.set("as_of", options.asOf);
    if (options.periodStart !== undefined) query.set("period_start", options.periodStart);
    if (options.periodFinish !== undefined) query.set("period_finish", options.periodFinish);
    if (options.lifecycle !== undefined) query.set("lifecycle", options.lifecycle);
    if (options.includeEmail !== undefined) query.set("include_email", String(options.includeEmail));
    if (options.hidePersonalData !== undefined) query.set("hide_personal_data", String(options.hidePersonalData));
    if (options.pageSize !== undefined) query.set("page_size", options.pageSize);
    if (options.density !== undefined) query.set("density", options.density);
    return await this.requestDownload(`/api/drafts/${encodeURIComponent(draftId)}/export?${query.toString()}`);
  }

  async listEntities(draftId: string, entityType: string, project?: string): Promise<readonly EntityResult[]> {
    const query = project === undefined ? "" : `?project=${encodeURIComponent(project)}`;
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/${encodeURIComponent(entityType)}${query}`, decodeEntityResults);
  }
  async searchEntities(draftId: string, search: string, limit = 20): Promise<GlobalSearchResult> {
    const query = new URLSearchParams({ q: search, limit: String(limit) });
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/search?${query.toString()}`, decodeGlobalSearchResult);
  }
  async workload(draftId: string, filters: { readonly project?: string; readonly milestone?: string; readonly team?: string } = {}): Promise<WorkloadReport> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== undefined) query.set(key, value);
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/workload${suffix}`, decodeWorkloadReport);
  }
  async getEntity(draftId: string, entityType: string, id: string): Promise<EntityResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(id)}`, decodeEntityResult);
  }
  async projectWorkspace(draftId: string, projectId: string): Promise<ProjectWorkspaceResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/workspace`, decodeProjectWorkspace);
  }
  async listProjectFiles(draftId: string, projectId: string): Promise<ProjectFileList> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/files`, decodeProjectFileList);
  }
  async projectFileReferences(draftId: string, projectId: string, name: string): Promise<ProjectFileReferencePreview> {
    return await this.request(`${projectFilePath(draftId, projectId, name)}/references`, decodeProjectFileReferencePreview);
  }
  async replaceProjectFile(draftId: string, projectId: string, previousName: string, expectedFingerprint: string, file: Blob, newName: string, options: Omit<ProjectFileUploadOptions, "referenceMode"> = {}): Promise<ProjectFileReplaceResult> {
    const endpoint = `${this.baseUrl}${projectFilePath(draftId, projectId, previousName)}/replace`;
    return await new Promise<ProjectFileReplaceResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const finish = () => options.signal?.removeEventListener("abort", abort);
      xhr.open("POST", endpoint);
      xhr.withCredentials = true;
      xhr.setRequestHeader("content-type", "application/octet-stream");
      xhr.setRequestHeader("x-gitpm-file-name", encodeURIComponent(newName));
      xhr.setRequestHeader("x-gitpm-upload-size", String(file.size));
      xhr.setRequestHeader("x-gitpm-expected-fingerprint", expectedFingerprint);
      if (options.largeFileConfirmation !== undefined) xhr.setRequestHeader("x-gitpm-large-file-confirmation", encodeURIComponent(options.largeFileConfirmation));
      xhr.upload.addEventListener("progress", (event) => options.onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size));
      xhr.addEventListener("load", () => {
        finish();
        let body: unknown;
        try { body = JSON.parse(xhr.responseText); } catch { body = undefined; }
        if (xhr.status < 200 || xhr.status >= 300) {
          const error = body !== null && typeof body === "object" ? (body as ErrorBody).error : undefined;
          reject(new ApiError(error?.code ?? `HTTP_${xhr.status}`, error?.message ?? xhr.statusText, error?.details));
          return;
        }
        try { resolve(decodeProjectFileReplaceResult(body)); } catch (error) { reject(error); }
      });
      xhr.addEventListener("error", () => { finish(); reject(new ApiError("NETWORK_ERROR", "Project file replacement failed")); });
      xhr.addEventListener("abort", () => { finish(); reject(new DOMException("Project file replacement was cancelled", "AbortError")); });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted === true) abort(); else xhr.send(file);
    });
  }
  async uploadProjectFile(draftId: string, projectId: string, expectedFingerprint: string, file: Blob, name: string, mode: "create" | "replace", options: ProjectFileUploadOptions = {}): Promise<ProjectFileUploadResult> {
    const path = `${this.baseUrl}/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/files/upload`;
    return await new Promise<ProjectFileUploadResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const finish = () => options.signal?.removeEventListener("abort", abort);
      xhr.open("POST", path);
      xhr.withCredentials = true;
      xhr.setRequestHeader("content-type", "application/octet-stream");
      xhr.setRequestHeader("x-gitpm-file-name", encodeURIComponent(name));
      xhr.setRequestHeader("x-gitpm-upload-size", String(file.size));
      xhr.setRequestHeader("x-gitpm-expected-fingerprint", expectedFingerprint);
      xhr.setRequestHeader("x-gitpm-upload-mode", mode);
      if (options.referenceMode !== undefined) xhr.setRequestHeader("x-gitpm-reference-mode", options.referenceMode);
      if (options.largeFileConfirmation !== undefined) xhr.setRequestHeader("x-gitpm-large-file-confirmation", encodeURIComponent(options.largeFileConfirmation));
      xhr.upload.addEventListener("progress", (event) => options.onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size));
      xhr.addEventListener("load", () => {
        finish();
        let body: unknown;
        try { body = JSON.parse(xhr.responseText); } catch { body = undefined; }
        if (xhr.status < 200 || xhr.status >= 300) {
          const error = body !== null && typeof body === "object" ? (body as ErrorBody).error : undefined;
          reject(new ApiError(error?.code ?? `HTTP_${xhr.status}`, error?.message ?? xhr.statusText, error?.details));
          return;
        }
        try { resolve(decodeProjectFileUploadResult(body)); } catch (error) { reject(error); }
      });
      xhr.addEventListener("error", () => { finish(); reject(new ApiError("NETWORK_ERROR", "Project file upload failed")); });
      xhr.addEventListener("abort", () => { finish(); reject(new DOMException("Project file upload was cancelled", "AbortError")); });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted === true) abort(); else xhr.send(file);
    });
  }
  async renameProjectFile(draftId: string, projectId: string, name: string, expected_fingerprint: string, new_name: string, reference_mode: ProjectFileRenameReferenceMode = "ignore_unchecked"): Promise<ProjectFileRenameResult> {
    return await this.request(`${projectFilePath(draftId, projectId, name)}/rename`, decodeProjectFileRenameResult, {
      method: "POST",
      body: JSON.stringify({ expected_fingerprint, new_name, reference_mode }),
    });
  }
  async deleteProjectFile(draftId: string, projectId: string, name: string, expected_fingerprint: string, confirmation_name: string, reference_mode: ProjectFileDeleteReferenceMode = "ignore_unchecked"): Promise<ProjectFileDeleteResult> {
    return await this.request(projectFilePath(draftId, projectId, name), decodeProjectFileDeleteResult, {
      method: "DELETE",
      body: JSON.stringify({ expected_fingerprint, confirmation_name, reference_mode }),
    });
  }
  async createEntity(draftId: string, entityType: string, expected_fingerprint: string, document: GitPmDocument): Promise<EntityResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/${encodeURIComponent(entityType)}`, decodeEntityResult, { method: "POST", body: JSON.stringify({ expected_fingerprint, document }) });
  }
  async updateEntity(draftId: string, entityType: string, entity: EntityResult, expected_fingerprint: string, document: GitPmDocument): Promise<EntityResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entity.document.id)}`, decodeEntityResult, { method: "PUT", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entity.blob_id, document }) });
  }
  async moveTask(draftId: string, entity: EntityResult, expected_fingerprint: string, target_project: string, target_milestone?: string, target_parent?: string): Promise<EntityResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/tasks/${encodeURIComponent(entity.document.id)}/move`, decodeEntityResult, { method: "POST", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entity.blob_id, target_project, target_milestone, target_parent }) });
  }
  async archiveEntity(draftId: string, entityType: string, entity: EntityResult, expected_fingerprint: string, options: LifecycleMutationOptions = {}): Promise<EntityResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entity.document.id)}/archive`, decodeEntityResult, { method: "POST", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entity.blob_id, ...(options.includeTasks === undefined ? {} : { include_tasks: options.includeTasks }), ...(options.restoreMilestone === undefined ? {} : { restore_milestone: options.restoreMilestone }) }) });
  }
  async restoreEntity(draftId: string, entityType: string, entity: EntityResult, expected_fingerprint: string, options: LifecycleMutationOptions = {}): Promise<EntityResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entity.document.id)}/restore`, decodeEntityResult, { method: "POST", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entity.blob_id, ...(options.includeTasks === undefined ? {} : { include_tasks: options.includeTasks }), ...(options.restoreMilestone === undefined ? {} : { restore_milestone: options.restoreMilestone }) }) });
  }
  async deleteEntity(draftId: string, entityType: string, entity: EntityResult, expected_fingerprint: string, unlinkReferences = false, cascadeReferences = false): Promise<void> {
    await this.requestEmpty(`/api/drafts/${encodeURIComponent(draftId)}/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entity.document.id)}`, { method: "DELETE", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entity.blob_id, ...(unlinkReferences ? { unlink_references: true } : {}), ...(cascadeReferences ? { cascade_references: true } : {}) }) });
  }
  async getConfiguration(draftId: string, kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks"): Promise<ConfigurationResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/config/${kind}`, decodeConfigurationResult);
  }
  async getRepositoryConfiguration(draftId: string): Promise<RepositoryResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/config/repository`, decodeRepositoryResult);
  }
  async getConfigurationImpact(draftId: string, kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks", document: ConfigurationDocument): Promise<ConfigurationImpact> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/config/${kind}/impact`, decodeConfigurationImpact, { method: "POST", body: JSON.stringify({ document }) });
  }
  async updateConfiguration(draftId: string, kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks", entity: ConfigurationResult, expected_fingerprint: string, document: ConfigurationDocument): Promise<ConfigurationResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/config/${kind}`, decodeConfigurationResult, { method: "PUT", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entity.blob_id, document }) });
  }
  async updateRepositoryConfiguration(draftId: string, entity: RepositoryResult, expected_fingerprint: string, document: RepositoryDocument): Promise<RepositoryResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/config/repository`, decodeRepositoryResult, { method: "PUT", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entity.blob_id, document }) });
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
  async downloadWorktreeFile(draftId: string, path: string): Promise<ExportDownload> {
    return await this.requestDownload(`/api/drafts/${encodeURIComponent(draftId)}/worktree/file/download?path=${encodeURIComponent(path)}`, "WORKTREE_DOWNLOAD_FILENAME_INVALID");
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
  async restoreCommitFiles(draftId: string, commit: string, expected_fingerprint: string, paths: readonly string[]): Promise<RestoreCommitFilesResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/history/${encodeURIComponent(commit)}/restore-files`, decodeRestoreCommitFilesResult, { method: "POST", body: JSON.stringify({ expected_fingerprint, paths }) });
  }
  async revertDirect(draftId: string, commit: string, expected_fingerprint: string, message: string): Promise<DirectRevertResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/history/${encodeURIComponent(commit)}/revert-direct`, decodeDirectRevertResult, { method: "POST", body: JSON.stringify({ expected_fingerprint, message }) });
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
  async markNotificationsRead(draftId: string, keys: readonly string[]): Promise<NotificationsResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/notifications/read`, decodeNotifications, { method: "POST", body: JSON.stringify({ keys }) });
  }
  async listTimeEntries(draftId: string, projectId: string, taskId: string): Promise<readonly TimeEntryResult[]> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/time-entries`, decodeTimeEntryResults);
  }
  async listProjectTimeEntries(draftId: string, projectId: string, filters: ProjectTimeEntryFilters = {}): Promise<TimeEntryProjectList> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== undefined) query.set(key, String(value));
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/time-entries${suffix}`, decodeTimeEntryProjectList);
  }
  async createTimeEntry(draftId: string, projectId: string, taskId: string, expected_fingerprint: string, input: { readonly person: string; readonly performed_on: string; readonly hours: number; readonly category: string; readonly note_markdown?: string }): Promise<TimeEntryResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/time-entries`, decodeTimeEntryResult, { method: "POST", body: JSON.stringify({ expected_fingerprint, ...input }) });
  }
  async voidTimeEntry(draftId: string, projectId: string, taskId: string, entry: TimeEntryResult, expected_fingerprint: string): Promise<TimeEntryResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/time-entries/${encodeURIComponent(entry.document.id)}/void`, decodeTimeEntryResult, { method: "POST", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entry.blob_id }) });
  }
  async replaceTimeEntry(draftId: string, projectId: string, taskId: string, entry: TimeEntryResult, expected_fingerprint: string, input: { readonly person: string; readonly performed_on: string; readonly hours: number; readonly category: string; readonly note_markdown?: string }): Promise<TimeEntryReplacementResult> {
    return await this.request(`/api/drafts/${encodeURIComponent(draftId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/time-entries/${encodeURIComponent(entry.document.id)}/replace`, decodeTimeEntryReplacementResult, { method: "POST", body: JSON.stringify({ expected_fingerprint, expected_blob_id: entry.blob_id, ...input }) });
  }
}
