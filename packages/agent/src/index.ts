import { lstat, mkdir, readFile, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type { ChangesService, SemanticDiff } from "@gitpm/changes";
import { GITPM_GUIDANCE_FILES, GITPM_GUIDANCE_PATHS, provisionGitPmWorktreeGuidance } from "@gitpm/drafts";
import type { DraftManager, DraftMetadata, WriterMode } from "@gitpm/drafts";
import {
  canonicalEntityType,
  containsEntityReference,
  ENTITY_TYPE_SCHEMAS,
  entityDisplayLabel,
  entityPathForDocument,
  planEntityCreation,
  planEntityUpdate,
  unlinkPersonReference,
  type DeletePlan,
  type DeleteRestriction,
  type EntityCreateBatchResult,
} from "@gitpm/domain";
import type { GitClient } from "@gitpm/git-client";
import type { GitLabMergeRequestProtocol, MergeRequestPayload, MergeRequestState } from "@gitpm/gitlab";
import { formatYamlDocument, parseYamlDocument, referenceLabelForDocument, referenceLabelsForDocuments, type GitPmDocument } from "@gitpm/repository-format";
import { atomicWriteDomainFile } from "@gitpm/security";
import { validateDelete, validateRepository } from "@gitpm/validation";

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

interface RepositoryEntry {
  readonly absolute: string;
  readonly relative: string;
  readonly document: GitPmDocument;
}

async function repositoryEntries(root: string): Promise<RepositoryEntry[]> {
  const result: RepositoryEntry[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.name.endsWith(".yaml")) {
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        result.push({ absolute, relative, document: parseYamlDocument(await readFile(absolute, "utf8"), relative) });
      }
    }
  };
  await walk(root);
  return result;
}

async function repositoryDocuments(root: string): Promise<GitPmDocument[]> {
  return (await repositoryEntries(root)).map((entry) => entry.document);
}

async function pathExists(absolute: string): Promise<boolean> {
  try { await lstat(absolute); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

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
    const batch = await this.createEntities(draftId, [document], requestedType, scope, false);
    const item = batch.items[0]!;
    return { path: item.path, draft_fingerprint: batch.draft_fingerprint, document: item.document };
  }

  async updateEntity(
    draftId: string,
    patch: Readonly<Record<string, unknown>>,
    requestedType: string,
    requestedId: string,
    scope: AgentScope = {},
  ) {
    await this.assertScope(draftId, scope);
    const draft = await this.externalDraft(draftId);
    const entries = await repositoryEntries(draft.worktree_path);
    const plan = planEntityUpdate(patch, entries.map((entry) => entry.document), requestedType, requestedId);
    assertAgentScope({
      affected_projects: projectPath(plan.path) === undefined ? [] : [projectPath(plan.path)!],
      files: [{ path: plan.path, kind: "Modified" }],
    }, scope);
    const target = entries.find((entry) => entry.relative === plan.path)!;
    const referenceLabels = referenceLabelsForDocuments(entries.map((entry) => entry.relative === plan.path ? plan.document : entry.document));
    const originals = new Map<string, string>();
    try {
      const original = await readFile(target.absolute, "utf8");
      originals.set(target.relative, original);
      await atomicWriteDomainFile(draft.worktree_path, target.relative, formatYamlDocument(plan.document, referenceLabels));
      if (referenceLabelForDocument(plan.before) !== referenceLabelForDocument(plan.document)) {
        for (const entry of entries) {
          if (entry.relative === target.relative || !containsEntityReference(entry.document, plan.id)) continue;
          const relatedOriginal = await readFile(entry.absolute, "utf8");
          const relatedFormatted = formatYamlDocument(entry.document, referenceLabels);
          if (relatedFormatted === relatedOriginal) continue;
          originals.set(entry.relative, relatedOriginal);
          await atomicWriteDomainFile(draft.worktree_path, entry.relative, relatedFormatted);
        }
      }
      await this.assertScope(draftId, scope);
      const validation = await validateRepository(draft.worktree_path);
      if (!validation.valid) throw new AgentWorkflowError("VALIDATION_FAILED", "Updated entity makes the repository invalid", validation.errors);
      const metadata = await this.drafts.refreshFingerprint(draftId);
      return { path: plan.path, draft_fingerprint: metadata.fingerprint, document: plan.document };
    } catch (error) {
      for (const [relative, original] of originals) await atomicWriteDomainFile(draft.worktree_path, relative, original);
      await this.drafts.refreshFingerprint(draftId);
      throw error;
    }
  }

  async createEntities(
    draftId: string,
    documents: readonly Readonly<Record<string, unknown>>[],
    requestedType: string | undefined,
    scope: AgentScope = {},
    dryRun = false,
  ): Promise<EntityCreateBatchResult> {
    await this.assertScope(draftId, scope);
    const draft = await this.externalDraft(draftId);
    const existing = await repositoryDocuments(draft.worktree_path);
    const plan = planEntityCreation(documents, existing, requestedType);
    const referenceLabels = referenceLabelsForDocuments([...existing, ...plan.map((item) => item.document)]);
    const written: string[] = [];
    const createdParents = new Set<string>();
    const cleanup = async (): Promise<void> => {
      for (const relative of written.reverse()) await rm(path.join(draft.worktree_path, ...relative.split("/")), { force: true });
      for (const relative of [...createdParents].sort((left, right) => right.length - left.length)) {
        try { await rmdir(path.join(draft.worktree_path, ...relative.split("/"))); }
        catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      }
    };
    try {
      for (const item of plan) {
        const absolute = path.join(draft.worktree_path, ...item.path.split("/"));
        try {
          await lstat(absolute);
          throw new AgentWorkflowError("ENTITY_EXISTS", `${item.path} already exists`);
        } catch (error) {
          if (error instanceof AgentWorkflowError) throw error;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        let parent = path.posix.dirname(item.path);
        while (parent !== "." && !(await pathExists(path.join(draft.worktree_path, ...parent.split("/"))))) {
          createdParents.add(parent);
          parent = path.posix.dirname(parent);
        }
        await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
        await atomicWriteDomainFile(draft.worktree_path, item.path, formatYamlDocument(item.document, referenceLabels));
        written.push(item.path);
      }
      await this.assertScope(draftId, scope);
      const validation = await validateRepository(draft.worktree_path);
      if (!validation.valid) throw new AgentWorkflowError("VALIDATION_FAILED", "Imported entities make the repository invalid", validation.errors);
      if (dryRun) await cleanup();
      const metadata = await this.drafts.refreshFingerprint(draftId);
      return {
        items: plan.map((item) => ({ document: item.document, path: item.path, source_index: item.source_index })),
        draft_fingerprint: metadata.fingerprint,
        dry_run: dryRun,
      };
    } catch (error) {
      await cleanup();
      await this.drafts.refreshFingerprint(draftId);
      if (error instanceof AgentWorkflowError && error.code === "VALIDATION_FAILED" && Array.isArray(error.details)) {
        const sources = new Map(plan.map((item) => [item.path, item.source_index]));
        throw new AgentWorkflowError(error.code, error.message, error.details.map((issue) => {
          if (issue === null || typeof issue !== "object" || !("path" in issue) || typeof issue.path !== "string") return issue;
          const sourceIndex = sources.get(issue.path);
          return sourceIndex === undefined ? issue : { ...issue, source_index: sourceIndex };
        }));
      }
      throw error;
    }
  }

  async listEntities(draftId: string, entityType: string, project?: string): Promise<{ items: readonly { readonly document: GitPmDocument; readonly path: string }[]; readonly draft_fingerprint: string }> {
    const draft = await this.externalDraft(draftId);
    const type = canonicalEntityType(entityType);
    const schema = ENTITY_TYPE_SCHEMAS[type]!;
    const entries = await repositoryEntries(draft.worktree_path);
    const items = entries
      .filter((entry) => entry.document.schema === schema && (project === undefined || entry.document.project === project))
      .map((entry) => ({ document: entry.document, path: entry.relative }))
      .sort((left, right) => String(left.document.id).localeCompare(String(right.document.id)));
    return { items, draft_fingerprint: draft.fingerprint };
  }

  async getEntity(draftId: string, entityType: string, id: string): Promise<{ document: GitPmDocument; path: string; draft_fingerprint: string }> {
    const draft = await this.externalDraft(draftId);
    const type = canonicalEntityType(entityType);
    const schema = ENTITY_TYPE_SCHEMAS[type]!;
    const entries = await repositoryEntries(draft.worktree_path);
    const found = entries.find((entry) => entry.document.schema === schema && entry.document.id === id);
    if (found === undefined) throw new AgentWorkflowError("ENTITY_NOT_FOUND", `${type}/${id} not found`);
    return { document: found.document, path: found.relative, draft_fingerprint: draft.fingerprint };
  }

  async planDelete(draftId: string, entityType: string, id: string): Promise<DeletePlan> {
    const draft = await this.externalDraft(draftId);
    const type = canonicalEntityType(entityType);
    const schema = ENTITY_TYPE_SCHEMAS[type]!;
    const entries = await repositoryEntries(draft.worktree_path);
    const found = entries.find((entry) => entry.document.schema === schema && entry.document.id === id);
    if (found === undefined) throw new AgentWorkflowError("ENTITY_NOT_FOUND", `${type}/${id} not found`);
    const cascadedComments = schema === "gitpm/task@1"
      ? entries.filter((entry) => entry.document.schema === "gitpm/comment@1" && entry.document.task === id)
      : [];
    const commentPaths = new Set(cascadedComments.map((comment) => comment.relative));
    const entitiesByPath = new Map(entries.map((entry) => [entry.relative, entry.document]));
    const restrictions = (await validateDelete(draft.worktree_path, id))
      .filter((issue) => !commentPaths.has(issue.path))
      .map((issue): DeleteRestriction => {
        const document = entitiesByPath.get(issue.path);
        return document === undefined ? { path: issue.path } : {
          path: issue.path,
          entity_id: typeof document.id === "string" ? document.id : undefined,
          schema: document.schema,
          label: entityDisplayLabel(document),
        };
      });
    const supportsUnlink = schema === "gitpm/person@1";
    const wouldUnlink: DeleteRestriction[] = supportsUnlink
      ? entries.flatMap((entry) => {
        if (entry.relative === found.relative) return [];
        const rewritten = unlinkPersonReference(entry.document, id);
        return rewritten === undefined ? [] : [{
          path: entry.relative,
          entity_id: typeof entry.document.id === "string" ? entry.document.id : undefined,
          schema: entry.document.schema,
          label: entityDisplayLabel(entry.document),
        }];
      })
      : [];
    return {
      entityType: type,
      id,
      schema,
      path: found.relative,
      supports_unlink: supportsUnlink,
      cascaded_comments: cascadedComments.map((comment) => ({ path: comment.relative, id: String(comment.document.id) })),
      restrictions,
      would_unlink: wouldUnlink,
    };
  }

  async deleteEntity(draftId: string, entityType: string, id: string, unlinkReferences = false, scope: AgentScope = {}): Promise<{ deleted: true; path: string; unlinked_paths: readonly string[]; draft_fingerprint: string }> {
    await this.assertScope(draftId, scope);
    const draft = await this.externalDraft(draftId);
    const type = canonicalEntityType(entityType);
    const schema = ENTITY_TYPE_SCHEMAS[type]!;
    const entries = await repositoryEntries(draft.worktree_path);
    const found = entries.find((entry) => entry.document.schema === schema && entry.document.id === id);
    if (found === undefined) throw new AgentWorkflowError("ENTITY_NOT_FOUND", `${type}/${id} not found`);
    if (unlinkReferences && schema !== "gitpm/person@1") {
      throw new AgentWorkflowError("DELETE_UNLINK_UNSUPPORTED", "Automatic reference removal is supported only for people");
    }
    const cascadedComments = schema === "gitpm/task@1"
      ? entries.filter((entry) => entry.document.schema === "gitpm/comment@1" && entry.document.task === id)
      : [];
    const commentPaths = new Set(cascadedComments.map((comment) => comment.relative));
    const entitiesByPath = new Map(entries.map((entry) => [entry.relative, entry.document]));
    const restrictions = (await validateDelete(draft.worktree_path, id)).filter((issue) => !commentPaths.has(issue.path));
    if (restrictions.length > 0 && !unlinkReferences) {
      throw new AgentWorkflowError("DELETE_RESTRICTED", `${id} is referenced`, restrictions.map((issue) => {
        const document = entitiesByPath.get(issue.path);
        return document === undefined ? { path: issue.path } : {
          path: issue.path,
          entity_id: typeof document.id === "string" ? document.id : undefined,
          schema: document.schema,
          label: entityDisplayLabel(document),
        };
      }));
    }
    const updates = unlinkReferences
      ? entries.flatMap((entry) => {
        if (entry.relative === found.relative) return [];
        const rewritten = unlinkPersonReference(entry.document, id);
        return rewritten === undefined ? [] : [{ entry, document: rewritten }];
      })
      : [];
    const removed = [found, ...cascadedComments];
    const referenceLabels = referenceLabelsForDocuments(entries.filter((entry) => !removed.includes(entry)).map((entry) => {
      const update = updates.find((item) => item.entry === entry);
      return update === undefined ? entry.document : update.document;
    }));
    const originals = new Map<string, string>();
    try {
      for (const update of updates) {
        originals.set(update.entry.relative, await readFile(update.entry.absolute, "utf8"));
        await atomicWriteDomainFile(draft.worktree_path, update.entry.relative, formatYamlDocument(update.document, referenceLabels));
      }
      for (const entity of removed) {
        originals.set(entity.relative, await readFile(entity.absolute, "utf8"));
        await rm(entity.absolute);
      }
      await this.assertScope(draftId, scope);
      const validation = await validateRepository(draft.worktree_path);
      if (!validation.valid) throw new AgentWorkflowError("VALIDATION_FAILED", "Deleted entity leaves the repository invalid", validation.errors);
    } catch (error) {
      for (const [relative, original] of originals) await atomicWriteDomainFile(draft.worktree_path, relative, original);
      await this.drafts.refreshFingerprint(draftId);
      throw error;
    }
    const metadata = await this.drafts.refreshFingerprint(draftId);
    return { deleted: true, path: found.relative, unlinked_paths: updates.map((update) => update.entry.relative), draft_fingerprint: metadata.fingerprint };
  }

  async archiveEntity(draftId: string, entityType: string, id: string, scope: AgentScope = {}): Promise<{ path: string; draft_fingerprint: string; document: GitPmDocument }> {
    const draft = await this.externalDraft(draftId);
    const entries = await repositoryEntries(draft.worktree_path);
    const plan = planEntityUpdate({ lifecycle: "archived" }, entries.map((entry) => entry.document), entityType, id);
    assertAgentScope({
      affected_projects: projectPath(plan.path) === undefined ? [] : [projectPath(plan.path)!],
      files: [{ path: plan.path, kind: "Modified" }],
    }, scope);
    const target = entries.find((entry) => entry.relative === plan.path)!;
    const referenceLabels = referenceLabelsForDocuments(entries.map((entry) => entry.relative === plan.path ? plan.document : entry.document));
    const original = await readFile(target.absolute, "utf8");
    try {
      await atomicWriteDomainFile(draft.worktree_path, target.relative, formatYamlDocument(plan.document, referenceLabels));
      await this.assertScope(draftId, scope);
      const validation = await validateRepository(draft.worktree_path);
      if (!validation.valid) throw new AgentWorkflowError("VALIDATION_FAILED", "Archived entity makes the repository invalid", validation.errors);
      const metadata = await this.drafts.refreshFingerprint(draftId);
      return { path: plan.path, draft_fingerprint: metadata.fingerprint, document: plan.document };
    } catch (error) {
      await atomicWriteDomainFile(draft.worktree_path, target.relative, original);
      await this.drafts.refreshFingerprint(draftId);
      throw error;
    }
  }

  async moveTask(draftId: string, id: string, targetProject: string, targetMilestone: string | undefined, scope: AgentScope = {}): Promise<{ path: string; draft_fingerprint: string; document: GitPmDocument }> {
    await this.assertScope(draftId, scope);
    const draft = await this.externalDraft(draftId);
    const entries = await repositoryEntries(draft.worktree_path);
    const found = entries.find((entry) => entry.document.schema === "gitpm/task@1" && entry.document.id === id);
    if (found === undefined) throw new AgentWorkflowError("ENTITY_NOT_FOUND", `tasks/${id} not found`);
    if (found.document.project === targetProject) throw new AgentWorkflowError("TASK_ALREADY_IN_PROJECT", `${id} already belongs to ${targetProject}`);
    const movedDocument = { ...found.document, project: targetProject, milestone: targetMilestone } as GitPmDocument;
    const targetRelative = entityPathForDocument(movedDocument);
    const movedComments = entries
      .filter((entry) => entry.document.schema === "gitpm/comment@1" && entry.document.task === id)
      .map((entry) => ({ source: entry, document: { ...entry.document, project: targetProject } as GitPmDocument }));
    const targets = [{ source: found, document: movedDocument }, ...movedComments].map((item) => ({
      ...item,
      relative: entityPathForDocument(item.document),
    }));
    assertAgentScope({
      affected_projects: [...new Set(targets.flatMap((item) => {
        const project = projectPath(item.relative);
        return project === undefined ? [] : [project];
      }))],
      files: targets.map((item) => ({ path: item.relative, kind: "Added" as const })),
    }, scope);
    for (const target of targets) {
      if (await pathExists(path.join(draft.worktree_path, ...target.relative.split("/")))) {
        throw new AgentWorkflowError("ENTITY_EXISTS", `${target.relative} already exists`);
      }
    }
    const referenceLabels = referenceLabelsForDocuments([
      ...entries.filter((entry) => entry.relative !== found.relative && !movedComments.some((item) => item.source === entry)).map((entry) => entry.document),
      movedDocument,
    ]);
    const originals = new Map<string, string>();
    try {
      for (const target of targets) {
        originals.set(target.source.relative, await readFile(target.source.absolute, "utf8"));
        const absolute = path.join(draft.worktree_path, ...target.relative.split("/"));
        await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
        await atomicWriteDomainFile(draft.worktree_path, target.relative, formatYamlDocument(target.document, referenceLabels));
      }
      for (const target of targets) await rm(target.source.absolute);
      await this.assertScope(draftId, scope);
      const validation = await validateRepository(draft.worktree_path);
      if (!validation.valid) throw new AgentWorkflowError("VALIDATION_FAILED", "Moved task makes the repository invalid", validation.errors);
      const metadata = await this.drafts.refreshFingerprint(draftId);
      return { path: targetRelative, draft_fingerprint: metadata.fingerprint, document: movedDocument };
    } catch (error) {
      for (const target of targets) await rm(path.join(draft.worktree_path, ...target.relative.split("/")), { force: true });
      for (const [sourceRelative, original] of originals) {
        const absolute = path.join(draft.worktree_path, ...sourceRelative.split("/"));
        await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
        await atomicWriteDomainFile(draft.worktree_path, sourceRelative, original);
      }
      await this.drafts.refreshFingerprint(draftId);
      throw error;
    }
  }

  async commitAll(draftId: string, message: string, scope: AgentScope = {}) {
    const draft = await this.externalDraft(draftId);
    const scoped = await this.assertScope(draftId, scope);
    const validation = await validateRepository(draft.worktree_path);
    if (!validation.valid) throw new AgentWorkflowError("VALIDATION_FAILED", "Commit is blocked by repository validation", validation.errors);
    if (scoped.changed_files.length === 0) throw new AgentWorkflowError("NOTHING_TO_COMMIT", "Draft has no business changes");
    const commit = await this.git.commitAll(draft.worktree_path, message, this.options.authorName, this.options.authorEmail, GITPM_GUIDANCE_PATHS);
    const metadata = await this.drafts.refreshFingerprint(draftId);
    return { commit, branch: metadata.branch, draft_fingerprint: metadata.fingerprint };
  }

  async push(draftId: string) {
    await this.externalDraft(draftId);
    const changes = await this.changes.list(draftId);
    if (changes.files.some((file) => !GITPM_GUIDANCE_FILES.has(file.path))) throw new AgentWorkflowError("UNCOMMITTED_CHANGES", "Push requires a clean committed draft");
    if (!this.options.accessToken) throw new AgentWorkflowError("AGENT_TOKEN_REQUIRED", "Push requires an in-memory access token");
    const result = await this.drafts.push(draftId, this.options.accessToken);
    return { branch: result.branch, commit: result.commit };
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
    let draft = await this.drafts.getDraft(draftId);
    if (draft.state !== "open") throw new AgentWorkflowError("DRAFT_NOT_OPEN", "Draft is not open");
    if (draft.writer_mode !== "external") throw new AgentWorkflowError("AGENT_EXTERNAL_MODE_REQUIRED", "Agent workflow requires external writer mode");
    if (await provisionGitPmWorktreeGuidance(draft.worktree_path, draft.draft_id)) draft = await this.drafts.refreshFingerprint(draftId);
    return draft;
  }
}
