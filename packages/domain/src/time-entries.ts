import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { DraftManager, RepositoryMutationMode, RepositoryWorkspace } from "@gitpm/drafts";
import { formatYamlDocument, parseYamlDocument, referenceLabelsForDocuments, type GitPmDocument } from "@gitpm/repository-format";
import { atomicWriteDomainFile, resolveDomainPath } from "@gitpm/security";
import { ENTITY_ID_PREFIX, isEntityId, newUniqueEntityId } from "@gitpm/shared";
import { validateRepository } from "@gitpm/validation";

export interface TimeEntryActor {
  readonly userId: string;
  readonly identity: { readonly provider: "gitlab" | "git"; readonly instance?: string; readonly subject: string; readonly display_name: string };
}

export interface TimeEntryInput {
  readonly person: string;
  readonly performed_on: string;
  readonly hours: number;
  readonly category: string;
  readonly note_markdown?: string;
}

export interface TimeEntryDocument extends GitPmDocument {
  readonly schema: "gitpm/time-entry@1";
  readonly id: string;
  readonly project: string;
  readonly task: string;
  readonly person: string;
  readonly performed_on: string;
  readonly hours: number;
  readonly category: string;
  readonly created_at: string;
  readonly state: "active" | "voided";
  readonly note_markdown?: string;
  readonly voided_at?: string;
  readonly voided_by?: TimeEntryActor["identity"];
  readonly replacement?: string;
}

export interface TimeEntryResult {
  readonly document: TimeEntryDocument;
  readonly path: string;
  readonly blob_id: string;
  readonly draft_fingerprint: string;
}

export class TimeEntryOperationError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "TimeEntryOperationError";
  }
}

async function exists(absolute: string): Promise<boolean> {
  try { await readFile(absolute); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function yamlFiles(directory: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".yaml")).map((entry) => path.join(directory, entry.name)).sort();
}

function entryPath(projectId: string, taskId: string, entryId: string): string {
  if (!isEntityId(projectId, ENTITY_ID_PREFIX.project)) throw new TimeEntryOperationError("ENTITY_PROJECT_INVALID", "Project ID is invalid");
  if (!isEntityId(taskId, ENTITY_ID_PREFIX.task)) throw new TimeEntryOperationError("ENTITY_ID_INVALID", "Task ID is invalid");
  if (!isEntityId(entryId, ENTITY_ID_PREFIX.entry)) throw new TimeEntryOperationError("ENTITY_ID_INVALID", "Time entry ID is invalid");
  return `projects/${projectId}/time-entries/${taskId}/${entryId}.yaml`;
}

export class TimeEntryStore {
  constructor(
    private readonly drafts: DraftManager,
    private readonly now: () => Date = () => new Date(),
    private readonly mutationMode: RepositoryMutationMode = "ui",
  ) {}

  private async task(metadata: RepositoryWorkspace, projectId: string, taskId: string): Promise<GitPmDocument> {
    const relative = `projects/${projectId}/tasks/${taskId}.yaml`;
    const absolute = await resolveDomainPath(metadata.worktree_path, relative);
    let document: GitPmDocument;
    try { document = parseYamlDocument(await readFile(absolute, "utf8"), relative); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TimeEntryOperationError("ENTITY_NOT_FOUND", `tasks/${taskId} not found`);
      throw error;
    }
    if (document.schema !== "gitpm/task@2" || document.id !== taskId || document.project !== projectId) throw new TimeEntryOperationError("ENTITY_NOT_FOUND", `tasks/${taskId} not found`);
    return document;
  }

  private async readEntry(metadata: RepositoryWorkspace, projectId: string, taskId: string, entryId: string): Promise<{ relative: string; absolute: string; document: TimeEntryDocument }> {
    const relative = entryPath(projectId, taskId, entryId);
    const absolute = await resolveDomainPath(metadata.worktree_path, relative);
    let document: GitPmDocument;
    try { document = parseYamlDocument(await readFile(absolute, "utf8"), relative); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TimeEntryOperationError("TIME_ENTRY_NOT_FOUND", `${entryId} not found`);
      throw error;
    }
    if (document.schema !== "gitpm/time-entry@1" || document.id !== entryId || document.task !== taskId || document.project !== projectId) throw new TimeEntryOperationError("TIME_ENTRY_NOT_FOUND", `${entryId} not found`);
    return { relative, absolute, document: document as TimeEntryDocument };
  }

  private async allEntryIds(metadata: RepositoryWorkspace): Promise<Set<string>> {
    const root = path.join(metadata.worktree_path, "projects");
    let projectDirs: string[] = [];
    try { projectDirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const ids = new Set<string>();
    for (const projectDir of projectDirs) {
      const timeEntriesRoot = path.join(projectDir, "time-entries");
      let taskDirs: string[] = [];
      try { taskDirs = (await readdir(timeEntriesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => path.join(timeEntriesRoot, entry.name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      for (const taskDir of taskDirs) for (const file of await yamlFiles(taskDir)) {
        const id = path.basename(file, ".yaml");
        if (isEntityId(id, ENTITY_ID_PREFIX.entry)) ids.add(id);
      }
    }
    return ids;
  }

  private async result(draftId: string, metadata: RepositoryWorkspace, relative: string, document: TimeEntryDocument): Promise<TimeEntryResult> {
    return { document, path: relative, blob_id: await this.drafts.fileBlobId(draftId, relative), draft_fingerprint: metadata.fingerprint };
  }

  async list(draftId: string, projectId: string, taskId: string): Promise<readonly TimeEntryResult[]> {
    const metadata = await this.drafts.getWorkspace(draftId);
    await this.task(metadata, projectId, taskId);
    const directory = path.join(metadata.worktree_path, "projects", projectId, "time-entries", taskId);
    const files = await yamlFiles(directory);
    const documents = await Promise.all(files.map(async (absolute) => {
      const relative = path.relative(metadata.worktree_path, absolute).split(path.sep).join("/");
      return { relative, document: parseYamlDocument(await readFile(absolute, "utf8"), relative) as TimeEntryDocument };
    }));
    const entries = documents.filter((entry) => entry.document.schema === "gitpm/time-entry@1" && entry.document.task === taskId && entry.document.project === projectId);
    const blobIds = await this.drafts.fileBlobIds(draftId, entries.map((entry) => entry.relative));
    return entries.map((entry) => ({ document: entry.document, path: entry.relative, blob_id: blobIds.get(entry.relative)!, draft_fingerprint: metadata.fingerprint }))
      .sort((left, right) => left.document.created_at.localeCompare(right.document.created_at) || left.document.id.localeCompare(right.document.id));
  }

  async create(draftId: string, projectId: string, taskId: string, expectedFingerprint: string, input: TimeEntryInput, actor: TimeEntryActor): Promise<TimeEntryResult> {
    if (!isEntityId(input.person, ENTITY_ID_PREFIX.person)) throw new TimeEntryOperationError("REF_MISSING", `${input.person} does not reference a person`);
    let created: TimeEntryDocument | undefined;
    let relative = "";
    const mutation = await this.drafts.withRepositoryMutation(draftId, actor.userId, expectedFingerprint, this.mutationMode, async (metadata) => {
      const task = await this.task(metadata, projectId, taskId);
      const id = newUniqueEntityId(ENTITY_ID_PREFIX.entry, await this.allEntryIds(metadata));
      relative = entryPath(projectId, taskId, id);
      const absolute = path.join(metadata.worktree_path, ...relative.split("/"));
      if (await exists(absolute)) throw new TimeEntryOperationError("ENTITY_EXISTS", `${id} already exists`);
      created = {
        schema: "gitpm/time-entry@1", id, project: projectId, task: taskId, person: input.person,
        performed_on: input.performed_on, hours: input.hours, category: input.category,
        created_at: this.now().toISOString(), state: "active",
        ...(input.note_markdown === undefined || input.note_markdown === "" ? {} : { note_markdown: input.note_markdown }),
      };
      await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
      await atomicWriteDomainFile(metadata.worktree_path, relative, formatYamlDocument(created, referenceLabelsForDocuments([task])));
      try { await this.assertValid(metadata.worktree_path); }
      catch (error) { await rm(absolute, { force: true }); throw error; }
    });
    if (created === undefined) throw new TimeEntryOperationError("TIME_ENTRY_CREATE_FAILED", "Time entry was not created");
    return await this.result(draftId, mutation.metadata, relative, created);
  }

  async void(draftId: string, projectId: string, taskId: string, entryId: string, expectedFingerprint: string, expectedBlobId: string, actor: TimeEntryActor, replacement?: string): Promise<TimeEntryResult> {
    let voided: TimeEntryDocument | undefined;
    let relative = "";
    const mutation = await this.drafts.withRepositoryMutation(draftId, actor.userId, expectedFingerprint, this.mutationMode, async (metadata) => {
      const task = await this.task(metadata, projectId, taskId);
      const current = await this.readEntry(metadata, projectId, taskId, entryId);
      if (current.document.state !== "active") throw new TimeEntryOperationError("TIME_ENTRY_VOIDED", "Time entry is already voided");
      await this.drafts.assertFileBlobId(draftId, current.relative, expectedBlobId);
      relative = current.relative;
      voided = { ...current.document, state: "voided", voided_at: this.now().toISOString(), voided_by: actor.identity, ...(replacement === undefined ? {} : { replacement }) };
      const original = await readFile(current.absolute, "utf8");
      await atomicWriteDomainFile(metadata.worktree_path, relative, formatYamlDocument(voided, referenceLabelsForDocuments([task])));
      try { await this.assertValid(metadata.worktree_path); }
      catch (error) { await atomicWriteDomainFile(metadata.worktree_path, relative, original); throw error; }
    });
    if (voided === undefined) throw new TimeEntryOperationError("TIME_ENTRY_VOID_FAILED", "Time entry was not voided");
    return await this.result(draftId, mutation.metadata, relative, voided);
  }

  async replace(draftId: string, projectId: string, taskId: string, entryId: string, expectedFingerprint: string, expectedBlobId: string, input: TimeEntryInput, actor: TimeEntryActor): Promise<{ voided: TimeEntryResult; created: TimeEntryResult }> {
    if (!isEntityId(input.person, ENTITY_ID_PREFIX.person)) throw new TimeEntryOperationError("REF_MISSING", `${input.person} does not reference a person`);
    let voided: TimeEntryDocument | undefined;
    let created: TimeEntryDocument | undefined;
    let voidedRelative = "";
    let createdRelative = "";
    const mutation = await this.drafts.withRepositoryMutation(draftId, actor.userId, expectedFingerprint, this.mutationMode, async (metadata) => {
      const task = await this.task(metadata, projectId, taskId);
      const current = await this.readEntry(metadata, projectId, taskId, entryId);
      if (current.document.state !== "active") throw new TimeEntryOperationError("TIME_ENTRY_VOIDED", "Time entry is already voided");
      await this.drafts.assertFileBlobId(draftId, current.relative, expectedBlobId);
      const id = newUniqueEntityId(ENTITY_ID_PREFIX.entry, await this.allEntryIds(metadata));
      createdRelative = entryPath(projectId, taskId, id);
      const createdAbsolute = path.join(metadata.worktree_path, ...createdRelative.split("/"));
      if (await exists(createdAbsolute)) throw new TimeEntryOperationError("ENTITY_EXISTS", `${id} already exists`);
      created = {
        schema: "gitpm/time-entry@1", id, project: projectId, task: taskId, person: input.person,
        performed_on: input.performed_on, hours: input.hours, category: input.category,
        created_at: this.now().toISOString(), state: "active",
        ...(input.note_markdown === undefined || input.note_markdown === "" ? {} : { note_markdown: input.note_markdown }),
      };
      voidedRelative = current.relative;
      voided = { ...current.document, state: "voided", voided_at: this.now().toISOString(), voided_by: actor.identity, replacement: id };
      const labels = referenceLabelsForDocuments([task]);
      const original = await readFile(current.absolute, "utf8");
      await atomicWriteDomainFile(metadata.worktree_path, voidedRelative, formatYamlDocument(voided, labels));
      try {
        await mkdir(path.dirname(createdAbsolute), { recursive: true, mode: 0o700 });
        await atomicWriteDomainFile(metadata.worktree_path, createdRelative, formatYamlDocument(created, labels));
        await this.assertValid(metadata.worktree_path);
      } catch (error) {
        await atomicWriteDomainFile(metadata.worktree_path, voidedRelative, original);
        await rm(createdAbsolute, { force: true });
        throw error;
      }
    });
    if (voided === undefined || created === undefined) throw new TimeEntryOperationError("TIME_ENTRY_REPLACE_FAILED", "Time entry was not replaced");
    return {
      voided: await this.result(draftId, mutation.metadata, voidedRelative, voided),
      created: await this.result(draftId, mutation.metadata, createdRelative, created),
    };
  }

  private async assertValid(worktree: string): Promise<void> {
    const report = await validateRepository(worktree);
    if (!report.valid) throw new TimeEntryOperationError("VALIDATION_FAILED", report.errors[0]?.message ?? "Repository validation failed", report.errors);
  }
}
