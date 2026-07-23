import {
  RepositoryWorkflow,
  type AgentScope,
  type AgentScopeReport,
} from "@gitpm/agent";
import { ChangesService, type SemanticDiff } from "@gitpm/changes";
import { GitClient, GitCommandError } from "@gitpm/git-client";
import { DirectRepositoryBackend, directPushStrategy, DraftManager, GITPM_GUIDANCE_PATHS } from "@gitpm/drafts";
import { CommentStore, type CommentActor, type CommentResult, type DeletePlan, type EntityCreateBatchResult, type EntityResult } from "@gitpm/domain";
import type { GitPmDocument } from "@gitpm/repository-format";

const DIRECT_WORKSPACE_ID = "DRF-LOCAL";

export interface DirectStatus {
  readonly mode: "direct";
  readonly path: string;
  readonly branch: string;
  readonly head: string;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly remote?: string;
}

export interface DirectCommitResult {
  readonly commit: string;
  readonly branch: string;
}

export interface DirectPushResult {
  readonly branch: string;
  readonly commit: string;
}

export interface DirectCliRuntimeOptions {
  readonly dataDirectory: string;
  readonly checkoutPath: string;
  readonly defaultBranch: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly allowLocalRepository?: boolean;
  readonly allowLocalTestRemote?: boolean;
  readonly askPassPath?: string;
  readonly pushAccessToken?: string;
}

export class DirectCliRuntime {
  private readonly git: GitClient;
  private readonly backend: DirectRepositoryBackend;
  private readonly drafts: DraftManager;
  private readonly comments: CommentStore;
  private readonly repository: RepositoryWorkflow;
  private readonly authorName: string;
  private readonly authorEmail: string;
  private readonly pushAccessToken?: string;
  private prepared = false;
  private workspaceDraftId?: string;

  constructor(options: DirectCliRuntimeOptions) {
    this.git = new GitClient({
      dataDirectory: options.dataDirectory,
      remoteUrl: options.checkoutPath,
      defaultBranch: options.defaultBranch,
      ...(options.allowLocalRepository ? { allowLocalRepository: true } : {}),
      ...(options.allowLocalTestRemote ? { allowLocalTestRemote: true } : {}),
      ...(options.askPassPath === undefined ? {} : { askPassPath: options.askPassPath }),
    });
    if (!options.allowLocalRepository && !options.allowLocalTestRemote) throw new Error("Direct mode requires an existing local Git checkout");
    this.backend = new DirectRepositoryBackend(this.git, options.checkoutPath);
    this.drafts = new DraftManager(this.git, options.dataDirectory, {
      backend: this.backend,
      push: directPushStrategy(this.git),
    });
    const changes = new ChangesService(this.drafts, this.git);
    this.comments = new CommentStore(this.drafts, () => new Date(), "repository");
    this.authorName = options.authorName;
    this.authorEmail = options.authorEmail;
    this.pushAccessToken = options.pushAccessToken;
    this.repository = new RepositoryWorkflow(this.drafts, this.git, changes, {
      mutationMode: "repository",
      authorName: options.authorName,
      authorEmail: options.authorEmail,
      prepareWorkspace: async () => { await this.prepare(); },
      emptyCommitMessage: "Working copy has no changes",
      dirtyPushMessage: "Push requires a clean committed working copy",
    });
  }

  private directActor(): CommentActor {
    return { userId: "local-user", role: "Maintainer", identity: { provider: "git", subject: this.authorEmail, display_name: this.authorName } };
  }

  get checkoutPath(): string {
    return this.backend.checkoutPath;
  }

  async prepare(): Promise<void> {
    await this.backend.prepare();
    if (this.prepared) return;
    const workspace = await this.drafts.ensureDirectWorkspace(DIRECT_WORKSPACE_ID, "local-user");
    this.workspaceDraftId = workspace.draft_id;
    this.prepared = true;
  }

  private async draftId(): Promise<string> {
    await this.prepare();
    if (this.workspaceDraftId === undefined) throw new Error("Direct workspace is unavailable");
    return this.workspaceDraftId;
  }

  async assertScope(scope: AgentScope = {}): Promise<AgentScopeReport> {
    return await this.repository.assertScope(DIRECT_WORKSPACE_ID, scope);
  }

  async createEntity(document: Readonly<Record<string, unknown>>, scope: AgentScope = {}, requestedType?: string): Promise<EntityResult> {
    return await this.repository.createEntity(DIRECT_WORKSPACE_ID, document, scope, requestedType);
  }

  async createEntities(
    documents: readonly Readonly<Record<string, unknown>>[],
    requestedType: string | undefined,
    scope: AgentScope = {},
    dryRun = false,
  ): Promise<EntityCreateBatchResult> {
    return await this.repository.createEntities(
      DIRECT_WORKSPACE_ID,
      documents,
      requestedType,
      scope,
      dryRun,
    );
  }

  async updateEntity(
    patch: Readonly<Record<string, unknown>>,
    requestedType: string,
    requestedId: string,
    scope: AgentScope = {},
  ): Promise<EntityResult> {
    return await this.repository.updateEntity(
      DIRECT_WORKSPACE_ID,
      patch,
      requestedType,
      requestedId,
      scope,
    );
  }

  async listEntities(entityType: string, project?: string): Promise<{ items: readonly { readonly document: GitPmDocument; readonly path: string }[]; readonly draft_fingerprint: string }> {
    return await this.repository.listEntities(DIRECT_WORKSPACE_ID, entityType, project);
  }

  async getEntity(entityType: string, id: string): Promise<EntityResult> {
    return await this.repository.getEntity(DIRECT_WORKSPACE_ID, entityType, id);
  }

  async planDelete(entityType: string, id: string): Promise<DeletePlan> {
    return await this.repository.planDelete(DIRECT_WORKSPACE_ID, entityType, id);
  }

  async deleteEntity(entityType: string, id: string, unlinkReferences: boolean, scope: AgentScope = {}): Promise<{ deleted: true; path: string; unlinked_paths: readonly string[]; draft_fingerprint: string }> {
    return await this.repository.deleteEntity(
      DIRECT_WORKSPACE_ID,
      entityType,
      id,
      unlinkReferences,
      scope,
    );
  }

  async archiveEntity(entityType: string, id: string, scope: AgentScope = {}): Promise<EntityResult> {
    return await this.repository.archiveEntity(DIRECT_WORKSPACE_ID, entityType, id, scope);
  }

  async moveTask(id: string, targetProject: string, targetMilestone: string | undefined, scope: AgentScope = {}): Promise<EntityResult> {
    return await this.repository.moveTask(
      DIRECT_WORKSPACE_ID,
      id,
      targetProject,
      targetMilestone,
      scope,
    );
  }

  async getConfiguration(kind: "statuses" | "issue-types"): Promise<EntityResult> {
    return await this.repository.getConfiguration(DIRECT_WORKSPACE_ID, kind);
  }

  async updateConfiguration(kind: "statuses" | "issue-types", document: Record<string, unknown>, scope: AgentScope = {}): Promise<EntityResult> {
    return await this.repository.updateConfiguration(
      DIRECT_WORKSPACE_ID,
      kind,
      document,
      scope,
    );
  }

  async listComments(projectId: string, taskId: string): Promise<readonly CommentResult[]> {
    const draftId = await this.draftId();
    return await this.comments.list(draftId, projectId, taskId, this.directActor());
  }

  async createComment(projectId: string, taskId: string, body: string): Promise<CommentResult> {
    const draftId = await this.draftId();
    const metadata = await this.drafts.refreshWorkspaceFingerprint(draftId);
    return await this.comments.create(draftId, projectId, taskId, metadata.fingerprint, body, this.directActor());
  }

  async updateComment(projectId: string, taskId: string, commentId: string, body: string): Promise<CommentResult> {
    const draftId = await this.draftId();
    const metadata = await this.drafts.refreshWorkspaceFingerprint(draftId);
    const relative = `projects/${projectId}/comments/${taskId}/${commentId}.yaml`;
    const blob_id = await this.drafts.fileBlobId(draftId, relative);
    return await this.comments.update(draftId, projectId, taskId, commentId, metadata.fingerprint, blob_id, body, this.directActor());
  }

  async deleteComment(projectId: string, taskId: string, commentId: string): Promise<CommentResult> {
    const draftId = await this.draftId();
    const metadata = await this.drafts.refreshWorkspaceFingerprint(draftId);
    const relative = `projects/${projectId}/comments/${taskId}/${commentId}.yaml`;
    const blob_id = await this.drafts.fileBlobId(draftId, relative);
    return await this.comments.delete(draftId, projectId, taskId, commentId, metadata.fingerprint, blob_id, this.directActor());
  }

  async semanticDiff(scope: AgentScope = {}): Promise<SemanticDiff> {
    return await this.repository.semanticDiff(DIRECT_WORKSPACE_ID, scope);
  }

  async status(): Promise<DirectStatus> {
    await this.prepare();
    const checkout = await this.git.checkoutRealPath(this.checkoutPath);
    const branch = await this.git.checkoutCurrentBranch(checkout);
    const head = await this.git.headCommit(checkout);
    const porcelain = await this.git.statusPorcelain(checkout, GITPM_GUIDANCE_PATHS);
    const dirty = porcelain.trim() !== "";
    const { ahead, behind } = await this.git.checkoutAheadBehind(checkout);
    let remote: string | undefined;
    try {
      remote = await this.git.checkoutOriginUrl(checkout);
    } catch {
      remote = undefined;
    }
    return {
      mode: "direct",
      path: checkout,
      branch,
      head,
      dirty,
      ahead,
      behind,
      ...(remote === undefined ? {} : { remote }),
    };
  }

  async commitAll(message: string, scope: AgentScope = {}): Promise<DirectCommitResult> {
    const { commit, branch } = await this.repository.commitAll(DIRECT_WORKSPACE_ID, message, scope);
    return { commit, branch };
  }

  async push(): Promise<DirectPushResult> {
    return await this.repository.push(DIRECT_WORKSPACE_ID, this.pushAccessToken, {
      code: "GIT_PUSH_REMOTE_MISSING",
      message: "Push requires a configured remote and access token",
    });
  }

  isGitError(error: unknown): error is GitCommandError {
    return error instanceof GitCommandError;
  }
}
