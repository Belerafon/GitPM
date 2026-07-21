import type { DraftManager } from "@gitpm/drafts";
import { DraftRuntimeError, GITPM_GUIDANCE_PATHS } from "@gitpm/drafts";
import type { GitClient } from "@gitpm/git-client";
import type { AuthService, GitLabMergeRequestProtocol, MergeRequestPayload } from "@gitpm/gitlab";
import { AuthError } from "@gitpm/gitlab";
import { PublishingError } from "@gitpm/publishing";
import { validateRepository } from "@gitpm/validation";

export interface RepositoryPublishingOptions {
  readonly ownerId: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly defaultBranch: string;
  readonly auth?: AuthService;
  readonly mergeRequests?: GitLabMergeRequestProtocol;
}

export class RepositoryPublishingService {
  constructor(
    private readonly drafts: DraftManager,
    private readonly git: GitClient,
    private readonly options: RepositoryPublishingOptions,
  ) {}

  async commitAll(draftId: string, message: string) {
    const draft = await this.ownedDraft(draftId);
    const validation = await validateRepository(draft.worktree_path);
    if (!validation.valid) throw new PublishingError("VALIDATION_FAILED", "Commit is blocked by repository validation", validation.errors);
    if (!(await this.git.statusPorcelain(draft.worktree_path, GITPM_GUIDANCE_PATHS)).trim()) throw new PublishingError("NOTHING_TO_COMMIT", "Draft has no changes");
    const commit = await this.git.commitAll(draft.worktree_path, message, this.options.authorName, this.options.authorEmail, GITPM_GUIDANCE_PATHS);
    const metadata = await this.drafts.refreshFingerprint(draftId);
    return { commit, branch: metadata.branch, draft_fingerprint: metadata.fingerprint };
  }

  async push(sessionId: string, draftId: string) {
    const authorized = await this.requireGitLab().authorize(sessionId, "push");
    const draft = await this.ownedDraft(draftId);
    if ((await this.git.statusPorcelain(draft.worktree_path, GITPM_GUIDANCE_PATHS)).trim()) {
      throw new PublishingError("UNCOMMITTED_CHANGES", "Push requires a clean committed draft");
    }
    await this.git.pushBranch(draft.worktree_path, draft.branch, authorized.accessToken);
    return { branch: draft.branch, commit: await this.git.headCommit(draft.worktree_path) };
  }

  async createMergeRequest(sessionId: string, draftId: string, title: string, description?: string) {
    const authorized = await this.requireGitLab().authorize(sessionId, "mr");
    const draft = await this.ownedDraft(draftId);
    if (!title.trim() || title.length > 255) throw new PublishingError("MR_TITLE_INVALID", "Merge Request title is invalid");
    if (this.options.mergeRequests === undefined) throw new AuthError("GITLAB_NOT_CONFIGURED", "GitLab is not configured");
    const payload: MergeRequestPayload = {
      source_branch: draft.branch,
      target_branch: this.options.defaultBranch,
      title,
      ...(description ? { description } : {}),
    };
    const mergeRequest = await this.options.mergeRequests.createMergeRequest(authorized.accessToken, payload);
    await this.drafts.markPublished(draftId, this.options.ownerId, mergeRequest.iid);
    return mergeRequest;
  }

  async pollMergeRequest(sessionId: string, draftId: string) {
    const authorized = await this.requireGitLab().authorize(sessionId, "read");
    const draft = await this.ownedDraft(draftId, false);
    if (!draft.merge_request_iid) throw new PublishingError("MR_NOT_CREATED", "Draft has no Merge Request");
    if (this.options.mergeRequests === undefined) throw new AuthError("GITLAB_NOT_CONFIGURED", "GitLab is not configured");
    return await this.options.mergeRequests.getMergeRequest(authorized.accessToken, draft.merge_request_iid);
  }

  private requireGitLab(): AuthService {
    if (this.options.auth === undefined) throw new AuthError("GITLAB_NOT_CONFIGURED", "GitLab login is not configured for this repository");
    return this.options.auth;
  }

  private async ownedDraft(draftId: string, requireOpen = true) {
    const draft = await this.drafts.getDraft(draftId);
    if (draft.owner_gitlab_user_id !== this.options.ownerId) throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Draft owner mismatch");
    if (requireOpen && draft.state !== "open") throw new DraftRuntimeError("DRAFT_NOT_OPEN", "Draft is not open");
    return draft;
  }
}
