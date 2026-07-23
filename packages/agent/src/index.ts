import type { ChangesService } from "@gitpm/changes";
import { provisionGitPmWorktreeGuidance } from "@gitpm/drafts";
import type { DraftManager, DraftMetadata, WriterMode } from "@gitpm/drafts";
import type { GitClient } from "@gitpm/git-client";
import type { GitLabMergeRequestProtocol, MergeRequestPayload, MergeRequestState } from "@gitpm/gitlab";
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
      prepareWorkspace: async (draftId) => { await this.externalDraft(draftId); },
      createError: (code, message, details) => new AgentWorkflowError(code, message, details),
      emptyCommitMessage: "Draft has no business changes",
      dirtyPushMessage: "Push requires a clean committed draft",
    });
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
  ) {
    return await this.repository.deleteEntity(draftId, entityType, id, unlinkReferences, scope);
  }

  async archiveEntity(draftId: string, entityType: string, id: string, scope: AgentScope = {}) {
    return await this.repository.archiveEntity(draftId, entityType, id, scope);
  }

  async moveTask(
    draftId: string,
    id: string,
    targetProject: string,
    targetMilestone: string | undefined,
    scope: AgentScope = {},
  ) {
    return await this.repository.moveTask(draftId, id, targetProject, targetMilestone, scope);
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
    const draft = await this.externalDraft(draftId);
    if (!title.trim() || title.length > 255) {
      throw new AgentWorkflowError("MR_TITLE_INVALID", "Merge Request title is invalid");
    }
    if (!this.options.accessToken || !this.options.mergeRequests) {
      throw new AgentWorkflowError(
        "AGENT_MR_CONFIGURATION_REQUIRED",
        "Merge Request configuration is unavailable",
      );
    }
    const payload: MergeRequestPayload = {
      source_branch: draft.branch,
      target_branch: this.options.defaultBranch,
      title,
      ...(description?.trim() ? { description } : {}),
    };
    const result = await this.options.mergeRequests.createMergeRequest(this.options.accessToken, payload);
    await this.drafts.markPublished(draftId, owner, result.iid);
    return result;
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
