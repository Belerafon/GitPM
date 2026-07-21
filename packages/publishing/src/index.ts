import type { DraftManager } from "@gitpm/drafts";
import { DraftRuntimeError, GITPM_GUIDANCE_PATHS } from "@gitpm/drafts";
import type { GitClient } from "@gitpm/git-client";
import type { AuthService, GitLabMergeRequestProtocol, MergeRequestPayload } from "@gitpm/gitlab";
import { validateRepository } from "@gitpm/validation";

export class PublishingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PublishingError";
  }
}

export class PublishingService {
  constructor(
    private readonly auth: AuthService,
    private readonly drafts: DraftManager,
    private readonly git: GitClient,
    private readonly gitlab: GitLabMergeRequestProtocol,
    private readonly defaultBranch: string,
  ) {}

  async commitAll(sessionId: string, draftId: string, message: string) {
    const authorized = await this.auth.authorize(sessionId, "commit");
    const draft = await this.ownedDraft(draftId, authorized.session.user.id);
    const validation = await validateRepository(draft.worktree_path);
    if (!validation.valid) throw new PublishingError("VALIDATION_FAILED", "Commit is blocked by repository validation", validation.errors);
    const status = await this.git.statusPorcelain(draft.worktree_path, GITPM_GUIDANCE_PATHS);
    if (!status.trim()) throw new PublishingError("NOTHING_TO_COMMIT", "Draft has no changes");
    const commit = await this.git.commitAll(
      draft.worktree_path,
      message,
      authorized.session.user.username,
      `${authorized.session.user.id}@users.noreply.gitlab.example.test`,
      GITPM_GUIDANCE_PATHS,
    );
    const metadata = await this.drafts.refreshFingerprint(draftId);
    return { commit, branch: metadata.branch, draft_fingerprint: metadata.fingerprint };
  }

  async push(sessionId: string, draftId: string) {
    const authorized = await this.auth.authorize(sessionId, "push");
    const draft = await this.ownedDraft(draftId, authorized.session.user.id);
    if ((await this.git.statusPorcelain(draft.worktree_path, GITPM_GUIDANCE_PATHS)).trim()) {
      throw new PublishingError("UNCOMMITTED_CHANGES", "Push requires a clean committed draft");
    }
    await this.git.pushBranch(draft.worktree_path, draft.branch, authorized.accessToken);
    return { branch: draft.branch, commit: await this.git.headCommit(draft.worktree_path) };
  }

  async createMergeRequest(sessionId: string, draftId: string, title: string, description?: string) {
    const authorized = await this.auth.authorize(sessionId, "mr");
    const draft = await this.ownedDraft(draftId, authorized.session.user.id);
    if (!title.trim() || title.length > 255) throw new PublishingError("MR_TITLE_INVALID", "Merge Request title is invalid");
    const payload: MergeRequestPayload = {
      source_branch: draft.branch,
      target_branch: this.defaultBranch,
      title,
      ...(description ? { description } : {}),
    };
    const mergeRequest = await this.gitlab.createMergeRequest(authorized.accessToken, payload);
    await this.drafts.markPublished(draftId, authorized.session.user.id, mergeRequest.iid);
    return mergeRequest;
  }

  async pollMergeRequest(sessionId: string, draftId: string) {
    const authorized = await this.auth.authorize(sessionId, "read");
    const draft = await this.drafts.getDraft(draftId);
    if (draft.owner_gitlab_user_id !== authorized.session.user.id) throw new PublishingError("DRAFT_FORBIDDEN", "Draft owner mismatch");
    if (!draft.merge_request_iid) throw new PublishingError("MR_NOT_CREATED", "Draft has no Merge Request");
    return await this.gitlab.getMergeRequest(authorized.accessToken, draft.merge_request_iid);
  }

  private async ownedDraft(draftId: string, userId: string) {
    const draft = await this.drafts.getDraft(draftId);
    if (draft.owner_gitlab_user_id !== userId) throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Draft owner mismatch");
    if (draft.state !== "open") throw new DraftRuntimeError("DRAFT_NOT_OPEN", "Draft is not open");
    return draft;
  }
}
