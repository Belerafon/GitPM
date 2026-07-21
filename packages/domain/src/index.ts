import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { DraftManager, DraftMetadata } from "@gitpm/drafts";
import { formatYamlDocument, parseYamlDocument, referenceLabelForDocument, referenceLabelsForDocuments } from "@gitpm/repository-format";
import type { GitPmDocument } from "@gitpm/repository-format";
import { atomicWriteDomainFile, resolveDomainPath } from "@gitpm/security";
import { ENTITY_ID_PREFIX, isEntityId } from "@gitpm/shared";
import { validateDelete, validateRepository } from "@gitpm/validation";

export * from "./comments.js";

export class DomainOperationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainOperationError";
  }
}

export interface EntityResult {
  readonly document: GitPmDocument;
  readonly path: string;
  readonly blob_id: string;
  readonly draft_fingerprint: string;
}

export interface ProjectWorkspaceResult {
  readonly project: EntityResult;
  readonly milestones: readonly EntityResult[];
  readonly tasks: readonly EntityResult[];
  readonly draft_fingerprint: string;
}

interface IndexedEntity {
  readonly absolute: string;
  readonly relative: string;
  readonly document: GitPmDocument;
}

interface RepositoryIndex {
  readonly fingerprint: string;
  readonly entities: readonly IndexedEntity[];
  readonly bySchemaAndId: ReadonlyMap<string, IndexedEntity>;
}

const typeSchemas: Record<string, string> = {
  projects: "gitpm/project@1",
  tasks: "gitpm/task@1",
  milestones: "gitpm/milestone@1",
  people: "gitpm/person@1",
  teams: "gitpm/team@1",
  calendars: "gitpm/calendar@1",
  views: "gitpm/saved-view@1",
};

const schemaIdPrefixes = {
  "gitpm/project@1": ENTITY_ID_PREFIX.project,
  "gitpm/task@1": ENTITY_ID_PREFIX.task,
  "gitpm/milestone@1": ENTITY_ID_PREFIX.milestone,
  "gitpm/person@1": ENTITY_ID_PREFIX.person,
  "gitpm/team@1": ENTITY_ID_PREFIX.team,
  "gitpm/calendar@1": ENTITY_ID_PREFIX.calendar,
  "gitpm/saved-view@1": ENTITY_ID_PREFIX.view,
  "gitpm/comment@1": ENTITY_ID_PREFIX.comment,
} as const;

export function assertEntityType(entityType: string, document: GitPmDocument): void {
  const schema = typeSchemas[entityType];
  if (!schema || schema !== document.schema) {
    throw new DomainOperationError("ENTITY_TYPE_INVALID", `Entity type ${entityType} does not match ${document.schema}`);
  }
}

export function entityPathForDocument(document: GitPmDocument): string {
  const id = String(document.id ?? "");
  const project = String(document.project ?? "");
  const expectedPrefix = schemaIdPrefixes[document.schema as keyof typeof schemaIdPrefixes];
  if (expectedPrefix === undefined || !isEntityId(id, expectedPrefix)) {
    throw new DomainOperationError("ENTITY_ID_INVALID", "Entity ID is invalid");
  }
  const projectBound = ["gitpm/task@1", "gitpm/milestone@1", "gitpm/saved-view@1"].includes(document.schema);
  if (projectBound && !isEntityId(project, ENTITY_ID_PREFIX.project)) {
    throw new DomainOperationError("ENTITY_PROJECT_INVALID", "Owning Project ID is invalid");
  }
  switch (document.schema) {
    case "gitpm/project@1": return `projects/${id}/project.yaml`;
    case "gitpm/task@1": return `projects/${project}/tasks/${id}.yaml`;
    case "gitpm/milestone@1": return `projects/${project}/milestones/${id}.yaml`;
    case "gitpm/saved-view@1": return `projects/${project}/views/${id}.yaml`;
    case "gitpm/comment@1": {
      const task = String(document.task ?? "");
      if (!isEntityId(task, ENTITY_ID_PREFIX.task)) throw new DomainOperationError("ENTITY_ID_INVALID", "Comment task ID is invalid");
      return `projects/${project}/comments/${task}/${id}.yaml`;
    }
    case "gitpm/person@1": return `people/${id}.yaml`;
    case "gitpm/team@1": return `teams/${id}.yaml`;
    case "gitpm/calendar@1": return `calendars/${id}.yaml`;
    default: throw new DomainOperationError("ENTITY_TYPE_INVALID", `Unsupported entity schema ${document.schema}`);
  }
}

async function yamlFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await yamlFiles(absolute));
    else if (entry.name.endsWith(".yaml")) result.push(absolute);
  }
  return result.sort();
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function containsReference(value: unknown, id: string): boolean {
  if (value === id) return true;
  if (Array.isArray(value)) return value.some((item) => containsReference(item, id));
  if (value !== null && typeof value === "object") return Object.values(value).some((item) => containsReference(item, id));
  return false;
}

export class EntityStore {
  private readonly indexes = new Map<string, RepositoryIndex>();
  private readonly pendingIndexes = new Map<string, { readonly fingerprint: string; readonly promise: Promise<RepositoryIndex> }>();
  private readonly pendingFingerprints = new Map<string, { readonly baseline: string; readonly promise: Promise<string> }>();

  constructor(private readonly drafts: DraftManager) {}

  private async contentFingerprint(draftId: string, metadata: DraftMetadata): Promise<string> {
    const pending = this.pendingFingerprints.get(draftId);
    if (pending?.baseline === metadata.fingerprint) return await pending.promise;
    const promise = this.drafts.poll(draftId).then((result) => result.currentFingerprint);
    this.pendingFingerprints.set(draftId, { baseline: metadata.fingerprint, promise });
    try { return await promise; }
    finally {
      if (this.pendingFingerprints.get(draftId)?.promise === promise) this.pendingFingerprints.delete(draftId);
    }
  }

  private async index(draftId: string, metadata: DraftMetadata): Promise<RepositoryIndex> {
    const fingerprint = await this.contentFingerprint(draftId, metadata);
    const cached = this.indexes.get(draftId);
    if (cached?.fingerprint === fingerprint) return cached;
    const pending = this.pendingIndexes.get(draftId);
    if (pending?.fingerprint === fingerprint) return await pending.promise;
    const promise = (async () => {
      const entities = await Promise.all((await yamlFiles(metadata.worktree_path)).map(async (absolute): Promise<IndexedEntity> => {
        const relative = path.relative(metadata.worktree_path, absolute).split(path.sep).join("/");
        return { absolute, relative, document: parseYamlDocument(await readFile(absolute, "utf8"), relative) };
      }));
      const next: RepositoryIndex = {
        fingerprint,
        entities,
        bySchemaAndId: new Map(entities
          .filter((entity) => typeof entity.document.id === "string")
          .map((entity) => [`${entity.document.schema}:${String(entity.document.id)}`, entity])),
      };
      this.indexes.set(draftId, next);
      return next;
    })();
    this.pendingIndexes.set(draftId, { fingerprint, promise });
    try { return await promise; }
    finally {
      if (this.pendingIndexes.get(draftId)?.promise === promise) this.pendingIndexes.delete(draftId);
    }
  }

  private async result(draftId: string, metadata: DraftMetadata, entity: IndexedEntity): Promise<EntityResult> {
    return (await this.results(draftId, metadata, [entity]))[0]!;
  }

  private async results(draftId: string, metadata: DraftMetadata, entities: readonly IndexedEntity[]): Promise<readonly EntityResult[]> {
    const blobIds = await this.drafts.fileBlobIds(draftId, entities.map((entity) => entity.relative));
    return entities.map((entity) => ({
      document: entity.document,
      path: entity.relative,
      blob_id: blobIds.get(entity.relative)!,
      draft_fingerprint: metadata.fingerprint,
    }));
  }

  private labels(repository: RepositoryIndex, replacement?: GitPmDocument) {
    return referenceLabelsForDocuments([
      ...repository.entities
        .filter((entity) => replacement === undefined || entity.document.id !== replacement.id)
        .map((entity) => entity.document),
      ...(replacement === undefined ? [] : [replacement]),
    ]);
  }

  async list(draftId: string, entityType: string, project?: string): Promise<readonly EntityResult[]> {
    const metadata = await this.drafts.getDraft(draftId);
    const schema = typeSchemas[entityType];
    if (!schema) throw new DomainOperationError("ENTITY_TYPE_INVALID", `Unknown entity type ${entityType}`);
    const matching = (await this.index(draftId, metadata)).entities
      .filter((entity) => entity.document.schema === schema && (project === undefined || entity.document.project === project));
    const result = await this.results(draftId, metadata, matching);
    return [...result].sort((left, right) => String(left.document.id).localeCompare(String(right.document.id)));
  }

  private async find(draftId: string, metadata: DraftMetadata, entityType: string, id: string): Promise<IndexedEntity> {
    const schema = typeSchemas[entityType];
    if (!schema) throw new DomainOperationError("ENTITY_TYPE_INVALID", `Unknown entity type ${entityType}`);
    const found = (await this.index(draftId, metadata)).bySchemaAndId.get(`${schema}:${id}`);
    if (found !== undefined) return found;
    throw new DomainOperationError("ENTITY_NOT_FOUND", `${entityType}/${id} not found`);
  }

  async get(draftId: string, entityType: string, id: string): Promise<EntityResult> {
    const metadata = await this.drafts.getDraft(draftId);
    const found = await this.find(draftId, metadata, entityType, id);
    return await this.result(draftId, metadata, found);
  }

  async projectWorkspace(draftId: string, projectId: string): Promise<ProjectWorkspaceResult> {
    const metadata = await this.drafts.getDraft(draftId);
    const repository = await this.index(draftId, metadata);
    const indexedProject = repository.bySchemaAndId.get(`gitpm/project@1:${projectId}`);
    if (indexedProject === undefined) throw new DomainOperationError("ENTITY_NOT_FOUND", `projects/${projectId} not found`);
    const indexedMilestones = repository.entities.filter((entity) => entity.document.schema === "gitpm/milestone@1" && entity.document.project === projectId);
    const indexedTasks = repository.entities.filter((entity) => entity.document.schema === "gitpm/task@1" && entity.document.project === projectId);
    const results = await this.results(draftId, metadata, [indexedProject, ...indexedMilestones, ...indexedTasks]);
    const project = results[0]!;
    const milestones = results.slice(1, 1 + indexedMilestones.length);
    const tasks = results.slice(1 + indexedMilestones.length);
    return { project, milestones, tasks, draft_fingerprint: project.draft_fingerprint };
  }

  async getConfiguration(draftId: string, kind: "statuses" | "issue-types"): Promise<EntityResult> {
    const metadata = await this.drafts.getDraft(draftId);
    const relative = kind === "statuses" ? ".gitpm/statuses.yaml" : ".gitpm/issue-types.yaml";
    const absolute = await resolveDomainPath(metadata.worktree_path, relative);
    const document = parseYamlDocument(await readFile(absolute, "utf8"), relative);
    return {
      document,
      path: relative,
      blob_id: await this.drafts.fileBlobId(draftId, relative),
      draft_fingerprint: metadata.fingerprint,
    };
  }

  async updateConfiguration(
    draftId: string,
    owner: string,
    kind: "statuses" | "issue-types",
    expectedFingerprint: string,
    expectedBlobId: string,
    document: GitPmDocument,
  ): Promise<EntityResult> {
    const relative = kind === "statuses" ? ".gitpm/statuses.yaml" : ".gitpm/issue-types.yaml";
    const expectedSchema = kind === "statuses" ? "gitpm/statuses@1" : "gitpm/issue-types@1";
    if (document.schema !== expectedSchema) throw new DomainOperationError("ENTITY_IDENTITY_IMMUTABLE", "Configuration schema is immutable");
    const mutation = await this.drafts.withUiMutation(draftId, owner, expectedFingerprint, async (metadata) => {
      const referenceLabels = this.labels(await this.index(draftId, metadata));
      await this.drafts.assertFileBlobId(draftId, relative, expectedBlobId);
      const absolute = await resolveDomainPath(metadata.worktree_path, relative);
      const original = await readFile(absolute, "utf8");
      await atomicWriteDomainFile(metadata.worktree_path, relative, formatYamlDocument(document, referenceLabels));
      try {
        await this.assertRepositoryValid(metadata.worktree_path);
      } catch (error) {
        await atomicWriteDomainFile(metadata.worktree_path, relative, original);
        throw error;
      }
      return relative;
    });
    return await this.getWithFingerprint(draftId, document, relative, mutation.metadata.fingerprint);
  }

  async create(draftId: string, owner: string, expectedFingerprint: string, document: GitPmDocument): Promise<EntityResult> {
    const relative = entityPathForDocument(document);
    const mutation = await this.drafts.withUiMutation(draftId, owner, expectedFingerprint, async (metadata) => {
      const referenceLabels = this.labels(await this.index(draftId, metadata), document);
      const absolute = path.join(metadata.worktree_path, ...relative.split("/"));
      if (await exists(absolute)) throw new DomainOperationError("ENTITY_EXISTS", `${relative} already exists`);
      await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
      await resolveDomainPath(metadata.worktree_path, relative);
      await atomicWriteDomainFile(metadata.worktree_path, relative, formatYamlDocument(document, referenceLabels));
      try {
        await this.assertRepositoryValid(metadata.worktree_path);
      } catch (error) {
        await rm(absolute, { force: true });
        throw error;
      }
      return relative;
    });
    return await this.getWithFingerprint(draftId, document, relative, mutation.metadata.fingerprint);
  }

  async update(
    draftId: string,
    owner: string,
    entityType: string,
    id: string,
    expectedFingerprint: string,
    expectedBlobId: string,
    document: GitPmDocument,
  ): Promise<EntityResult> {
    const mutation = await this.drafts.withUiMutation(draftId, owner, expectedFingerprint, async (metadata) => {
      const found = await this.find(draftId, metadata, entityType, id);
      if (document.id !== id || document.schema !== found.document.schema || entityPathForDocument(document) !== found.relative) {
        throw new DomainOperationError("ENTITY_IDENTITY_IMMUTABLE", "Entity ID, schema and owning project are immutable");
      }
      await this.drafts.assertFileBlobId(draftId, found.relative, expectedBlobId);
      const repository = await this.index(draftId, metadata);
      const referenceLabels = this.labels(repository, document);
      const originals = new Map<string, string>();
      try {
        const original = await readFile(found.absolute, "utf8");
        originals.set(found.relative, original);
        await atomicWriteDomainFile(metadata.worktree_path, found.relative, formatYamlDocument(document, referenceLabels));
        if (referenceLabelForDocument(found.document) !== referenceLabelForDocument(document)) {
          for (const entity of repository.entities) {
            if (entity.relative === found.relative || !containsReference(entity.document, id)) continue;
            const relatedOriginal = await readFile(entity.absolute, "utf8");
            const relatedFormatted = formatYamlDocument(entity.document, referenceLabels);
            if (relatedFormatted === relatedOriginal) continue;
            originals.set(entity.relative, relatedOriginal);
            await atomicWriteDomainFile(metadata.worktree_path, entity.relative, relatedFormatted);
          }
        }
        await this.assertRepositoryValid(metadata.worktree_path);
      } catch (error) {
        for (const [relative, original] of originals) await atomicWriteDomainFile(metadata.worktree_path, relative, original);
        throw error;
      }
      return found.relative;
    });
    return await this.getWithFingerprint(draftId, document, mutation.result, mutation.metadata.fingerprint);
  }

  async archive(
    draftId: string,
    owner: string,
    entityType: string,
    id: string,
    expectedFingerprint: string,
    expectedBlobId: string,
  ): Promise<EntityResult> {
    const current = await this.get(draftId, entityType, id);
    return await this.update(draftId, owner, entityType, id, expectedFingerprint, expectedBlobId, {
      ...current.document,
      lifecycle: "archived",
    });
  }

  async moveTask(
    draftId: string,
    owner: string,
    id: string,
    expectedFingerprint: string,
    expectedBlobId: string,
    targetProject: string,
    targetMilestone?: string,
  ): Promise<EntityResult> {
    if (!isEntityId(targetProject, ENTITY_ID_PREFIX.project)) throw new DomainOperationError("ENTITY_PROJECT_INVALID", "Target Project ID is invalid");
    if (targetMilestone !== undefined && !isEntityId(targetMilestone, ENTITY_ID_PREFIX.milestone)) throw new DomainOperationError("ENTITY_ID_INVALID", "Target Milestone ID is invalid");
    let movedDocument: GitPmDocument | undefined;
    const mutation = await this.drafts.withUiMutation(draftId, owner, expectedFingerprint, async (metadata) => {
      const found = await this.find(draftId, metadata, "tasks", id);
      await this.drafts.assertFileBlobId(draftId, found.relative, expectedBlobId);
      if (found.document.project === targetProject) throw new DomainOperationError("TASK_ALREADY_IN_PROJECT", `${id} already belongs to ${targetProject}`);
      movedDocument = { ...found.document, project: targetProject, milestone: targetMilestone };
      const targetRelative = entityPathForDocument(movedDocument);
      const targetAbsolute = path.join(metadata.worktree_path, ...targetRelative.split("/"));
      if (await exists(targetAbsolute)) throw new DomainOperationError("ENTITY_EXISTS", `${targetRelative} already exists`);
      const repository = await this.index(draftId, metadata);
      const comments = repository.entities.filter((entity) => entity.document.schema === "gitpm/comment@1" && entity.document.task === id);
      const movedComments = comments.map((comment) => ({ source: comment, document: { ...comment.document, project: targetProject } as GitPmDocument }));
      const targets = [
        { source: found, document: movedDocument },
        ...movedComments,
      ].map((item) => ({ ...item, relative: entityPathForDocument(item.document) }));
      for (const target of targets) if (await exists(path.join(metadata.worktree_path, ...target.relative.split("/")))) throw new DomainOperationError("ENTITY_EXISTS", `${target.relative} already exists`);
      const originals = new Map<string, string>();
      const referenceLabels = this.labels(repository, movedDocument);
      try {
        for (const target of targets) {
          originals.set(target.source.relative, await readFile(target.source.absolute, "utf8"));
          const absolute = path.join(metadata.worktree_path, ...target.relative.split("/"));
          await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
          await resolveDomainPath(metadata.worktree_path, target.relative);
          await atomicWriteDomainFile(metadata.worktree_path, target.relative, formatYamlDocument(target.document, referenceLabels));
        }
        for (const target of targets) await rm(target.source.absolute);
        await this.assertRepositoryValid(metadata.worktree_path);
      } catch (error) {
        for (const target of targets) await rm(path.join(metadata.worktree_path, ...target.relative.split("/")), { force: true });
        for (const [sourceRelative, original] of originals) {
          const absolute = path.join(metadata.worktree_path, ...sourceRelative.split("/"));
          await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
          await atomicWriteDomainFile(metadata.worktree_path, sourceRelative, original);
        }
        throw error;
      }
      return targetRelative;
    });
    if (movedDocument === undefined) throw new DomainOperationError("ENTITY_NOT_FOUND", `tasks/${id} not found`);
    return await this.getWithFingerprint(draftId, movedDocument, mutation.result, mutation.metadata.fingerprint);
  }

  async delete(
    draftId: string,
    owner: string,
    entityType: string,
    id: string,
    expectedFingerprint: string,
    expectedBlobId: string,
  ): Promise<{ deleted: true; path: string; draft_fingerprint: string }> {
    const mutation = await this.drafts.withUiMutation(draftId, owner, expectedFingerprint, async (metadata) => {
      const found = await this.find(draftId, metadata, entityType, id);
      await this.drafts.assertFileBlobId(draftId, found.relative, expectedBlobId);
      const repository = await this.index(draftId, metadata);
      const cascadedComments = found.document.schema === "gitpm/task@1"
        ? repository.entities.filter((entity) => entity.document.schema === "gitpm/comment@1" && entity.document.task === id)
        : [];
      const commentPaths = new Set(cascadedComments.map((comment) => comment.relative));
      const restrictions = (await validateDelete(metadata.worktree_path, id)).filter((restriction) => !commentPaths.has(restriction.path));
      if (restrictions.length > 0) throw new DomainOperationError("DELETE_RESTRICTED", `${id} is referenced`, restrictions);
      const removed = [found, ...cascadedComments];
      const originals = new Map<string, string>();
      for (const entity of removed) { originals.set(entity.relative, await readFile(entity.absolute, "utf8")); await rm(entity.absolute); }
      try {
        await this.assertRepositoryValid(metadata.worktree_path);
      } catch (error) {
        for (const [relative, original] of originals) {
          const absolute = path.join(metadata.worktree_path, ...relative.split("/"));
          await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
          await atomicWriteDomainFile(metadata.worktree_path, relative, original);
        }
        throw error;
      }
      return found.relative;
    });
    return { deleted: true, path: mutation.result, draft_fingerprint: mutation.metadata.fingerprint };
  }

  private async getWithFingerprint(draftId: string, document: GitPmDocument, relative: string, fingerprint: string): Promise<EntityResult> {
    return {
      document,
      path: relative,
      blob_id: await this.drafts.fileBlobId(draftId, relative),
      draft_fingerprint: fingerprint,
    };
  }

  private async assertRepositoryValid(worktree: string): Promise<void> {
    const report = await validateRepository(worktree);
    if (!report.valid) throw new DomainOperationError("VALIDATION_FAILED", report.errors[0]?.message ?? "Repository validation failed", report.errors);
  }
}
