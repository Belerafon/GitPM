import type { ChangesService } from "@gitpm/changes";
import { provisionGitPmWorktreeGuidance } from "@gitpm/drafts";
import type { DraftManager, DraftMetadata, WriterMode } from "@gitpm/drafts";
import {
  CommentStore,
  TimeEntryStore,
  type CommentActor,
  type TimeEntryActor,
  type TimeEntryProjectFilters,
} from "@gitpm/domain";
import type { GitClient } from "@gitpm/git-client";
import type { GitLabMergeRequestProtocol, MergeRequestState } from "@gitpm/gitlab";
import { HistoryService } from "@gitpm/history";
import {
  RepositoryWorkflow,
  RepositoryWorkflowError,
  assertAgentScope as assertRepositoryScope,
  type AgentScope,
  type AgentScopeReport,
} from "./repository-workflow.js";

export {
  RepositoryWorkflow,
  RepositoryWorkflowError,
  type AgentScope,
  type AgentScopeReport,
  type RepositoryWorkflowOptions,
} from "./repository-workflow.js";

export class AgentWorkflowError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "AgentWorkflowError";
  }
}

export interface AgentWorkflowOptions {
  readonly accessToken?: string;
  readonly authorEmail: string;
  readonly authorName: string;
  readonly defaultBranch: string;
  readonly mergeRequests?: GitLabMergeRequestProtocol;
}

export function assertAgentScope(
  report: {
    readonly affected_projects: readonly string[];
    readonly files: readonly { readonly path: string; readonly kind: "Added" | "Modified" | "Deleted" }[];
  },
  scope: AgentScope = {},
): AgentScopeReport {
  try {
    return assertRepositoryScope(report, scope);
  } catch (error) {
    if (error instanceof RepositoryWorkflowError) {
      throw new AgentWorkflowError(error.code, error.message, error.details);
    }
    throw error;
  }
}

export class AgentWorkflow {
  private readonly repository: RepositoryWorkflow;
  private readonly comments: CommentStore;
  private readonly timeEntries: TimeEntryStore;
  private readonly history: HistoryService;

  constructor(
    private readonly drafts: DraftManager,
    git: GitClient,
    changes: ChangesService,
    private readonly options: AgentWorkflowOptions,
  ) {
    this.repository = new RepositoryWorkflow(drafts, git, changes, {
      mutationMode: "external",
      authorName: options.authorName,
      authorEmail: options.authorEmail,
      defaultBranch: options.defaultBranch,
      ...(options.mergeRequests === undefined ? {} : { mergeRequests: options.mergeRequests }),
      prepareWorkspace: async (draftId) => { await this.externalDraft(draftId); },
      createError: (code, message, details) => new AgentWorkflowError(code, message, details),
    });
    this.comments = new CommentStore(drafts, () => new Date(), "external");
    this.timeEntries = new TimeEntryStore(drafts, () => new Date(), "external");
    this.history = new HistoryService(drafts, git);
  }

  async createDraft(draftId: string, owner: string): Promise<DraftMetadata> {
    await this.drafts.createDraft(draftId, owner);
    return await this.drafts.setWriterMode(draftId, owner, "external");
  }

  async openDraft(draftId: string, owner: string): Promise<DraftMetadata> {
    return await this.drafts.setWriterMode(draftId, owner, "external");
  }

  async setWriterMode(draftId: string, owner: string, mode: WriterMode): Promise<DraftMetadata> {
    return await this.drafts.setWriterMode(draftId, owner, mode);
  }

  async listDrafts(owner?: string): Promise<readonly DraftMetadata[]> {
    const drafts = await this.drafts.listDrafts();
    return owner === undefined ? drafts : drafts.filter((draft) => draft.owner_gitlab_user_id === owner);
  }

  async acknowledgeExternalChanges(draftId: string, owner: string): Promise<DraftMetadata> {
    return await this.drafts.acknowledgeExternalChanges(draftId, owner);
  }

  async closeDraft(draftId: string, owner: string): Promise<DraftMetadata> {
    return await this.drafts.closeDraft(draftId, owner);
  }

  async reopenDraft(draftId: string, owner: string): Promise<DraftMetadata> {
    return await this.drafts.reopenDraft(draftId, owner);
  }

  async cleanupDraft(draftId: string, owner: string, confirmation: string): Promise<void> {
    const draft = await this.drafts.getDraft(draftId);
    if (draft.owner_gitlab_user_id !== owner) throw new AgentWorkflowError("DRAFT_FORBIDDEN", "Draft owner mismatch");
    await this.drafts.cleanupDraft(draftId, confirmation);
  }

  async status(draftId: string): Promise<DraftMetadata> {
    const draft = await this.drafts.getDraft(draftId);
    if (await provisionGitPmWorktreeGuidance(draft.worktree_path, draft.draft_id)) {
      return await this.drafts.refreshFingerprint(draftId);
    }
    return draft;
  }

  async assertScope(draftId: string, scope: AgentScope = {}) {
    return await this.repository.assertScope(draftId, scope);
  }

  async semanticDiff(draftId: string, scope: AgentScope = {}) {
    return await this.repository.semanticDiff(draftId, scope);
  }

  async listChanges(draftId: string, scope: AgentScope = {}) {
    return await this.repository.listChanges(draftId, scope);
  }

  async restoreFile(draftId: string, relativePath: string, scope: AgentScope = {}) {
    return await this.repository.restoreFile(draftId, relativePath, scope);
  }

  async restoreHunk(draftId: string, relativePath: string, diffToken: string, hunkIndex: number, scope: AgentScope = {}) {
    return await this.repository.restoreHunk(draftId, relativePath, diffToken, hunkIndex, scope);
  }

  async discardAll(draftId: string, scope: AgentScope = {}) {
    return await this.repository.discardAll(draftId, scope);
  }

  async createEntity(
    draftId: string,
    document: Readonly<Record<string, unknown>>,
    scope: AgentScope = {},
    requestedType?: string,
  ) {
    return await this.repository.createEntity(draftId, document, scope, requestedType);
  }

  async createEntities(
    draftId: string,
    documents: readonly Readonly<Record<string, unknown>>[],
    requestedType: string | undefined,
    scope: AgentScope = {},
    dryRun = false,
  ) {
    return await this.repository.createEntities(draftId, documents, requestedType, scope, dryRun);
  }

  async updateEntity(
    draftId: string,
    patch: Readonly<Record<string, unknown>>,
    requestedType: string,
    requestedId: string,
    scope: AgentScope = {},
  ) {
    return await this.repository.updateEntity(draftId, patch, requestedType, requestedId, scope);
  }

  async listEntities(draftId: string, entityType: string, project?: string) {
    return await this.repository.listEntities(draftId, entityType, project);
  }

  async getEntity(draftId: string, entityType: string, id: string) {
    const found = await this.repository.getEntity(draftId, entityType, id);
    return {
      document: found.document,
      path: found.path,
      draft_fingerprint: found.draft_fingerprint,
    };
  }

  async planDelete(draftId: string, entityType: string, id: string) {
    return await this.repository.planDelete(draftId, entityType, id);
  }

  async deleteEntity(
    draftId: string,
    entityType: string,
    id: string,
    unlinkReferences = false,
    scope: AgentScope = {},
    cascadeReferences = false,
  ) {
    return await this.repository.deleteEntity(draftId, entityType, id, unlinkReferences, scope, cascadeReferences);
  }

  async archiveEntity(draftId: string, entityType: string, id: string, scope: AgentScope = {}) {
    return await this.repository.archiveEntity(draftId, entityType, id, scope);
  }

  async moveTask(
    draftId: string,
    id: string,
    targetProject: string,
    targetMilestone: string | undefined,
    targetParent: string | undefined,
    scope: AgentScope = {},
  ) {
    return await this.repository.moveTask(draftId, id, targetProject, targetMilestone, targetParent, scope);
  }

  async getConfiguration(
    draftId: string,
    kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks",
  ) {
    return await this.repository.getConfiguration(draftId, kind);
  }

  async getRepositoryConfiguration(draftId: string) {
    return await this.repository.getRepositoryConfiguration(draftId);
  }

  async updateConfiguration(
    draftId: string,
    kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks",
    document: Record<string, unknown>,
    scope: AgentScope = {},
  ) {
    return await this.repository.updateConfiguration(draftId, kind, document, scope);
  }

  async updateRepositoryConfiguration(
    draftId: string,
    document: Record<string, unknown>,
    scope: AgentScope = {},
  ) {
    return await this.repository.updateRepositoryConfiguration(draftId, document, scope);
  }

  async listComments(draftId: string, projectId: string, taskId: string) {
    const actor = await this.commentActor(draftId);
    return await this.comments.list(draftId, projectId, taskId, actor);
  }

  async createComment(draftId: string, projectId: string, taskId: string, body: string) {
    const actor = await this.commentActor(draftId);
    const workspace = await this.drafts.refreshWorkspaceFingerprint(draftId);
    return await this.comments.create(draftId, projectId, taskId, workspace.fingerprint, body, actor);
  }

  async updateComment(draftId: string, projectId: string, taskId: string, commentId: string, body: string) {
    const actor = await this.commentActor(draftId);
    const workspace = await this.drafts.refreshWorkspaceFingerprint(draftId);
    const relative = `projects/${projectId}/comments/${taskId}/${commentId}.yaml`;
    const blobId = await this.drafts.fileBlobId(draftId, relative);
    return await this.comments.update(draftId, projectId, taskId, commentId, workspace.fingerprint, blobId, body, actor);
  }

  async deleteComment(draftId: string, projectId: string, taskId: string, commentId: string) {
    const actor = await this.commentActor(draftId);
    const workspace = await this.drafts.refreshWorkspaceFingerprint(draftId);
    const relative = `projects/${projectId}/comments/${taskId}/${commentId}.yaml`;
    const blobId = await this.drafts.fileBlobId(draftId, relative);
    return await this.comments.delete(draftId, projectId, taskId, commentId, workspace.fingerprint, blobId, actor);
  }

  async notifications(draftId: string, personId?: string) {
    const actor = await this.commentActor(draftId, personId);
    return await this.comments.notifications(draftId, actor);
  }

  async listProjectTimeEntries(draftId: string, projectId: string, filters: TimeEntryProjectFilters = {}) {
    await this.externalDraft(draftId);
    return await this.timeEntries.listProject(draftId, projectId, filters);
  }

  async createTimeEntry(
    draftId: string,
    projectId: string,
    taskId: string,
    input: { readonly person: string; readonly performed_on: string; readonly hours: number; readonly category: string; readonly note_markdown?: string },
  ) {
    const actor = await this.timeEntryActor(draftId);
    const workspace = await this.drafts.refreshWorkspaceFingerprint(draftId);
    return await this.timeEntries.create(draftId, projectId, taskId, workspace.fingerprint, input, actor);
  }

  async voidTimeEntry(draftId: string, projectId: string, taskId: string, entryId: string) {
    const actor = await this.timeEntryActor(draftId);
    const workspace = await this.drafts.refreshWorkspaceFingerprint(draftId);
    const relative = `projects/${projectId}/time-entries/${taskId}/${entryId}.yaml`;
    const blobId = await this.drafts.fileBlobId(draftId, relative);
    return await this.timeEntries.void(draftId, projectId, taskId, entryId, workspace.fingerprint, blobId, actor);
  }

  async replaceTimeEntry(
    draftId: string,
    projectId: string,
    taskId: string,
    entryId: string,
    input: { readonly person: string; readonly performed_on: string; readonly hours: number; readonly category: string; readonly note_markdown?: string },
  ) {
    const actor = await this.timeEntryActor(draftId);
    const workspace = await this.drafts.refreshWorkspaceFingerprint(draftId);
    const relative = `projects/${projectId}/time-entries/${taskId}/${entryId}.yaml`;
    const blobId = await this.drafts.fileBlobId(draftId, relative);
    return await this.timeEntries.replace(draftId, projectId, taskId, entryId, workspace.fingerprint, blobId, input, actor);
  }

  async commitAll(draftId: string, message: string, scope: AgentScope = {}) {
    return await this.repository.commitAll(draftId, message, scope);
  }

  async push(draftId: string) {
    return await this.repository.push(draftId, this.options.accessToken, {
      code: "AGENT_TOKEN_REQUIRED",
      message: "Push requires an in-memory access token",
    });
  }

  async createMergeRequest(
    draftId: string,
    owner: string,
    title: string,
    description?: string,
  ): Promise<MergeRequestState> {
    return await this.repository.createMergeRequest(
      draftId,
      owner,
      this.options.accessToken,
      { title, ...(description === undefined ? {} : { description }) },
      {
        code: "AGENT_MR_CONFIGURATION_REQUIRED",
        message: "Merge Request configuration is unavailable",
      },
    );
  }

  async mergeRequestStatus(draftId: string, owner: string): Promise<MergeRequestState> {
    return await this.repository.pollMergeRequest(
      draftId,
      owner,
      this.options.accessToken,
      { code: "AGENT_MR_CONFIGURATION_REQUIRED", message: "Merge Request configuration is unavailable" },
    );
  }

  async historyList(draftId: string, limit = 50) {
    return await this.history.list(draftId, limit);
  }

  async historyDetail(draftId: string, commit: string) {
    return await this.history.detail(draftId, commit);
  }

  async historyFileDiff(draftId: string, commit: string, relativePath: string) {
    return await this.history.fileDiff(draftId, commit, relativePath);
  }

  async fileHistory(draftId: string, relativePath: string, limit = 50) {
    return await this.history.fileHistory(draftId, relativePath, limit);
  }

  async createRevertDraft(sourceDraftId: string, commit: string, newDraftId: string, owner: string) {
    const result = await this.history.createRevertDraft(sourceDraftId, commit, newDraftId, owner);
    const draft = result.draft.writer_mode === "external"
      ? result.draft
      : await this.drafts.setWriterMode(newDraftId, owner, "external");
    return { ...result, draft };
  }

  private async commentActor(draftId: string, personId?: string): Promise<CommentActor> {
    const draft = await this.externalDraft(draftId);
    return {
      userId: draft.owner_gitlab_user_id,
      role: "Maintainer",
      identity: {
        provider: "git",
        subject: this.options.authorEmail.trim().toLocaleLowerCase(),
        display_name: this.options.authorName,
      },
      email: this.options.authorEmail,
      ...(personId === undefined ? {} : { personId }),
    };
  }

  private async timeEntryActor(draftId: string): Promise<TimeEntryActor> {
    const actor = await this.commentActor(draftId);
    return { userId: actor.userId, identity: actor.identity };
  }

  private async externalDraft(draftId: string): Promise<DraftMetadata> {
    let draft = await this.drafts.getDraft(draftId);
    if (draft.state !== "open") throw new AgentWorkflowError("DRAFT_NOT_OPEN", "Draft is not open");
    if (draft.writer_mode !== "external") {
      throw new AgentWorkflowError(
        "AGENT_EXTERNAL_MODE_REQUIRED",
        "Agent workflow requires external writer mode",
      );
    }
    if (await provisionGitPmWorktreeGuidance(draft.worktree_path, draft.draft_id)) {
      draft = await this.drafts.refreshFingerprint(draftId);
    }
    return draft;
  }
}
