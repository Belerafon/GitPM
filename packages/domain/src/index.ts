import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { DraftManager, DraftMetadata } from "@gitpm/drafts";
import { formatYamlDocument, parseYamlDocument } from "@gitpm/repository-format";
import type { GitPmDocument } from "@gitpm/repository-format";
import { atomicWriteDomainFile, resolveDomainPath } from "@gitpm/security";
import { validateDelete, validateRepository } from "@gitpm/validation";

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

const typeSchemas: Record<string, string> = {
  projects: "gitpm/project@1",
  tasks: "gitpm/task@1",
  milestones: "gitpm/milestone@1",
  people: "gitpm/person@1",
  teams: "gitpm/team@1",
  calendars: "gitpm/calendar@1",
  views: "gitpm/saved-view@1",
};

export function assertEntityType(entityType: string, document: GitPmDocument): void {
  const schema = typeSchemas[entityType];
  if (!schema || schema !== document.schema) {
    throw new DomainOperationError("ENTITY_TYPE_INVALID", `Entity type ${entityType} does not match ${document.schema}`);
  }
}

export function entityPathForDocument(document: GitPmDocument): string {
  const id = String(document.id ?? "");
  const project = String(document.project ?? "");
  if (!/^[A-Z]{3}-[0-9A-HJKMNP-TV-Z]{26}$/u.test(id)) {
    throw new DomainOperationError("ENTITY_ID_INVALID", "Entity ID is invalid");
  }
  const projectBound = ["gitpm/task@1", "gitpm/milestone@1", "gitpm/saved-view@1"].includes(document.schema);
  if (projectBound && !/^PRJ-[0-9A-HJKMNP-TV-Z]{26}$/u.test(project)) {
    throw new DomainOperationError("ENTITY_PROJECT_INVALID", "Owning Project ID is invalid");
  }
  switch (document.schema) {
    case "gitpm/project@1": return `projects/${id}/project.yaml`;
    case "gitpm/task@1": return `projects/${project}/tasks/${id}.yaml`;
    case "gitpm/milestone@1": return `projects/${project}/milestones/${id}.yaml`;
    case "gitpm/saved-view@1": return `projects/${project}/views/${id}.yaml`;
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

export class EntityStore {
  constructor(private readonly drafts: DraftManager) {}

  async list(draftId: string, entityType: string, project?: string): Promise<readonly EntityResult[]> {
    const metadata = await this.drafts.getDraft(draftId);
    const schema = typeSchemas[entityType];
    if (!schema) throw new DomainOperationError("ENTITY_TYPE_INVALID", `Unknown entity type ${entityType}`);
    const result: EntityResult[] = [];
    for (const absolute of await yamlFiles(metadata.worktree_path)) {
      const relative = path.relative(metadata.worktree_path, absolute).split(path.sep).join("/");
      const document = parseYamlDocument(await readFile(absolute, "utf8"), relative);
      if (document.schema !== schema || (project !== undefined && document.project !== project)) continue;
      result.push({
        document,
        path: relative,
        blob_id: await this.drafts.fileBlobId(draftId, relative),
        draft_fingerprint: metadata.fingerprint,
      });
    }
    return result.sort((left, right) => String(left.document.id).localeCompare(String(right.document.id)));
  }

  private async find(metadata: DraftMetadata, entityType: string, id: string): Promise<{ document: GitPmDocument; relative: string; absolute: string }> {
    const schema = typeSchemas[entityType];
    if (!schema) throw new DomainOperationError("ENTITY_TYPE_INVALID", `Unknown entity type ${entityType}`);
    for (const absolute of await yamlFiles(metadata.worktree_path)) {
      const relative = path.relative(metadata.worktree_path, absolute).split(path.sep).join("/");
      const document = parseYamlDocument(await readFile(absolute, "utf8"), relative);
      if (document.schema === schema && document.id === id) return { document, relative, absolute };
    }
    throw new DomainOperationError("ENTITY_NOT_FOUND", `${entityType}/${id} not found`);
  }

  async get(draftId: string, entityType: string, id: string): Promise<EntityResult> {
    const metadata = await this.drafts.getDraft(draftId);
    const found = await this.find(metadata, entityType, id);
    return {
      document: found.document,
      path: found.relative,
      blob_id: await this.drafts.fileBlobId(draftId, found.relative),
      draft_fingerprint: metadata.fingerprint,
    };
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
      await this.drafts.assertFileBlobId(draftId, relative, expectedBlobId);
      const absolute = await resolveDomainPath(metadata.worktree_path, relative);
      const original = await readFile(absolute, "utf8");
      await atomicWriteDomainFile(metadata.worktree_path, relative, formatYamlDocument(document));
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
      const absolute = path.join(metadata.worktree_path, ...relative.split("/"));
      if (await exists(absolute)) throw new DomainOperationError("ENTITY_EXISTS", `${relative} already exists`);
      await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
      await resolveDomainPath(metadata.worktree_path, relative);
      await atomicWriteDomainFile(metadata.worktree_path, relative, formatYamlDocument(document));
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
      const found = await this.find(metadata, entityType, id);
      if (document.id !== id || document.schema !== found.document.schema || entityPathForDocument(document) !== found.relative) {
        throw new DomainOperationError("ENTITY_IDENTITY_IMMUTABLE", "Entity ID, schema and owning project are immutable");
      }
      await this.drafts.assertFileBlobId(draftId, found.relative, expectedBlobId);
      const original = await readFile(found.absolute, "utf8");
      await atomicWriteDomainFile(metadata.worktree_path, found.relative, formatYamlDocument(document));
      try {
        await this.assertRepositoryValid(metadata.worktree_path);
      } catch (error) {
        await atomicWriteDomainFile(metadata.worktree_path, found.relative, original);
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

  async delete(
    draftId: string,
    owner: string,
    entityType: string,
    id: string,
    expectedFingerprint: string,
    expectedBlobId: string,
  ): Promise<{ deleted: true; path: string; draft_fingerprint: string }> {
    const mutation = await this.drafts.withUiMutation(draftId, owner, expectedFingerprint, async (metadata) => {
      const found = await this.find(metadata, entityType, id);
      await this.drafts.assertFileBlobId(draftId, found.relative, expectedBlobId);
      const restrictions = await validateDelete(metadata.worktree_path, id);
      if (restrictions.length > 0) throw new DomainOperationError("DELETE_RESTRICTED", `${id} is referenced`, restrictions);
      const original = await readFile(found.absolute, "utf8");
      await rm(found.absolute);
      try {
        await this.assertRepositoryValid(metadata.worktree_path);
      } catch (error) {
        await atomicWriteDomainFile(metadata.worktree_path, found.relative, original);
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
