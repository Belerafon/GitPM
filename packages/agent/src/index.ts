import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ChangesService, SemanticDiff } from "@gitpm/changes";
import type { DraftManager, DraftMetadata, WriterMode } from "@gitpm/drafts";
import { entityPathForDocument } from "@gitpm/domain";
import type { GitClient } from "@gitpm/git-client";
import type { GitLabMergeRequestProtocol, MergeRequestPayload, MergeRequestState } from "@gitpm/gitlab";
import { formatYamlDocument, type GitPmDocument } from "@gitpm/repository-format";
import { atomicWriteDomainFile } from "@gitpm/security";
import { validateRepository } from "@gitpm/validation";

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

const projectPath = (value: string): string | undefined => /^projects\/(PRJ-[^/]+)\//u.exec(value)?.[1];

export class AgentWorkflow {
  constructor(
    private readonly drafts: DraftManager,
    private readonly git: GitClient,
    private readonly changes: ChangesService,
    private readonly options: AgentWorkflowOptions,
  ) {}

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

  async status(draftId: string): Promise<DraftMetadata> { return await this.drafts.getDraft(draftId); }

  async assertScope(draftId: string, scope: AgentScope = {}): Promise<AgentScopeReport> {
    const metadata = await this.externalDraft(draftId);
    const report = await this.changes.list(draftId);
    for (const file of report.files) {
      if (scope.allowedProject !== undefined && projectPath(file.path) !== scope.allowedProject) {
        throw new AgentWorkflowError("AGENT_SCOPE_VIOLATION", `Path ${file.path} is outside Project ${scope.allowedProject}`);
      }
      if (file.kind === "Deleted" && scope.allowDelete !== true) {
        throw new AgentWorkflowError("AGENT_DELETE_CONFIRMATION_REQUIRED", `Deletion requires --allow-delete: ${file.path}`);
      }
    }
    if (metadata.writer_mode !== "external") throw new AgentWorkflowError("AGENT_EXTERNAL_MODE_REQUIRED", "Agent workflow requires external writer mode");
    return { affected_projects: report.affected_projects, changed_files: report.files.map(({ path, kind }) => ({ path, kind })) };
  }

  async semanticDiff(draftId: string, scope: AgentScope = {}): Promise<SemanticDiff> {
    await this.assertScope(draftId, scope);
    return await this.changes.semantic(draftId);
  }

  async createEntity(draftId: string, document: GitPmDocument, scope: AgentScope = {}) {
    const draft = await this.externalDraft(draftId);
    const relative = entityPathForDocument(document);
    const absolute = path.join(draft.worktree_path, ...relative.split("/"));
    try {
      await lstat(absolute);
      throw new AgentWorkflowError("ENTITY_EXISTS", `${relative} already exists`);
    } catch (error) {
      if (error instanceof AgentWorkflowError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
    await atomicWriteDomainFile(draft.worktree_path, relative, formatYamlDocument(document));
    try {
      await this.assertScope(draftId, scope);
      const validation = await validateRepository(draft.worktree_path);
      if (!validation.valid) throw new AgentWorkflowError("VALIDATION_FAILED", `Entity ${relative} makes the repository invalid`, validation.errors);
      const metadata = await this.drafts.refreshFingerprint(draftId);
      return { path: relative, draft_fingerprint: metadata.fingerprint, document };
    } catch (error) {
      await rm(absolute, { force: true });
      await this.drafts.refreshFingerprint(draftId);
      throw error;
    }
  }

  async commitAll(draftId: string, message: string, scope: AgentScope = {}) {
    const draft = await this.externalDraft(draftId);
    await this.assertScope(draftId, scope);
    const validation = await validateRepository(draft.worktree_path);
    if (!validation.valid) throw new AgentWorkflowError("VALIDATION_FAILED", "Commit is blocked by repository validation", validation.errors);
    if (!(await this.git.statusPorcelain(draft.worktree_path)).trim()) throw new AgentWorkflowError("NOTHING_TO_COMMIT", "Draft has no changes");
    const commit = await this.git.commitAll(draft.worktree_path, message, this.options.authorName, this.options.authorEmail);
    const metadata = await this.drafts.refreshFingerprint(draftId);
    return { commit, branch: metadata.branch, draft_fingerprint: metadata.fingerprint };
  }

  async push(draftId: string) {
    const draft = await this.externalDraft(draftId);
    if ((await this.git.statusPorcelain(draft.worktree_path)).trim()) throw new AgentWorkflowError("UNCOMMITTED_CHANGES", "Push requires a clean committed draft");
    if (!this.options.accessToken) throw new AgentWorkflowError("AGENT_TOKEN_REQUIRED", "Push requires an in-memory access token");
    await this.git.pushBranch(draft.worktree_path, draft.branch, this.options.accessToken);
    return { branch: draft.branch, commit: await this.git.headCommit(draft.worktree_path) };
  }

  async createMergeRequest(draftId: string, owner: string, title: string, description?: string): Promise<MergeRequestState> {
    const draft = await this.externalDraft(draftId);
    if (!title.trim() || title.length > 255) throw new AgentWorkflowError("MR_TITLE_INVALID", "Merge Request title is invalid");
    if (!this.options.accessToken || !this.options.mergeRequests) throw new AgentWorkflowError("AGENT_MR_CONFIGURATION_REQUIRED", "Merge Request configuration is unavailable");
    const payload: MergeRequestPayload = { source_branch: draft.branch, target_branch: this.options.defaultBranch, title, ...(description?.trim() ? { description } : {}) };
    const result = await this.options.mergeRequests.createMergeRequest(this.options.accessToken, payload);
    await this.drafts.markPublished(draftId, owner, result.iid);
    return result;
  }

  private async externalDraft(draftId: string): Promise<DraftMetadata> {
    const draft = await this.drafts.getDraft(draftId);
    if (draft.state !== "open") throw new AgentWorkflowError("DRAFT_NOT_OPEN", "Draft is not open");
    if (draft.writer_mode !== "external") throw new AgentWorkflowError("AGENT_EXTERNAL_MODE_REQUIRED", "Agent workflow requires external writer mode");
    return draft;
  }
}
