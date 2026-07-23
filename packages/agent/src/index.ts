import type { ChangesService, SemanticDiff } from "@gitpm/changes";
import { GITPM_GUIDANCE_FILES, provisionGitPmWorktreeGuidance } from "@gitpm/drafts";
import type { DraftManager, DraftMetadata, WriterMode } from "@gitpm/drafts";
import {
  EntityStore,
  entityPathForDocument,
  type DeletePlan,
  type EntityCreateBatchResult,
} from "@gitpm/domain";
import type { GitClient } from "@gitpm/git-client";
import type { GitLabMergeRequestProtocol, MergeRequestState } from "@gitpm/gitlab";
import { PublicationService, validateMergeRequestData } from "@gitpm/publishing";
import type { GitPmDocument } from "@gitpm/repository-format";

export class AgentWorkflowError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message); this.name = "AgentWorkflowError";
  }
}

export interface AgentWorkflowOptions {
  readonly accessToken?: string;
  readonly authorEmail: string;
  readonly authorName: string;
  readonly defaultBranch: string;
  readonly mergeRequests?: GitLabMergeRequestProtocol;
}

export interface AgentScope {
  readonly allowedProject?: string;
  readonly allowDelete?: boolean;
}

export interface AgentScopeReport {
  readonly affected_projects: readonly string[];
  readonly changed_files: readonly { readonly path: string; readonly kind: "Added" | "Modified" | "Deleted" }[];
}

const projectPath = (value: string): string | undefined => /^projects\/(P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6})\//u.exec(value)?.[1];

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
      throw new AgentWorkflowError("AGENT_SCOPE_VIOLATION", `Path ${file.path} is outside Project ${scope.allowedProject}`);
    }
    if (file.kind === "Deleted" && scope.allowDelete !== true) {
      throw new AgentWorkflowError("AGENT_DELETE_CONFIRMATION_REQUIRED", `Deletion requires --allow-delete: ${file.path}`);
    }
  }
  return {
    affected_projects: report.affected_projects,
    changed_files: report.files
      .filter((file) => !GITPM_GUIDANCE_FILES.has(file.path))
      .map(({ path: filePath, kind }) => ({ path: filePath, kind })),
  };
}

export class AgentWorkflow {
  private readonly entities: EntityStore;
  private readonly publication: PublicationService;

  constructor(
    private readonly drafts: DraftManager,
    git: GitClient,
    private readonly changes: ChangesService,
    private readonly options: AgentWorkflowOptions,
  ) {
    this.entities = new EntityStore(drafts, "external");
    this.publication = new PublicationService(drafts, git, {
      defaultBranch: options.defaultBranch,
      ...(options.mergeRequests === undefined ? {} : { mergeRequests: options.mergeRequests }),
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
    const draft = await this.drafts.setWriterMode(draftId, owner, mode);
    return draft;
  }

  async status(draftId: string): Promise<DraftMetadata> {
    const draft = await this.drafts.getDraft(draftId);
    if (await provisionGitPmWorktreeGuidance(draft.worktree_path, draft.draft_id)) {
      return await this.drafts.refreshFingerprint(draftId);
    }
    return draft;
  }

  async assertScope(draftId: string, scope: AgentScope = {}): Promise<AgentScopeReport> {
    const metadata = await this.externalDraft(draftId);
    const report = await this.changes.list(draftId);
    if (metadata.writer_mode !== "external") throw new AgentWorkflowError("AGENT_EXTERNAL_MODE_REQUIRED", "Agent workflow requires external writer mode");
    return assertAgentScope(report, scope);
  }

  async semanticDiff(draftId: string, scope: AgentScope = {}): Promise<SemanticDiff> {
    await this.assertScope(draftId, scope);
    const report = await this.changes.semantic(draftId);
    return { ...report, unclassified_files: report.unclassified_files.filter((file) => !GITPM_GUIDANCE_FILES.has(file)) };
  }

  async createEntity(draftId: string, document: Readonly<Record<string, unknown>>, scope: AgentScope = {}, requestedType?: string) {
    const draft = await this.beginExternalMutation(draftId, scope);
    const plan = (await this.entities.planCreate(draftId, [document], requestedType))[0]!;
    this.assertPlannedPaths([{ path: plan.path, kind: "Added" }], scope);
    return await this.entities.create(draftId, draft.owner_gitlab_user_id, draft.fingerprint, plan.document);
  }

  async updateEntity(
    draftId: string,
    patch: Readonly<Record<string, unknown>>,
    requestedType: string,
    requestedId: string,
    scope: AgentScope = {},
  ) {
    const draft = await this.beginExternalMutation(draftId, scope);
    const plan = await this.entities.planUpdate(draftId, patch, requestedType, requestedId);
    this.assertPlannedPaths([{ path: plan.path, kind: "Modified" }], scope);
    const current = await this.entities.get(draftId, requestedType, requestedId);
    return await this.entities.update(
      draftId,
      draft.owner_gitlab_user_id,
      requestedType,
      requestedId,
      draft.fingerprint,
      current.blob_id,
      plan.document,
      (paths) => this.assertPlannedPaths(paths.map((changedPath) => ({ path: changedPath, kind: "Modified" })), scope),
    );
  }

  async createEntities(
    draftId: string,
    documents: readonly Readonly<Record<string, unknown>>[],
    requestedType: string | undefined,
    scope: AgentScope = {},
    dryRun = false,
  ): Promise<EntityCreateBatchResult> {
    const draft = await this.beginExternalMutation(draftId, scope);
    const plan = await this.entities.planCreate(draftId, documents, requestedType);
    this.assertPlannedPaths(plan.map((item) => ({ path: item.path, kind: "Added" as const })), scope);
    return await this.entities.createMany(draftId, draft.owner_gitlab_user_id, draft.fingerprint, plan, dryRun);
  }

  async listEntities(draftId: string, entityType: string, project?: string): Promise<{ items: readonly { readonly document: GitPmDocument; readonly path: string }[]; readonly draft_fingerprint: string }> {
    const draft = await this.externalDraft(draftId);
    const items = (await this.entities.list(draftId, entityType, project))
      .map(({ document, path: itemPath }) => ({ document, path: itemPath }));
    return { items, draft_fingerprint: draft.fingerprint };
  }

  async getEntity(draftId: string, entityType: string, id: string): Promise<{ document: GitPmDocument; path: string; draft_fingerprint: string }> {
    await this.externalDraft(draftId);
    const found = await this.entities.get(draftId, entityType, id);
    return { document: found.document, path: found.path, draft_fingerprint: found.draft_fingerprint };
  }

  async planDelete(draftId: string, entityType: string, id: string): Promise<DeletePlan> {
    await this.externalDraft(draftId);
    return await this.entities.planDelete(draftId, entityType, id);
  }

  async deleteEntity(draftId: string, entityType: string, id: string, unlinkReferences = false, scope: AgentScope = {}): Promise<{ deleted: true; path: string; unlinked_paths: readonly string[]; draft_fingerprint: string }> {
    const draft = await this.beginExternalMutation(draftId, scope);
    const plan = await this.entities.planDelete(draftId, entityType, id);
    this.assertPlannedPaths([
      { path: plan.path, kind: "Deleted" },
      ...plan.cascaded_comments.map((item) => ({ path: item.path, kind: "Deleted" as const })),
      ...(unlinkReferences ? plan.would_unlink.map((item) => ({ path: item.path, kind: "Modified" as const })) : []),
    ], scope);
    const current = await this.entities.get(draftId, entityType, id);
    return await this.entities.delete(
      draftId,
      draft.owner_gitlab_user_id,
      entityType,
      id,
      draft.fingerprint,
      current.blob_id,
      unlinkReferences,
    );
  }

  async archiveEntity(draftId: string, entityType: string, id: string, scope: AgentScope = {}): Promise<{ path: string; draft_fingerprint: string; document: GitPmDocument }> {
    const draft = await this.beginExternalMutation(draftId, scope);
    const current = await this.entities.get(draftId, entityType, id);
    this.assertPlannedPaths([{ path: current.path, kind: "Modified" }], scope);
    return await this.entities.archive(
      draftId,
      draft.owner_gitlab_user_id,
      entityType,
      id,
      draft.fingerprint,
      current.blob_id,
    );
  }

  async moveTask(draftId: string, id: string, targetProject: string, targetMilestone: string | undefined, scope: AgentScope = {}): Promise<{ path: string; draft_fingerprint: string; document: GitPmDocument }> {
    const draft = await this.beginExternalMutation(draftId, scope);
    const current = await this.entities.get(draftId, "tasks", id);
    const movedDocument = { ...current.document, project: targetProject, milestone: targetMilestone } as GitPmDocument;
    const targetRelative = entityPathForDocument(movedDocument);
    this.assertPlannedPaths([
      { path: current.path, kind: "Deleted" },
      { path: targetRelative, kind: "Added" },
    ], scope);
    return await this.entities.moveTask(
      draftId,
      draft.owner_gitlab_user_id,
      id,
      draft.fingerprint,
      current.blob_id,
      targetProject,
      targetMilestone,
    );
  }

  private assertPlannedPaths(
    files: readonly { readonly path: string; readonly kind: "Added" | "Modified" | "Deleted" }[],
    scope: AgentScope,
  ): void {
    assertAgentScope({
      affected_projects: [...new Set(files.flatMap((file) => {
        const project = projectPath(file.path);
        return project === undefined ? [] : [project];
      }))],
      files,
    }, scope);
  }

  private async beginExternalMutation(draftId: string, scope: AgentScope): Promise<DraftMetadata> {
    await this.assertScope(draftId, scope);
    // External writer mode intentionally permits files to be edited before the CLI operation.
    // Capture that authorized baseline, then let the shared mutation path reject any later race.
    return await this.drafts.refreshFingerprint(draftId);
  }

  async commitAll(draftId: string, message: string, scope: AgentScope = {}) {
    const draft = await this.externalDraft(draftId);
    await this.assertScope(draftId, scope);
    return await this.publication.commit({
      ownerId: draft.owner_gitlab_user_id,
      authorName: this.options.authorName,
      authorEmail: this.options.authorEmail,
    }, { draftId }, message);
  }

  async push(draftId: string) {
    const draft = await this.externalDraft(draftId);
    return await this.publication.push({
      ownerId: draft.owner_gitlab_user_id,
      accessToken: () => {
        if (!this.options.accessToken) throw new AgentWorkflowError("AGENT_TOKEN_REQUIRED", "Push requires an in-memory access token");
        return this.options.accessToken;
      },
    }, { draftId });
  }

  async createMergeRequest(draftId: string, owner: string, title: string, description?: string): Promise<MergeRequestState> {
    await this.externalDraft(draftId);
    validateMergeRequestData({ title, ...(description === undefined ? {} : { description }) });
    const accessToken = this.options.accessToken;
    if (!accessToken || !this.options.mergeRequests) throw new AgentWorkflowError("AGENT_MR_CONFIGURATION_REQUIRED", "Merge Request configuration is unavailable");
    return await this.publication.createMergeRequest({
      ownerId: owner,
      accessToken: () => accessToken,
    }, { draftId }, { title, ...(description === undefined ? {} : { description }) });
  }

  private async externalDraft(draftId: string): Promise<DraftMetadata> {
    let draft = await this.drafts.getDraft(draftId);
    if (draft.state !== "open") throw new AgentWorkflowError("DRAFT_NOT_OPEN", "Draft is not open");
    if (draft.writer_mode !== "external") throw new AgentWorkflowError("AGENT_EXTERNAL_MODE_REQUIRED", "Agent workflow requires external writer mode");
    if (await provisionGitPmWorktreeGuidance(draft.worktree_path, draft.draft_id)) draft = await this.drafts.refreshFingerprint(draftId);
    return draft;
  }
}
