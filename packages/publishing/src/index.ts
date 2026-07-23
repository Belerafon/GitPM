import type { DraftManager } from "@gitpm/drafts";
import { DraftRuntimeError, GITPM_GUIDANCE_PATHS } from "@gitpm/drafts";
import type { GitClient } from "@gitpm/git-client";
import type { GitLabMergeRequestProtocol, MergeRequestPayload } from "@gitpm/gitlab";
import { validateRepository } from "@gitpm/validation";

export class PublicationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PublicationError";
  }
}

export interface PublicationContext {
  readonly ownerId: string;
}

export interface CommitPublicationContext extends PublicationContext {
  readonly authorName: string;
  readonly authorEmail: string;
}

export interface RemotePublicationContext extends PublicationContext {
  readonly accessToken: () => string;
}

export interface PublicationWorkspace {
  readonly draftId: string;
}

export interface MergeRequestData {
  readonly title: string;
  readonly description?: string;
}

export interface PublicationServiceOptions {
  readonly defaultBranch: string;
  readonly mergeRequests?: GitLabMergeRequestProtocol;
}

export function validateMergeRequestData(data: MergeRequestData): void {
  if (!data.title.trim() || data.title.length > 255) {
    throw new PublicationError("MR_TITLE_INVALID", "Merge Request title is invalid");
  }
}

/**
 * The single application service for turning a validated workspace into Git
 * publication state. Callers remain responsible for obtaining credentials and
 * enforcing channel-specific policy such as an agent's Project scope.
 */
export class PublicationService {
  constructor(
    private readonly drafts: DraftManager,
    private readonly git: GitClient,
    private readonly options: PublicationServiceOptions,
  ) {}

  async commit(context: CommitPublicationContext, workspace: PublicationWorkspace, message: string) {
    const draft = await this.ownedWorkspace(context, workspace);
    if (this.drafts.repositoryMode === "direct") {
      await this.git.assertCheckoutOnDefaultBranch(draft.worktree_path);
    }
    const validation = await validateRepository(draft.worktree_path);
    if (!validation.valid) {
      throw new PublicationError("VALIDATION_FAILED", "Commit is blocked by repository validation", validation.errors);
    }
    if (!(await this.git.statusPorcelain(draft.worktree_path, GITPM_GUIDANCE_PATHS)).trim()) {
      throw new PublicationError("NOTHING_TO_COMMIT", "Workspace has no business changes");
    }
    const commit = await this.git.commitAll(
      draft.worktree_path,
      message,
      context.authorName,
      context.authorEmail,
      GITPM_GUIDANCE_PATHS,
    );
    const metadata = await this.drafts.refreshFingerprint(workspace.draftId);
    return { commit, branch: metadata.branch, draft_fingerprint: metadata.fingerprint };
  }

  async push(context: RemotePublicationContext, workspace: PublicationWorkspace) {
    const draft = await this.ownedWorkspace(context, workspace);
    if ((await this.git.statusPorcelain(draft.worktree_path, GITPM_GUIDANCE_PATHS)).trim()) {
      throw new PublicationError("UNCOMMITTED_CHANGES", "Push requires a clean committed workspace");
    }
    const result = await this.drafts.push(workspace.draftId, context.accessToken());
    return { branch: result.branch, commit: result.commit };
  }

  async createMergeRequest(
    context: RemotePublicationContext,
    workspace: PublicationWorkspace,
    data: MergeRequestData,
  ) {
    const draft = await this.ownedWorkspace(context, workspace);
    validateMergeRequestData(data);
    if (this.options.mergeRequests === undefined) {
      throw new PublicationError("MR_CONFIGURATION_REQUIRED", "Merge Request configuration is unavailable");
    }
    const payload: MergeRequestPayload = {
      source_branch: draft.branch,
      target_branch: this.options.defaultBranch,
      title: data.title,
      ...(data.description?.trim() ? { description: data.description } : {}),
    };
    const mergeRequest = await this.options.mergeRequests.createMergeRequest(context.accessToken(), payload);
    await this.drafts.markPublished(workspace.draftId, context.ownerId, mergeRequest.iid);
    return mergeRequest;
  }

  async pollMergeRequest(context: RemotePublicationContext, workspace: PublicationWorkspace) {
    const draft = await this.ownedWorkspace(context, workspace, false);
    if (!draft.merge_request_iid) throw new PublicationError("MR_NOT_CREATED", "Workspace has no Merge Request");
    if (this.options.mergeRequests === undefined) {
      throw new PublicationError("MR_CONFIGURATION_REQUIRED", "Merge Request configuration is unavailable");
    }
    return await this.options.mergeRequests.getMergeRequest(context.accessToken(), draft.merge_request_iid);
  }

  private async ownedWorkspace(
    context: PublicationContext,
    workspace: PublicationWorkspace,
    requireOpen = true,
  ) {
    const draft = await this.drafts.getDraft(workspace.draftId);
    if (draft.owner_gitlab_user_id !== context.ownerId) {
      throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Draft owner mismatch");
    }
    if (requireOpen && draft.state !== "open") {
      throw new DraftRuntimeError("DRAFT_NOT_OPEN", "Draft is not open");
    }
    return draft;
  }
}
