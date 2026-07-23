import type { ChangesService, SemanticDiff } from "@gitpm/changes";
import {
  GITPM_GUIDANCE_FILES,
  GITPM_GUIDANCE_PATHS,
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
} from "@gitpm/domain";
import type { GitClient } from "@gitpm/git-client";
import type { GitPmDocument } from "@gitpm/repository-format";
import { validateRepository } from "@gitpm/validation";

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
  readonly prepareWorkspace: (workspaceId: string) => Promise<void>;
  readonly createError?: WorkflowErrorFactory;
  readonly emptyCommitMessage?: string;
  readonly dirtyPushMessage?: string;
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

/**
 * Mode-neutral CLI use cases. Direct and external-worktree runtimes provide only workspace
 * preparation, mutation mode, credentials and mode-specific lifecycle/publication behavior.
 */
export class RepositoryWorkflow {
  private readonly entities: EntityStore;
  private readonly createError: WorkflowErrorFactory;

  constructor(
    private readonly drafts: DraftManager,
    private readonly git: GitClient,
    private readonly changes: ChangesService,
    private readonly options: RepositoryWorkflowOptions,
  ) {
    this.entities = new EntityStore(drafts, options.mutationMode);
    this.createError = options.createError ?? ((code, message, details) =>
      new RepositoryWorkflowError(code, message, details));
  }

  async assertScope(workspaceId: string, scope: AgentScope = {}): Promise<AgentScopeReport> {
    await this.workspace(workspaceId);
    const report = await this.changes.list(workspaceId);
    try {
      return assertAgentScope(report, scope);
    } catch (error) {
      if (error instanceof RepositoryWorkflowError) {
        throw this.createError(error.code, error.message, error.details);
      }
      throw error;
    }
  }

  async semanticDiff(workspaceId: string, scope: AgentScope = {}): Promise<SemanticDiff> {
    await this.assertScope(workspaceId, scope);
    const report = await this.changes.semantic(workspaceId);
    return {
      ...report,
      unclassified_files: report.unclassified_files.filter((file) => !GITPM_GUIDANCE_FILES.has(file)),
    };
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
  ): Promise<{ deleted: true; path: string; unlinked_paths: readonly string[]; draft_fingerprint: string }> {
    const workspace = await this.beginMutation(workspaceId, scope);
    const plan = await this.entities.planDelete(workspaceId, entityType, id);
    this.assertPlannedPaths([
      { path: plan.path, kind: "Deleted" },
      ...plan.cascaded_comments.map((item) => ({ path: item.path, kind: "Deleted" as const })),
      ...(unlinkReferences
        ? plan.would_unlink.map((item) => ({ path: item.path, kind: "Modified" as const }))
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
    );
  }

  async archiveEntity(
    workspaceId: string,
    entityType: string,
    id: string,
    scope: AgentScope = {},
  ): Promise<EntityResult> {
    const workspace = await this.beginMutation(workspaceId, scope);
    const current = await this.entities.get(workspaceId, entityType, id);
    this.assertPlannedPaths([{ path: current.path, kind: "Modified" }], scope);
    return await this.entities.archive(
      workspaceId,
      workspace.owner_id,
      entityType,
      id,
      workspace.fingerprint,
      current.blob_id,
    );
  }

  async moveTask(
    workspaceId: string,
    id: string,
    targetProject: string,
    targetMilestone: string | undefined,
    scope: AgentScope = {},
  ): Promise<EntityResult> {
    const workspace = await this.beginMutation(workspaceId, scope);
    const current = await this.entities.get(workspaceId, "tasks", id);
    const movedDocument = { ...current.document, project: targetProject, milestone: targetMilestone } as GitPmDocument;
    const targetRelative = entityPathForDocument(movedDocument);
    this.assertPlannedPaths([
      { path: current.path, kind: "Deleted" },
      { path: targetRelative, kind: "Added" },
    ], scope);
    return await this.entities.moveTask(
      workspaceId,
      workspace.owner_id,
      id,
      workspace.fingerprint,
      current.blob_id,
      targetProject,
      targetMilestone,
    );
  }

  async getConfiguration(
    workspaceId: string,
    kind: "statuses" | "issue-types",
  ): Promise<EntityResult> {
    await this.workspace(workspaceId);
    return await this.entities.getConfiguration(workspaceId, kind);
  }

  async updateConfiguration(
    workspaceId: string,
    kind: "statuses" | "issue-types",
    document: Record<string, unknown>,
    scope: AgentScope = {},
  ): Promise<EntityResult> {
    const workspace = await this.beginMutation(workspaceId, scope);
    const relative = kind === "statuses" ? ".gitpm/statuses.yaml" : ".gitpm/issue-types.yaml";
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

  async commitAll(workspaceId: string, message: string, scope: AgentScope = {}) {
    const workspace = await this.workspace(workspaceId);
    const scoped = await this.assertScope(workspaceId, scope);
    const validation = await validateRepository(workspace.worktree_path);
    if (!validation.valid) {
      throw this.createError(
        "VALIDATION_FAILED",
        "Commit is blocked by repository validation",
        validation.errors,
      );
    }
    if (scoped.changed_files.length === 0) {
      throw this.createError(
        "NOTHING_TO_COMMIT",
        this.options.emptyCommitMessage ?? "Working copy has no business changes",
      );
    }
    const commit = await this.git.commitAll(
      workspace.worktree_path,
      message,
      this.options.authorName,
      this.options.authorEmail,
      GITPM_GUIDANCE_PATHS,
    );
    const metadata = await this.drafts.refreshWorkspaceFingerprint(workspaceId);
    return { commit, branch: metadata.branch, draft_fingerprint: metadata.fingerprint };
  }

  async push(
    workspaceId: string,
    accessToken: string | undefined,
    missingToken: { readonly code: string; readonly message: string },
  ): Promise<{ branch: string; commit: string }> {
    await this.workspace(workspaceId);
    const changes = await this.changes.list(workspaceId);
    if (changes.files.length > 0) {
      throw this.createError(
        "UNCOMMITTED_CHANGES",
        this.options.dirtyPushMessage ?? "Push requires a clean committed working copy",
      );
    }
    if (accessToken === undefined) throw this.createError(missingToken.code, missingToken.message);
    return await this.drafts.push(workspaceId, accessToken);
  }

  private async workspace(workspaceId: string): Promise<RepositoryWorkspace> {
    await this.options.prepareWorkspace(workspaceId);
    return await this.drafts.getWorkspace(workspaceId);
  }

  private async beginMutation(workspaceId: string, scope: AgentScope): Promise<RepositoryWorkspace> {
    await this.assertScope(workspaceId, scope);
    // External and direct repository writers may both observe authorized filesystem edits before
    // a CLI operation. Capture that baseline, then let EntityStore reject any later race.
    return await this.drafts.refreshWorkspaceFingerprint(workspaceId);
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
