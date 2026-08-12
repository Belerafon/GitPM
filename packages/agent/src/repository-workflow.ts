import type { ChangesService, SemanticDiff } from "@gitpm/changes";
import {
  GITPM_GUIDANCE_FILES,
  type DraftManager,
  type RepositoryMutationMode,
  type RepositoryWorkspace,
} from "@gitpm/drafts";
import {
  EntityStore,
  entityPathForDocument,
  type DeletePlan,
  type EntityCreateBatchResult,
  type EntityResult,
  type LifecycleTransitionOptions,
} from "@gitpm/domain";
import type { GitClient } from "@gitpm/git-client";
import type { GitLabMergeRequestProtocol, MergeRequestState } from "@gitpm/gitlab";
import {
  PublicationService,
  validateMergeRequestData,
  type MergeRequestData,
} from "@gitpm/publishing";
import type { GitPmDocument } from "@gitpm/repository-format";

export interface AgentScope {
  readonly allowedProject?: string;
  readonly allowDelete?: boolean;
}

export interface AgentScopeReport {
  readonly affected_projects: readonly string[];
  readonly changed_files: readonly { readonly path: string; readonly kind: "Added" | "Modified" | "Deleted" }[];
}

export class RepositoryWorkflowError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "RepositoryWorkflowError";
  }
}

type WorkflowErrorFactory = (code: string, message: string, details?: unknown) => Error;

export interface RepositoryWorkflowOptions {
  readonly mutationMode: RepositoryMutationMode;
  readonly authorEmail: string;
  readonly authorName: string;
  readonly defaultBranch: string;
  readonly mergeRequests?: GitLabMergeRequestProtocol;
  readonly prepareWorkspace: (workspaceId: string) => Promise<void>;
  readonly createError?: WorkflowErrorFactory;
}

const projectPath = (value: string): string | undefined =>
  /^projects\/(P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6})\//u.exec(value)?.[1];

export function assertAgentScope(
  report: {
    readonly affected_projects: readonly string[];
    readonly files: readonly { readonly path: string; readonly kind: "Added" | "Modified" | "Deleted" }[];
  },
  scope: AgentScope = {},
): AgentScopeReport {
  for (const file of report.files) {
    if (GITPM_GUIDANCE_FILES.has(file.path)) continue;
    if (scope.allowedProject !== undefined && projectPath(file.path) !== scope.allowedProject) {
      throw new RepositoryWorkflowError("AGENT_SCOPE_VIOLATION", `Path ${file.path} is outside Project ${scope.allowedProject}`);
    }
    if (file.kind === "Deleted" && scope.allowDelete !== true) {
      throw new RepositoryWorkflowError("AGENT_DELETE_CONFIRMATION_REQUIRED", `Deletion requires --allow-delete: ${file.path}`);
    }
  }
  return {
    affected_projects: report.affected_projects,
    changed_files: report.files
      .filter((file) => !GITPM_GUIDANCE_FILES.has(file.path))
      .map(({ path: filePath, kind }) => ({ path: filePath, kind })),
  };
}

function assertDeleteConfirmation(
  files: readonly { readonly path: string; readonly kind: "Added" | "Modified" | "Deleted" }[],
  scope: AgentScope,
): void {
  if (scope.allowDelete === true) return;
  const deleted = files.find((file) => file.kind === "Deleted");
  if (deleted !== undefined) {
    throw new RepositoryWorkflowError("AGENT_DELETE_CONFIRMATION_REQUIRED", `Deletion requires --allow-delete: ${deleted.path}`);
  }
}

function inOperationScope(relativePath: string, scope: AgentScope): boolean {
  return scope.allowedProject === undefined || projectPath(relativePath) === scope.allowedProject;
}

/**
 * Mode-neutral CLI use cases. Direct and external-worktree runtimes provide only workspace
 * preparation, mutation mode, credentials and mode-specific lifecycle/publication behavior.
 */
export class RepositoryWorkflow {
  private readonly entities: EntityStore;
  private readonly createError: WorkflowErrorFactory;
  private readonly publication: PublicationService;

  constructor(
    private readonly drafts: DraftManager,
    git: GitClient,
    private readonly changes: ChangesService,
    private readonly options: RepositoryWorkflowOptions,
  ) {
    this.entities = new EntityStore(drafts, options.mutationMode);
    this.createError = options.createError ?? ((code, message, details) =>
      new RepositoryWorkflowError(code, message, details));
    this.publication = new PublicationService(drafts, git, {
      defaultBranch: options.defaultBranch,
      ...(options.mergeRequests === undefined ? {} : { mergeRequests: options.mergeRequests }),
    });
  }

  async assertScope(workspaceId: string, scope: AgentScope = {}): Promise<AgentScopeReport> {
    await this.workspace(workspaceId);
    const report = await this.changes.list(workspaceId);
    try {
      assertDeleteConfirmation(report.files, scope);
    } catch (error) {
      if (error instanceof RepositoryWorkflowError) {
        throw this.createError(error.code, error.message, error.details);
      }
      throw error;
    }
    const changedFiles = report.files.filter((file) => inOperationScope(file.path, scope));
    return {
      affected_projects: report.affected_projects.filter((project) => scope.allowedProject === undefined || project === scope.allowedProject),
      changed_files: changedFiles.map(({ path: filePath, kind }) => ({ path: filePath, kind })),
    };
  }

  async semanticDiff(workspaceId: string, scope: AgentScope = {}): Promise<SemanticDiff> {
    await this.assertScope(workspaceId, scope);
    const report = await this.changes.semantic(workspaceId);
    const select = (changes: SemanticDiff["created"]): SemanticDiff["created"] =>
      changes.filter((change) => inOperationScope(change.path, scope));
    const created = select(report.created);
    const updated = select(report.updated);
    const archived = select(report.archived);
    const deleted = select(report.deleted);
    return {
      created,
      updated,
      archived,
      deleted,
      counts: {
        created: created.length,
        updated: updated.length,
        archived: archived.length,
        deleted: deleted.length,
      },
      affected_projects: report.affected_projects.filter((project) => scope.allowedProject === undefined || project === scope.allowedProject),
      file_entities: report.file_entities?.filter((file) => inOperationScope(file.path, scope)),
      unclassified_files: report.unclassified_files.filter((file) => !GITPM_GUIDANCE_FILES.has(file) && inOperationScope(file, scope)),
    };
  }

  async listChanges(workspaceId: string, scope: AgentScope = {}) {
    await this.assertScope(workspaceId, scope);
    const report = await this.changes.list(workspaceId);
    const files = report.files.filter((file) => inOperationScope(file.path, scope));
    return {
      files,
      changed_files_count: files.length,
      affected_projects: report.affected_projects.filter((project) => scope.allowedProject === undefined || project === scope.allowedProject),
    };
  }

  async restoreFile(workspaceId: string, relativePath: string, scope: AgentScope = {}) {
    const workspace = await this.beginMutation(workspaceId, scope);
    this.assertPlannedPaths([{ path: relativePath, kind: "Modified" }], scope);
    return await this.changes.restoreFile(
      workspaceId,
      workspace.owner_id,
      workspace.fingerprint,
      relativePath,
      this.options.mutationMode,
    );
  }

  async restoreHunk(
    workspaceId: string,
    relativePath: string,
    diffToken: string,
    hunkIndex: number,
    scope: AgentScope = {},
  ) {
    const workspace = await this.beginMutation(workspaceId, scope);
    this.assertPlannedPaths([{ path: relativePath, kind: "Modified" }], scope);
    return await this.changes.restoreHunk(
      workspaceId,
      workspace.owner_id,
      workspace.fingerprint,
      relativePath,
      diffToken,
      hunkIndex,
      this.options.mutationMode,
    );
  }

  async discardAll(workspaceId: string, scope: AgentScope = {}) {
    const workspace = await this.beginWholeDraftMutation(workspaceId, scope);
    return await this.changes.discardAll(
      workspaceId,
      workspace.owner_id,
      workspace.fingerprint,
      this.options.mutationMode,
    );
  }

  async createEntity(
    workspaceId: string,
    document: Readonly<Record<string, unknown>>,
    scope: AgentScope = {},
    requestedType?: string,
  ): Promise<EntityResult> {
    const workspace = await this.beginMutation(workspaceId, scope);
    const plan = (await this.entities.planCreate(workspaceId, [document], requestedType))[0]!;
    this.assertPlannedPaths([{ path: plan.path, kind: "Added" }], scope);
    return await this.entities.create(workspaceId, workspace.owner_id, workspace.fingerprint, plan.document);
  }

  async createEntities(
    workspaceId: string,
    documents: readonly Readonly<Record<string, unknown>>[],
    requestedType: string | undefined,
    scope: AgentScope = {},
    dryRun = false,
  ): Promise<EntityCreateBatchResult> {
    const workspace = await this.beginMutation(workspaceId, scope);
    const plan = await this.entities.planCreate(workspaceId, documents, requestedType);
    this.assertPlannedPaths(plan.map((item) => ({ path: item.path, kind: "Added" as const })), scope);
    return await this.entities.createMany(
      workspaceId,
      workspace.owner_id,
      workspace.fingerprint,
      plan,
      dryRun,
    );
  }

  async updateEntity(
    workspaceId: string,
    patch: Readonly<Record<string, unknown>>,
    requestedType: string,
    requestedId: string,
    scope: AgentScope = {},
  ): Promise<EntityResult> {
    const workspace = await this.beginMutation(workspaceId, scope);
    const plan = await this.entities.planUpdate(workspaceId, patch, requestedType, requestedId);
    this.assertPlannedPaths([{ path: plan.path, kind: "Modified" }], scope);
    const current = await this.entities.get(workspaceId, plan.entityType, plan.id);
    return await this.entities.update(
      workspaceId,
      workspace.owner_id,
      plan.entityType,
      plan.id,
      workspace.fingerprint,
      current.blob_id,
      plan.document,
      (paths) => this.assertPlannedPaths(
        paths.map((changedPath) => ({ path: changedPath, kind: "Modified" })),
        scope,
      ),
    );
  }

  async listEntities(
    workspaceId: string,
    entityType: string,
    project?: string,
  ): Promise<{
    items: readonly { readonly document: GitPmDocument; readonly path: string }[];
    readonly draft_fingerprint: string;
  }> {
    const workspace = await this.workspace(workspaceId);
    const items = (await this.entities.list(workspaceId, entityType, project))
      .map(({ document, path: itemPath }) => ({ document, path: itemPath }));
    return { items, draft_fingerprint: workspace.fingerprint };
  }

  async getEntity(
    workspaceId: string,
    entityType: string,
    id: string,
  ): Promise<EntityResult> {
    await this.workspace(workspaceId);
    return await this.entities.get(workspaceId, entityType, id);
  }

  async planDelete(workspaceId: string, entityType: string, id: string): Promise<DeletePlan> {
    await this.workspace(workspaceId);
    return await this.entities.planDelete(workspaceId, entityType, id);
  }

  async deleteEntity(
    workspaceId: string,
    entityType: string,
    id: string,
    unlinkReferences = false,
    scope: AgentScope = {},
    cascadeReferences = false,
  ): Promise<{ deleted: true; path: string; unlinked_paths: readonly string[]; cascaded_paths: readonly string[]; draft_fingerprint: string }> {
    const workspace = await this.beginMutation(workspaceId, scope);
    const plan = await this.entities.planDelete(workspaceId, entityType, id);
    this.assertPlannedPaths([
      { path: plan.path, kind: "Deleted" },
      ...plan.cascaded_comments.map((item) => ({ path: item.path, kind: "Deleted" as const })),
      ...(unlinkReferences
        ? plan.would_unlink.map((item) => ({ path: item.path, kind: "Modified" as const }))
        : []),
      ...(cascadeReferences
        ? plan.cascaded_entities.map((item) => ({ path: item.path, kind: "Deleted" as const }))
        : []),
    ], scope);
    const current = await this.entities.get(workspaceId, entityType, id);
    return await this.entities.delete(
      workspaceId,
      workspace.owner_id,
      entityType,
      id,
      workspace.fingerprint,
      current.blob_id,
      unlinkReferences,
      cascadeReferences,
    );
  }

  async archiveEntity(
    workspaceId: string,
    entityType: string,
    id: string,
    scope: AgentScope = {},
    options: LifecycleTransitionOptions = {},
  ): Promise<EntityResult> {
    const workspace = await this.beginMutation(workspaceId, scope);
    const current = await this.entities.get(workspaceId, entityType, id);
    const related = options.includeTasks === true && current.document.schema === "gitpm/milestone@2"
      ? (await this.entities.list(workspaceId, "tasks", String(current.document.project))).filter((task) => task.document.milestone === id)
      : [];
    this.assertPlannedPaths([current, ...related].map((entity) => ({ path: entity.path, kind: "Modified" as const })), scope);
    return await this.entities.archive(
      workspaceId,
      workspace.owner_id,
      entityType,
      id,
      workspace.fingerprint,
      current.blob_id,
      options,
    );
  }

  async restoreEntity(
    workspaceId: string,
    entityType: string,
    id: string,
    scope: AgentScope = {},
    options: LifecycleTransitionOptions = {},
  ): Promise<EntityResult> {
    const workspace = await this.beginMutation(workspaceId, scope);
    const current = await this.entities.get(workspaceId, entityType, id);
    const relatedTasks = options.includeTasks === true && current.document.schema === "gitpm/milestone@2"
      ? (await this.entities.list(workspaceId, "tasks", String(current.document.project))).filter((task) => task.document.milestone === id)
      : [];
    const milestone = options.restoreMilestone === true && current.document.schema === "gitpm/task@2" && typeof current.document.milestone === "string"
      ? await this.entities.get(workspaceId, "milestones", current.document.milestone)
      : undefined;
    this.assertPlannedPaths([current, ...relatedTasks, ...(milestone === undefined ? [] : [milestone])].map((entity) => ({ path: entity.path, kind: "Modified" as const })), scope);
    return await this.entities.restore(
      workspaceId,
      workspace.owner_id,
      entityType,
      id,
      workspace.fingerprint,
      current.blob_id,
      options,
    );
  }

  async moveTask(
    workspaceId: string,
    id: string,
    targetProject: string,
    targetMilestone: string | undefined,
    targetParent: string | undefined,
    scope: AgentScope = {},
  ): Promise<EntityResult> {
    const workspace = await this.beginMutation(workspaceId, scope);
    const current = await this.entities.get(workspaceId, "tasks", id);
    const movedDocument = { ...current.document, project: targetProject, milestone: targetMilestone, parent: targetParent } as GitPmDocument;
    const targetRelative = entityPathForDocument(movedDocument);
    this.assertPlannedPaths(current.path === targetRelative
      ? [{ path: current.path, kind: "Modified" }]
      : [{ path: current.path, kind: "Deleted" }, { path: targetRelative, kind: "Added" }], scope);
    return await this.entities.moveTask(
      workspaceId,
      workspace.owner_id,
      id,
      workspace.fingerprint,
      current.blob_id,
      targetProject,
      targetMilestone,
      targetParent,
    );
  }

  async getConfiguration(
    workspaceId: string,
    kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks",
  ): Promise<EntityResult> {
    await this.workspace(workspaceId);
    return await this.entities.getConfiguration(workspaceId, kind);
  }

  async getRepositoryConfiguration(workspaceId: string): Promise<EntityResult> {
    await this.workspace(workspaceId);
    return await this.entities.getRepositoryConfiguration(workspaceId);
  }

  async updateConfiguration(
    workspaceId: string,
    kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks",
    document: Record<string, unknown>,
    scope: AgentScope = {},
  ): Promise<EntityResult> {
    const workspace = await this.beginMutation(workspaceId, scope);
    const relative = kind === "statuses" ? ".gitpm/statuses.yaml"
      : kind === "issue-types" ? ".gitpm/issue-types.yaml"
        : kind === "work-categories" ? ".gitpm/work-categories.yaml"
          : ".gitpm/schedule-tracks.yaml";
    this.assertPlannedPaths([{ path: relative, kind: "Modified" }], scope);
    const current = await this.entities.getConfiguration(workspaceId, kind);
    return await this.entities.updateConfiguration(
      workspaceId,
      workspace.owner_id,
      kind,
      workspace.fingerprint,
      current.blob_id,
      document as GitPmDocument,
    );
  }

  async updateRepositoryConfiguration(
    workspaceId: string,
    document: Record<string, unknown>,
    scope: AgentScope = {},
  ): Promise<EntityResult> {
    const workspace = await this.beginMutation(workspaceId, scope);
    const relative = ".gitpm/repository.yaml";
    this.assertPlannedPaths([{ path: relative, kind: "Modified" }], scope);
    const current = await this.entities.getRepositoryConfiguration(workspaceId);
    return await this.entities.updateRepositoryConfiguration(
      workspaceId,
      workspace.owner_id,
      workspace.fingerprint,
      current.blob_id,
      document as GitPmDocument,
    );
  }

  async commitAll(workspaceId: string, message: string, scope: AgentScope = {}) {
    const workspace = await this.workspace(workspaceId);
    await this.assertWholeChangeSetScope(workspaceId, scope);
    return await this.publication.commit({
      ownerId: workspace.owner_id,
      authorName: this.options.authorName,
      authorEmail: this.options.authorEmail,
    }, { draftId: workspaceId }, message);
  }

  async push(
    workspaceId: string,
    accessToken: string | undefined,
    missingToken: { readonly code: string; readonly message: string },
  ): Promise<{ branch: string; commit: string }> {
    const workspace = await this.workspace(workspaceId);
    return await this.publication.push({
      ownerId: workspace.owner_id,
      accessToken: () => {
        if (accessToken === undefined) throw this.createError(missingToken.code, missingToken.message);
        return accessToken;
      },
    }, { draftId: workspaceId });
  }

  async createMergeRequest(
    workspaceId: string,
    ownerId: string,
    accessToken: string | undefined,
    data: MergeRequestData,
    missingConfiguration: { readonly code: string; readonly message: string },
  ): Promise<MergeRequestState> {
    await this.workspace(workspaceId);
    validateMergeRequestData(data);
    if (accessToken === undefined || this.options.mergeRequests === undefined) {
      throw this.createError(missingConfiguration.code, missingConfiguration.message);
    }
    return await this.publication.createMergeRequest({
      ownerId,
      accessToken: () => accessToken,
    }, { draftId: workspaceId }, data);
  }

  async pollMergeRequest(
    workspaceId: string,
    ownerId: string,
    accessToken: string | undefined,
    missingConfiguration: { readonly code: string; readonly message: string },
  ): Promise<MergeRequestState> {
    if (accessToken === undefined || this.options.mergeRequests === undefined) {
      throw this.createError(missingConfiguration.code, missingConfiguration.message);
    }
    return await this.publication.pollMergeRequest({
      ownerId,
      accessToken: () => accessToken,
    }, { draftId: workspaceId });
  }

  private async workspace(workspaceId: string): Promise<RepositoryWorkspace> {
    await this.options.prepareWorkspace(workspaceId);
    return await this.drafts.getWorkspace(workspaceId);
  }

  private async beginMutation(workspaceId: string, scope: AgentScope): Promise<RepositoryWorkspace> {
    await this.workspace(workspaceId);
    const report = await this.changes.list(workspaceId);
    try {
      assertDeleteConfirmation(report.files, scope);
    } catch (error) {
      if (error instanceof RepositoryWorkflowError) {
        throw this.createError(error.code, error.message, error.details);
      }
      throw error;
    }
    // External and direct repository writers may both observe authorized filesystem edits before
    // a CLI operation. Capture that baseline, then let EntityStore reject any later race.
    return await this.drafts.refreshWorkspaceFingerprint(workspaceId);
  }

  private async beginWholeDraftMutation(workspaceId: string, scope: AgentScope): Promise<RepositoryWorkspace> {
    await this.workspace(workspaceId);
    await this.assertWholeChangeSetScope(workspaceId, scope);
    return await this.drafts.refreshWorkspaceFingerprint(workspaceId);
  }

  private async assertWholeChangeSetScope(workspaceId: string, scope: AgentScope): Promise<void> {
    const report = await this.changes.list(workspaceId);
    try {
      assertAgentScope(report, scope);
    } catch (error) {
      if (error instanceof RepositoryWorkflowError) {
        throw this.createError(error.code, error.message, error.details);
      }
      throw error;
    }
  }

  private assertPlannedPaths(
    files: readonly { readonly path: string; readonly kind: "Added" | "Modified" | "Deleted" }[],
    scope: AgentScope,
  ): void {
    try {
      assertAgentScope({
        affected_projects: [...new Set(files.flatMap((file) => {
          const project = projectPath(file.path);
          return project === undefined ? [] : [project];
        }))],
        files,
      }, scope);
    } catch (error) {
      if (error instanceof RepositoryWorkflowError) {
        throw this.createError(error.code, error.message, error.details);
      }
      throw error;
    }
  }
}
