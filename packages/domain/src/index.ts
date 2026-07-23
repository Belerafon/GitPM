import { lstat, mkdir, readFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type { DraftManager, RepositoryMutationMode, RepositoryWorkspace } from "@gitpm/drafts";
import { formatYamlDocument, parseYamlDocument, referenceLabelForDocument, referenceLabelsForDocuments } from "@gitpm/repository-format";
import type { GitPmDocument } from "@gitpm/repository-format";
import { atomicWriteDomainFile, resolveDomainPath } from "@gitpm/security";
import { ENTITY_ID_PREFIX, isEntityId, newUniqueEntityId, type EntityIdPrefix } from "@gitpm/shared";
import { discoverRepositoryFiles, validateDelete, validateRepository } from "@gitpm/validation";

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

export interface EntityCreateBatchResult {
  readonly items: readonly { readonly document: GitPmDocument; readonly path: string; readonly source_index: number }[];
  readonly draft_fingerprint: string;
  readonly dry_run: boolean;
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

export const ENTITY_TYPE_SCHEMAS: Readonly<Record<string, string>> = {
  projects: "gitpm/project@1",
  tasks: "gitpm/task@1",
  milestones: "gitpm/milestone@1",
  people: "gitpm/person@1",
  teams: "gitpm/team@1",
  calendars: "gitpm/calendar@1",
  views: "gitpm/saved-view@1",
};

const entityTypeAliases: Readonly<Record<string, string>> = {
  project: "projects",
  task: "tasks",
  milestone: "milestones",
  person: "people",
  team: "teams",
  calendar: "calendars",
  view: "views",
  "saved-view": "views",
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

export interface EntityCreatePlanItem {
  readonly document: GitPmDocument;
  readonly path: string;
  readonly source_index: number;
}

export interface EntityUpdatePlan {
  readonly entityType: string;
  readonly id: string;
  readonly before: GitPmDocument;
  readonly document: GitPmDocument;
  readonly path: string;
}

export interface DeleteRestriction {
  readonly path: string;
  readonly entity_id?: string;
  readonly schema?: string;
  readonly label?: string;
}

export interface DeletePlan {
  readonly entityType: string;
  readonly id: string;
  readonly schema: string;
  readonly path: string;
  readonly supports_unlink: boolean;
  readonly cascaded_comments: readonly { readonly path: string; readonly id: string }[];
  readonly restrictions: readonly DeleteRestriction[];
  readonly would_unlink: readonly DeleteRestriction[];
}

export function canonicalEntityType(value: string): string {
  const normalized = entityTypeAliases[value] ?? value;
  if (ENTITY_TYPE_SCHEMAS[normalized] === undefined) {
    throw new DomainOperationError("ENTITY_TYPE_INVALID", `Unknown entity type ${value}`);
  }
  return normalized;
}

function entityTypeForInputs(inputs: readonly Readonly<Record<string, unknown>>[], requestedType?: string): string {
  if (requestedType !== undefined) return canonicalEntityType(requestedType);
  const schemas = new Set(inputs.map((input) => input.schema).filter((schema): schema is string => typeof schema === "string"));
  if (schemas.size !== 1) {
    throw new DomainOperationError("ENTITY_TYPE_REQUIRED", "--type is required when input schema is absent or mixed");
  }
  const schema = [...schemas][0]!;
  const found = Object.entries(ENTITY_TYPE_SCHEMAS).find(([, candidate]) => candidate === schema)?.[0];
  if (found === undefined) throw new DomainOperationError("ENTITY_TYPE_INVALID", `Unsupported entity schema ${schema}`);
  return found;
}

export function planEntityCreation(
  inputs: readonly Readonly<Record<string, unknown>>[],
  existingDocuments: readonly GitPmDocument[],
  requestedType?: string,
): readonly EntityCreatePlanItem[] {
  if (inputs.length === 0) throw new DomainOperationError("IMPORT_EMPTY", "Entity input is empty");
  const entityType = entityTypeForInputs(inputs, requestedType);
  const schema = ENTITY_TYPE_SCHEMAS[entityType]!;
  const prefix = schemaIdPrefixes[schema as keyof typeof schemaIdPrefixes] as EntityIdPrefix | undefined;
  if (prefix === undefined) throw new DomainOperationError("ENTITY_TYPE_INVALID", `Unsupported entity schema ${schema}`);
  const reservedIds = new Set(existingDocuments.flatMap((document) => typeof document.id === "string" ? [document.id] : []));
  const repository = existingDocuments.find((document) => document.schema === "gitpm/repository@1");
  const defaultCalendar = typeof repository?.default_calendar === "string" ? repository.default_calendar : undefined;
  const calendars = new Map(existingDocuments
    .filter((document) => document.schema === "gitpm/calendar@1" && typeof document.id === "string")
    .map((document) => [String(document.id), document]));

  return inputs.map((input, sourceIndex) => {
    if (input.schema !== undefined && input.schema !== schema) {
      throw new DomainOperationError("ENTITY_TYPE_INVALID", `Input ${sourceIndex + 1} schema ${String(input.schema)} does not match ${schema}`, { source_index: sourceIndex });
    }
    let id: string;
    if (input.id === undefined) {
      id = newUniqueEntityId(prefix, reservedIds);
    } else if (typeof input.id !== "string" || !isEntityId(input.id, prefix)) {
      throw new DomainOperationError("ENTITY_ID_INVALID", `Input ${sourceIndex + 1} entity ID is invalid`, { source_index: sourceIndex, expected_prefix: prefix });
    } else {
      id = input.id;
    }
    if (reservedIds.has(id)) {
      throw new DomainOperationError("ENTITY_EXISTS", `Input ${sourceIndex + 1} entity ID ${id} already exists`, { source_index: sourceIndex, id });
    }
    reservedIds.add(id);

    const lifecycle = input.lifecycle ?? "active";
    let calendar = input.calendar;
    if (schema === "gitpm/person@1" && calendar === undefined) {
      if (defaultCalendar === undefined) {
        throw new DomainOperationError("DEFAULT_CALENDAR_UNAVAILABLE", "Person input omits calendar but repository default_calendar is unavailable", { source_index: sourceIndex });
      }
      calendar = defaultCalendar;
    }
    if (schema === "gitpm/person@1" && lifecycle === "active" && typeof calendar === "string" && calendars.get(calendar)?.lifecycle !== "active") {
      throw new DomainOperationError("ENTITY_CALENDAR_INACTIVE", `Person input ${sourceIndex + 1} requires an active Calendar`, { source_index: sourceIndex, calendar });
    }
    const email = typeof input.email === "string" ? input.email.trim() : input.email;
    const document = {
      ...input,
      schema,
      id,
      lifecycle,
      ...(calendar === undefined ? {} : { calendar }),
      ...(email === undefined ? {} : { email }),
    } as GitPmDocument;
    return { document, path: entityPathForDocument(document), source_index: sourceIndex };
  });
}

export function planEntityUpdate(
  patch: Readonly<Record<string, unknown>>,
  existingDocuments: readonly GitPmDocument[],
  requestedType: string,
  requestedId: string,
): EntityUpdatePlan {
  const entityType = canonicalEntityType(requestedType);
  const schema = ENTITY_TYPE_SCHEMAS[entityType]!;
  const prefix = schemaIdPrefixes[schema as keyof typeof schemaIdPrefixes];
  if (prefix === undefined || !isEntityId(requestedId, prefix)) {
    throw new DomainOperationError("ENTITY_ID_INVALID", `Entity ID ${requestedId} is invalid for ${entityType}`);
  }
  const before = existingDocuments.find((document) => document.schema === schema && document.id === requestedId);
  if (before === undefined) throw new DomainOperationError("ENTITY_NOT_FOUND", `${entityType}/${requestedId} not found`);
  if ((patch.schema !== undefined && patch.schema !== schema) || (patch.id !== undefined && patch.id !== requestedId)) {
    throw new DomainOperationError("ENTITY_IDENTITY_IMMUTABLE", "Entity ID and schema are immutable");
  }
  if (typeof before.project === "string" && patch.project !== undefined && patch.project !== before.project) {
    throw new DomainOperationError("ENTITY_IDENTITY_IMMUTABLE", "Entity ID, schema and owning project are immutable");
  }
  const next: Record<string, unknown> = { ...before };
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) delete next[field];
    else next[field] = value;
  }
  next.schema = schema;
  next.id = requestedId;
  const document = next as GitPmDocument;
  const path = entityPathForDocument(before);
  if (entityPathForDocument(document) !== path) {
    throw new DomainOperationError("ENTITY_IDENTITY_IMMUTABLE", "Entity ID, schema and owning project are immutable");
  }
  return { entityType, id: requestedId, before, document, path };
}

export function assertEntityType(entityType: string, document: GitPmDocument): void {
  const schema = ENTITY_TYPE_SCHEMAS[entityType];
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

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function containsEntityReference(value: unknown, id: string): boolean {
  if (value === id) return true;
  if (Array.isArray(value)) return value.some((item) => containsEntityReference(item, id));
  if (value !== null && typeof value === "object") return Object.values(value).some((item) => containsEntityReference(item, id));
  return false;
}

export function entityDisplayLabel(document: GitPmDocument): string | undefined {
  if (typeof document.name === "string" && document.name.trim() !== "") return document.name;
  if (typeof document.title === "string" && document.title.trim() !== "") return document.title;
  if (typeof document.id === "string") return document.id;
  return undefined;
}

export function unlinkPersonReference(document: GitPmDocument, personId: string): GitPmDocument | undefined {
  if (document.schema === "gitpm/project@1" && document.owner === personId) {
    const project: Record<string, unknown> = { ...document };
    delete project.owner;
    return project as GitPmDocument;
  }
  if (document.schema === "gitpm/team@1" && Array.isArray(document.members) && document.members.includes(personId)) {
    return { ...document, members: document.members.filter((member) => member !== personId) };
  }
  if (document.schema === "gitpm/task@1" && Array.isArray(document.assignees) && document.assignees.includes(personId)) {
    return { ...document, assignees: document.assignees.filter((assignee) => assignee !== personId) };
  }
  if (document.schema === "gitpm/saved-view@1" && document.filters !== null && typeof document.filters === "object") {
    const filters = document.filters as Record<string, unknown>;
    if (Array.isArray(filters.assignees) && filters.assignees.includes(personId)) {
      return { ...document, filters: { ...filters, assignees: filters.assignees.filter((assignee) => assignee !== personId) } };
    }
  }
  if (document.schema === "gitpm/comment@1" && Array.isArray(document.mentions)) {
    const mentions = document.mentions as Array<Record<string, unknown>>;
    if (mentions.some((mention) => mention.person === personId)) {
      const mentionPattern = new RegExp(`@\\[([^\\]\\r\\n]{1,200})\\]\\(person:${personId}\\)`, "gu");
      return {
        ...document,
        ...(typeof document.body_markdown === "string" ? { body_markdown: document.body_markdown.replace(mentionPattern, "@$1") } : {}),
        mentions: mentions.filter((mention) => mention.person !== personId),
      };
    }
  }
  return undefined;
}

export class EntityStore {
  private readonly indexes = new Map<string, RepositoryIndex>();
  private readonly pendingIndexes = new Map<string, { readonly fingerprint: string; readonly promise: Promise<RepositoryIndex> }>();
  private readonly pendingFingerprints = new Map<string, { readonly baseline: string; readonly promise: Promise<string> }>();

  constructor(
    private readonly drafts: DraftManager,
    private readonly mutationMode: RepositoryMutationMode = "ui",
  ) {}

  private async contentFingerprint(draftId: string, metadata: RepositoryWorkspace): Promise<string> {
    const pending = this.pendingFingerprints.get(draftId);
    if (pending?.baseline === metadata.fingerprint) return await pending.promise;
    const promise = this.drafts.poll(draftId).then((result) => result.currentFingerprint);
    this.pendingFingerprints.set(draftId, { baseline: metadata.fingerprint, promise });
    try { return await promise; }
    finally {
      if (this.pendingFingerprints.get(draftId)?.promise === promise) this.pendingFingerprints.delete(draftId);
    }
  }

  private async index(draftId: string, metadata: RepositoryWorkspace): Promise<RepositoryIndex> {
    const fingerprint = await this.contentFingerprint(draftId, metadata);
    const cached = this.indexes.get(draftId);
    if (cached?.fingerprint === fingerprint) return cached;
    const pending = this.pendingIndexes.get(draftId);
    if (pending?.fingerprint === fingerprint) return await pending.promise;
    const promise = (async () => {
      const discovery = await discoverRepositoryFiles(metadata.worktree_path);
      if (discovery.issues.length > 0) {
        const issue = discovery.issues[0]!;
        throw new DomainOperationError(issue.code, issue.message, discovery.issues);
      }
      const entities = await Promise.all(discovery.files.map(async (absolute): Promise<IndexedEntity> => {
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

  private async result(draftId: string, metadata: RepositoryWorkspace, entity: IndexedEntity): Promise<EntityResult> {
    return (await this.results(draftId, metadata, [entity]))[0]!;
  }

  private async results(draftId: string, metadata: RepositoryWorkspace, entities: readonly IndexedEntity[]): Promise<readonly EntityResult[]> {
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

  async planCreate(
    draftId: string,
    inputs: readonly Readonly<Record<string, unknown>>[],
    requestedType?: string,
  ): Promise<readonly EntityCreatePlanItem[]> {
    const metadata = await this.drafts.getWorkspace(draftId);
    const repository = await this.index(draftId, metadata);
    return planEntityCreation(inputs, repository.entities.map((entity) => entity.document), requestedType);
  }

  async planUpdate(
    draftId: string,
    patch: Readonly<Record<string, unknown>>,
    requestedType: string,
    requestedId: string,
  ): Promise<EntityUpdatePlan> {
    const metadata = await this.drafts.getWorkspace(draftId);
    const repository = await this.index(draftId, metadata);
    return planEntityUpdate(patch, repository.entities.map((entity) => entity.document), requestedType, requestedId);
  }

  async list(draftId: string, entityType: string, project?: string): Promise<readonly EntityResult[]> {
    const metadata = await this.drafts.getWorkspace(draftId);
    const schema = ENTITY_TYPE_SCHEMAS[canonicalEntityType(entityType)];
    if (!schema) throw new DomainOperationError("ENTITY_TYPE_INVALID", `Unknown entity type ${entityType}`);
    const matching = (await this.index(draftId, metadata)).entities
      .filter((entity) => entity.document.schema === schema && (project === undefined || entity.document.project === project));
    const result = await this.results(draftId, metadata, matching);
    return [...result].sort((left, right) => String(left.document.id).localeCompare(String(right.document.id)));
  }

  private async find(draftId: string, metadata: RepositoryWorkspace, entityType: string, id: string): Promise<IndexedEntity> {
    const schema = ENTITY_TYPE_SCHEMAS[canonicalEntityType(entityType)];
    if (!schema) throw new DomainOperationError("ENTITY_TYPE_INVALID", `Unknown entity type ${entityType}`);
    const found = (await this.index(draftId, metadata)).bySchemaAndId.get(`${schema}:${id}`);
    if (found !== undefined) return found;
    throw new DomainOperationError("ENTITY_NOT_FOUND", `${entityType}/${id} not found`);
  }

  async get(draftId: string, entityType: string, id: string): Promise<EntityResult> {
    const metadata = await this.drafts.getWorkspace(draftId);
    const found = await this.find(draftId, metadata, entityType, id);
    return await this.result(draftId, metadata, found);
  }

  async projectWorkspace(draftId: string, projectId: string): Promise<ProjectWorkspaceResult> {
    const metadata = await this.drafts.getWorkspace(draftId);
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
    const metadata = await this.drafts.getWorkspace(draftId);
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
    const mutation = await this.drafts.withRepositoryMutation(draftId, owner, expectedFingerprint, this.mutationMode, async (metadata) => {
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

  async create(
    draftId: string,
    owner: string,
    expectedFingerprint: string,
    input: Readonly<Record<string, unknown>>,
    requestedType?: string,
  ): Promise<EntityResult> {
    const document = requestedType === undefined && typeof input.schema === "string" && typeof input.id === "string"
      ? input as GitPmDocument
      : (await this.planCreate(draftId, [input], requestedType))[0]!.document;
    const relative = entityPathForDocument(document);
    const mutation = await this.drafts.withRepositoryMutation(draftId, owner, expectedFingerprint, this.mutationMode, async (metadata) => {
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

  async createMany(
    draftId: string,
    owner: string,
    expectedFingerprint: string,
    plan: readonly EntityCreatePlanItem[],
    dryRun = false,
  ): Promise<EntityCreateBatchResult> {
    if (plan.length === 0) throw new DomainOperationError("IMPORT_EMPTY", "Entity input is empty");
    const paths = new Set<string>();
    for (const item of plan) {
      const expected = entityPathForDocument(item.document);
      if (expected !== item.path) throw new DomainOperationError("PATH_ENTITY_FILENAME", `Expected ${expected}`);
      if (paths.has(item.path)) throw new DomainOperationError("ENTITY_EXISTS", `Duplicate batch path ${item.path}`);
      paths.add(item.path);
    }
    const mutation = await this.drafts.withRepositoryMutation(draftId, owner, expectedFingerprint, this.mutationMode, async (metadata) => {
      const repository = await this.index(draftId, metadata);
      const referenceLabels = referenceLabelsForDocuments([
        ...repository.entities.map((entity) => entity.document),
        ...plan.map((item) => item.document),
      ]);
      const written: string[] = [];
      const createdParents = new Set<string>();
      const cleanup = async (): Promise<void> => {
        for (const relative of written.reverse()) await rm(path.join(metadata.worktree_path, ...relative.split("/")), { force: true });
        for (const relative of [...createdParents].sort((left, right) => right.length - left.length)) {
          try { await rmdir(path.join(metadata.worktree_path, ...relative.split("/"))); }
          catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        }
      };
      try {
        for (const item of plan) {
          const absolute = path.join(metadata.worktree_path, ...item.path.split("/"));
          if (await exists(absolute)) throw new DomainOperationError("ENTITY_EXISTS", `${item.path} already exists`);
          let parent = path.posix.dirname(item.path);
          while (parent !== "." && !(await exists(path.join(metadata.worktree_path, ...parent.split("/"))))) {
            createdParents.add(parent);
            parent = path.posix.dirname(parent);
          }
          await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
          await resolveDomainPath(metadata.worktree_path, item.path);
          await atomicWriteDomainFile(metadata.worktree_path, item.path, formatYamlDocument(item.document, referenceLabels));
          written.push(item.path);
        }
        await this.assertRepositoryValid(metadata.worktree_path);
        if (dryRun) await cleanup();
      } catch (error) {
        await cleanup();
        if (error instanceof DomainOperationError && error.code === "VALIDATION_FAILED" && Array.isArray(error.details)) {
          const sources = new Map(plan.map((item) => [item.path, item.source_index]));
          throw new DomainOperationError(error.code, error.message, error.details.map((issue) => {
            if (issue === null || typeof issue !== "object" || !("path" in issue) || typeof issue.path !== "string") return issue;
            const sourceIndex = sources.get(issue.path);
            return sourceIndex === undefined ? issue : { ...issue, source_index: sourceIndex };
          }));
        }
        throw error;
      }
      return undefined;
    });
    return {
      items: plan.map((item) => ({ document: item.document, path: item.path, source_index: item.source_index })),
      draft_fingerprint: mutation.metadata.fingerprint,
      dry_run: dryRun,
    };
  }

  async update(
    draftId: string,
    owner: string,
    entityType: string,
    id: string,
    expectedFingerprint: string,
    expectedBlobId: string,
    document: GitPmDocument,
    assertChangedPaths?: (paths: readonly string[]) => void,
  ): Promise<EntityResult> {
    const mutation = await this.drafts.withRepositoryMutation(draftId, owner, expectedFingerprint, this.mutationMode, async (metadata) => {
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
            if (entity.relative === found.relative || !containsEntityReference(entity.document, id)) continue;
            const relatedOriginal = await readFile(entity.absolute, "utf8");
            const relatedFormatted = formatYamlDocument(entity.document, referenceLabels);
            if (relatedFormatted === relatedOriginal) continue;
            originals.set(entity.relative, relatedOriginal);
            await atomicWriteDomainFile(metadata.worktree_path, entity.relative, relatedFormatted);
          }
        }
        assertChangedPaths?.([...originals.keys()]);
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
    const mutation = await this.drafts.withRepositoryMutation(draftId, owner, expectedFingerprint, this.mutationMode, async (metadata) => {
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

  async planDelete(draftId: string, entityType: string, id: string): Promise<DeletePlan> {
    const metadata = await this.drafts.getWorkspace(draftId);
    const found = await this.find(draftId, metadata, entityType, id);
    const repository = await this.index(draftId, metadata);
    const cascadedComments = found.document.schema === "gitpm/task@1"
      ? repository.entities.filter((entity) => entity.document.schema === "gitpm/comment@1" && entity.document.task === id)
      : [];
    const commentPaths = new Set(cascadedComments.map((comment) => comment.relative));
    const entitiesByPath = new Map(repository.entities.map((entity) => [entity.relative, entity.document]));
    const restrictions = (await validateDelete(metadata.worktree_path, id))
      .filter((restriction) => !commentPaths.has(restriction.path))
      .map((restriction): DeleteRestriction => {
        const document = entitiesByPath.get(restriction.path);
        return document === undefined ? { path: restriction.path } : {
          path: restriction.path,
          entity_id: typeof document.id === "string" ? document.id : undefined,
          schema: document.schema,
          label: entityDisplayLabel(document),
        };
      });
    const supportsUnlink = found.document.schema === "gitpm/person@1";
    const wouldUnlink: DeleteRestriction[] = supportsUnlink
      ? repository.entities.flatMap((entity) => {
        if (entity.relative === found.relative) return [];
        const document = unlinkPersonReference(entity.document, id);
        return document === undefined ? [] : [{
          path: entity.relative,
          entity_id: typeof entity.document.id === "string" ? entity.document.id : undefined,
          schema: entity.document.schema,
          label: entityDisplayLabel(entity.document),
        }];
      })
      : [];
    return {
      entityType,
      id,
      schema: found.document.schema,
      path: found.relative,
      supports_unlink: supportsUnlink,
      cascaded_comments: cascadedComments.map((comment) => ({ path: comment.relative, id: String(comment.document.id) })),
      restrictions,
      would_unlink: wouldUnlink,
    };
  }

  async delete(
    draftId: string,
    owner: string,
    entityType: string,
    id: string,
    expectedFingerprint: string,
    expectedBlobId: string,
    unlinkReferences = false,
  ): Promise<{ deleted: true; path: string; unlinked_paths: readonly string[]; draft_fingerprint: string }> {
    const mutation = await this.drafts.withRepositoryMutation(draftId, owner, expectedFingerprint, this.mutationMode, async (metadata) => {
      const found = await this.find(draftId, metadata, entityType, id);
      await this.drafts.assertFileBlobId(draftId, found.relative, expectedBlobId);
      const repository = await this.index(draftId, metadata);
      if (unlinkReferences && found.document.schema !== "gitpm/person@1") {
        throw new DomainOperationError("DELETE_UNLINK_UNSUPPORTED", "Automatic reference removal is supported only for people");
      }
      const cascadedComments = found.document.schema === "gitpm/task@1"
        ? repository.entities.filter((entity) => entity.document.schema === "gitpm/comment@1" && entity.document.task === id)
        : [];
      const commentPaths = new Set(cascadedComments.map((comment) => comment.relative));
      const restrictions = (await validateDelete(metadata.worktree_path, id)).filter((restriction) => !commentPaths.has(restriction.path));
      if (restrictions.length > 0 && !unlinkReferences) {
        const entitiesByPath = new Map(repository.entities.map((entity) => [entity.relative, entity.document]));
        throw new DomainOperationError("DELETE_RESTRICTED", `${id} is referenced`, restrictions.map((restriction) => {
          const document = entitiesByPath.get(restriction.path);
          return document === undefined ? restriction : {
            ...restriction,
            entity_id: document.id,
            schema: document.schema,
            label: entityDisplayLabel(document),
          };
        }));
      }
      const updates = unlinkReferences
        ? repository.entities.flatMap((entity) => {
          if (entity.relative === found.relative) return [];
          const document = unlinkPersonReference(entity.document, id);
          return document === undefined ? [] : [{ entity, document }];
        })
        : [];
      const removed = [found, ...cascadedComments];
      const originals = new Map<string, string>();
      try {
        const referenceLabels = this.labels(repository);
        for (const update of updates) {
          originals.set(update.entity.relative, await readFile(update.entity.absolute, "utf8"));
          await atomicWriteDomainFile(metadata.worktree_path, update.entity.relative, formatYamlDocument(update.document, referenceLabels));
        }
        for (const entity of removed) {
          originals.set(entity.relative, await readFile(entity.absolute, "utf8"));
          await rm(entity.absolute);
        }
        await this.assertRepositoryValid(metadata.worktree_path);
      } catch (error) {
        for (const [relative, original] of originals) {
          const absolute = path.join(metadata.worktree_path, ...relative.split("/"));
          await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
          await atomicWriteDomainFile(metadata.worktree_path, relative, original);
        }
        throw error;
      }
      return { path: found.relative, unlinked_paths: updates.map((update) => update.entity.relative) };
    });
    return { deleted: true, ...mutation.result, draft_fingerprint: mutation.metadata.fingerprint };
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
