import { assertAgentScope, type AgentScope, type AgentScopeReport } from "@gitpm/agent";
import { ChangesService, type SemanticDiff } from "@gitpm/changes";
import { GitClient, GitCommandError } from "@gitpm/git-client";
import { DirectRepositoryBackend, directPushStrategy, DraftManager, GITPM_GUIDANCE_FILES, GITPM_GUIDANCE_PATHS } from "@gitpm/drafts";
import { CommentStore, EntityStore, entityPathForDocument, type CommentActor, type CommentResult, type DeletePlan, type EntityCreateBatchResult, type EntityResult } from "@gitpm/domain";
import type { GitPmDocument } from "@gitpm/repository-format";
import { validateRepository } from "@gitpm/validation";

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
  private readonly changes: ChangesService;
  private readonly entities: EntityStore;
  private readonly comments: CommentStore;
  private readonly pushStrategy: ReturnType<typeof directPushStrategy>;
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
    this.changes = new ChangesService(this.drafts, this.git);
    this.entities = new EntityStore(this.drafts, "repository");
    this.comments = new CommentStore(this.drafts, () => new Date(), "repository");
    this.pushStrategy = directPushStrategy(this.git);
    this.authorName = options.authorName;
    this.authorEmail = options.authorEmail;
    this.pushAccessToken = options.pushAccessToken;
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
    const workspace = await this.drafts.ensureDirectWorkspace("DRF-LOCAL", "local-user");
    this.workspaceDraftId = workspace.draft_id;
    this.prepared = true;
  }

  private async draftId(): Promise<string> {
    await this.prepare();
    if (this.workspaceDraftId === undefined) throw new Error("Direct workspace is unavailable");
    return this.workspaceDraftId;
  }

  async assertScope(scope: AgentScope = {}): Promise<AgentScopeReport> {
    const report = await this.changes.list(await this.draftId());
    return assertAgentScope(report, scope);
  }

  async createEntity(document: Readonly<Record<string, unknown>>, scope: AgentScope = {}, requestedType?: string): Promise<EntityResult> {
    const draftId = await this.draftId();
    await this.assertScope(scope);
    const planned = (await this.entities.planCreate(draftId, [document], requestedType))[0]!;
    const relative = entityPathForDocument(planned.document);
    const project = /^projects\/(P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6})\//u.exec(relative)?.[1];
    assertAgentScope({
      affected_projects: project === undefined ? [] : [project],
      files: [{ path: relative, kind: "Added" }],
    }, scope);
    const metadata = await this.drafts.refreshWorkspaceFingerprint(draftId);
    return await this.entities.create(
      draftId,
      metadata.owner_id,
      metadata.fingerprint,
      planned.document,
    );
  }

  async createEntities(
    documents: readonly Readonly<Record<string, unknown>>[],
    requestedType: string | undefined,
    scope: AgentScope = {},
    dryRun = false,
  ): Promise<EntityCreateBatchResult> {
    const draftId = await this.draftId();
    await this.assertScope(scope);
    const plan = await this.entities.planCreate(draftId, documents, requestedType);
    const affectedProjects = [...new Set(plan.flatMap((item) => {
      const project = /^projects\/(P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6})\//u.exec(item.path)?.[1];
      return project === undefined ? [] : [project];
    }))];
    assertAgentScope({
      affected_projects: affectedProjects,
      files: plan.map((item) => ({ path: item.path, kind: "Added" as const })),
    }, scope);
    const metadata = await this.drafts.refreshWorkspaceFingerprint(draftId);
    return await this.entities.createMany(draftId, metadata.owner_id, metadata.fingerprint, plan, dryRun);
  }

  async updateEntity(
    patch: Readonly<Record<string, unknown>>,
    requestedType: string,
    requestedId: string,
    scope: AgentScope = {},
  ): Promise<EntityResult> {
    const draftId = await this.draftId();
    await this.assertScope(scope);
    const plan = await this.entities.planUpdate(draftId, patch, requestedType, requestedId);
    const affectedProject = /^projects\/(P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6})\//u.exec(plan.path)?.[1];
    const assertPaths = (paths: readonly string[]): void => {
      const affectedProjects = [...new Set(paths.flatMap((relative) => {
        const project = /^projects\/(P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6})\//u.exec(relative)?.[1];
        return project === undefined ? [] : [project];
      }))];
      assertAgentScope({
        affected_projects: affectedProjects,
        files: paths.map((relative) => ({ path: relative, kind: "Modified" as const })),
      }, scope);
    };
    assertAgentScope({
      affected_projects: affectedProject === undefined ? [] : [affectedProject],
      files: [{ path: plan.path, kind: "Modified" }],
    }, scope);
    const metadata = await this.drafts.refreshWorkspaceFingerprint(draftId);
    const current = await this.entities.get(draftId, plan.entityType, plan.id);
    return await this.entities.update(
      draftId,
      metadata.owner_id,
      plan.entityType,
      plan.id,
      metadata.fingerprint,
      current.blob_id,
      plan.document,
      assertPaths,
    );
  }

  async listEntities(entityType: string, project?: string): Promise<{ items: readonly { readonly document: GitPmDocument; readonly path: string }[]; readonly draft_fingerprint: string }> {
    const draftId = await this.draftId();
    const results = await this.entities.list(draftId, entityType, project);
    const metadata = await this.drafts.getWorkspace(draftId);
    return { items: results.map((result) => ({ document: result.document, path: result.path })), draft_fingerprint: metadata.fingerprint };
  }

  async getEntity(entityType: string, id: string): Promise<EntityResult> {
    const draftId = await this.draftId();
    return await this.entities.get(draftId, entityType, id);
  }

  async planDelete(entityType: string, id: string): Promise<DeletePlan> {
    const draftId = await this.draftId();
    return await this.entities.planDelete(draftId, entityType, id);
  }

  async deleteEntity(entityType: string, id: string, unlinkReferences: boolean, scope: AgentScope = {}): Promise<{ deleted: true; path: string; unlinked_paths: readonly string[]; draft_fingerprint: string }> {
    const draftId = await this.draftId();
    await this.assertScope(scope);
    const plan = await this.entities.planDelete(draftId, entityType, id);
    const deletedPaths = [plan.path, ...plan.cascaded_comments.map((comment) => comment.path)];
    const modifiedPaths = unlinkReferences ? plan.would_unlink.map((item) => item.path) : [];
    const affectedProjects = [...new Set([...deletedPaths, ...modifiedPaths].flatMap((relative) => {
      const project = /^projects\/(P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6})\//u.exec(relative)?.[1];
      return project === undefined ? [] : [project];
    }))];
    assertAgentScope({
      affected_projects: affectedProjects,
      files: [
        ...deletedPaths.map((relative) => ({ path: relative, kind: "Deleted" as const })),
        ...modifiedPaths.map((relative) => ({ path: relative, kind: "Modified" as const })),
      ],
    }, scope);
    const metadata = await this.drafts.refreshWorkspaceFingerprint(draftId);
    const current = await this.entities.get(draftId, entityType, id);
    return await this.entities.delete(draftId, metadata.owner_id, entityType, id, metadata.fingerprint, current.blob_id, unlinkReferences);
  }

  async archiveEntity(entityType: string, id: string, scope: AgentScope = {}): Promise<EntityResult> {
    const draftId = await this.draftId();
    await this.assertScope(scope);
    const plan = await this.entities.planUpdate(draftId, { lifecycle: "archived" }, entityType, id);
    const affectedProject = /^projects\/(P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6})\//u.exec(plan.path)?.[1];
    assertAgentScope({
      affected_projects: affectedProject === undefined ? [] : [affectedProject],
      files: [{ path: plan.path, kind: "Modified" }],
    }, scope);
    const metadata = await this.drafts.refreshWorkspaceFingerprint(draftId);
    const current = await this.entities.get(draftId, plan.entityType, plan.id);
    return await this.entities.archive(draftId, metadata.owner_id, plan.entityType, plan.id, metadata.fingerprint, current.blob_id);
  }

  async moveTask(id: string, targetProject: string, targetMilestone: string | undefined, scope: AgentScope = {}): Promise<EntityResult> {
    const draftId = await this.draftId();
    await this.assertScope(scope);
    const current = await this.entities.get(draftId, "tasks", id);
    const sourceRelative = current.path;
    const sourceProject = /^projects\/(P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6})\//u.exec(sourceRelative)?.[1];
    const movedDocument = { ...current.document, project: targetProject, milestone: targetMilestone };
    const targetRelative = entityPathForDocument(movedDocument);
    const affectedProjects = [...new Set([sourceProject, targetProject].filter((value): value is string => value !== undefined))];
    assertAgentScope({
      affected_projects: affectedProjects,
      files: [{ path: sourceRelative, kind: "Deleted" }, { path: targetRelative, kind: "Added" }],
    }, scope);
    const metadata = await this.drafts.refreshWorkspaceFingerprint(draftId);
    return await this.entities.moveTask(draftId, metadata.owner_id, id, metadata.fingerprint, current.blob_id, targetProject, targetMilestone);
  }

  async getConfiguration(kind: "statuses" | "issue-types"): Promise<EntityResult> {
    const draftId = await this.draftId();
    return await this.entities.getConfiguration(draftId, kind);
  }

  async updateConfiguration(kind: "statuses" | "issue-types", document: Record<string, unknown>, scope: AgentScope = {}): Promise<EntityResult> {
    const draftId = await this.draftId();
    await this.assertScope(scope);
    const relative = kind === "statuses" ? ".gitpm/statuses.yaml" : ".gitpm/issue-types.yaml";
    assertAgentScope({ affected_projects: [], files: [{ path: relative, kind: "Modified" }] }, scope);
    const metadata = await this.drafts.refreshWorkspaceFingerprint(draftId);
    const current = await this.entities.getConfiguration(draftId, kind);
    return await this.entities.updateConfiguration(draftId, metadata.owner_id, kind, metadata.fingerprint, current.blob_id, document as GitPmDocument);
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
    const draftId = await this.draftId();
    await this.assertScope(scope);
    const report = await this.changes.semantic(draftId);
    return {
      ...report,
      unclassified_files: report.unclassified_files.filter((file) => !GITPM_GUIDANCE_FILES.has(file)),
    };
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
    await this.prepare();
    await this.assertScope(scope);
    const checkout = await this.git.checkoutRealPath(this.checkoutPath);
    const validation = await validateRepository(checkout);
    if (!validation.valid) {
      const error = new Error("Commit is blocked by repository validation") as Error & { code: string; details?: unknown };
      error.code = "VALIDATION_FAILED";
      error.details = validation.errors;
      throw error;
    }
    const porcelain = await this.git.statusPorcelain(checkout, GITPM_GUIDANCE_PATHS);
    if (porcelain.trim() === "") {
      const error = new Error("Working copy has no changes") as Error & { code: string };
      error.code = "NOTHING_TO_COMMIT";
      throw error;
    }
    const commit = await this.git.commitAll(checkout, message, this.authorName, this.authorEmail, GITPM_GUIDANCE_PATHS);
    const branch = await this.git.checkoutCurrentBranch(checkout);
    return { commit, branch };
  }

  async push(): Promise<DirectPushResult> {
    await this.prepare();
    const checkout = await this.git.checkoutRealPath(this.checkoutPath);
    const porcelain = await this.git.statusPorcelain(checkout, GITPM_GUIDANCE_PATHS);
    if (porcelain.trim() !== "") {
      const error = new Error("Push requires a clean committed working copy") as Error & { code: string };
      error.code = "UNCOMMITTED_CHANGES";
      throw error;
    }
    if (this.pushAccessToken === undefined) {
      const error = new Error("Push requires a configured remote and access token") as Error & { code: string };
      error.code = "GIT_PUSH_REMOTE_MISSING";
      throw error;
    }
    return await this.pushStrategy(checkout, await this.git.checkoutCurrentBranch(checkout), this.pushAccessToken);
  }

  isGitError(error: unknown): error is GitCommandError {
    return error instanceof GitCommandError;
  }
}
