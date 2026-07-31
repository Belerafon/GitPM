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

export interface TimeEntryProjectFilters {
  readonly task?: string;
  readonly milestone?: string;
  readonly person?: string;
  readonly category?: string;
  readonly performed_from?: string;
  readonly performed_to?: string;
  readonly state?: "active" | "voided";
  readonly offset?: number;
  readonly limit?: number;
}

export interface TimeEntryProjectList {
  readonly items: readonly TimeEntryResult[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
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

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function isSlug(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,62}$/u.test(value);
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

  private async project(metadata: RepositoryWorkspace, projectId: string): Promise<GitPmDocument> {
    if (!isEntityId(projectId, ENTITY_ID_PREFIX.project)) throw new TimeEntryOperationError("ENTITY_PROJECT_INVALID", "Project ID is invalid");
    const relative = `projects/${projectId}/project.yaml`;
    const absolute = await resolveDomainPath(metadata.worktree_path, relative);
    try {
      const document = parseYamlDocument(await readFile(absolute, "utf8"), relative);
      if (document.schema === "gitpm/project@2" && document.id === projectId) return document;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    throw new TimeEntryOperationError("ENTITY_NOT_FOUND", `projects/${projectId} not found`);
  }

  private async assertWritableTask(metadata: RepositoryWorkspace, projectId: string, taskId: string): Promise<GitPmDocument> {
    const task = await this.task(metadata, projectId, taskId);
    if (task.lifecycle === "archived") throw new TimeEntryOperationError("TIME_ENTRY_TASK_ARCHIVED", "Archived tasks cannot receive new time entries");
    return task;
  }

  private async assertActiveCategory(metadata: RepositoryWorkspace, category: string): Promise<void> {
    const relative = ".gitpm/work-categories.yaml";
    const absolute = await resolveDomainPath(metadata.worktree_path, relative);
    const document = parseYamlDocument(await readFile(absolute, "utf8"), relative);
    const categories = Array.isArray(document.categories) ? document.categories : [];
    const found = categories.find((candidate) => candidate !== null && typeof candidate === "object" && (candidate as Record<string, unknown>).slug === category) as Record<string, unknown> | undefined;
    if (found?.active === false) throw new TimeEntryOperationError("TIME_ENTRY_CATEGORY_INACTIVE", `Work category ${category} is inactive`);
  }

  private async assertReplacement(metadata: RepositoryWorkspace, projectId: string, taskId: string, entryId: string, replacement: string): Promise<void> {
    if (!isEntityId(replacement, ENTITY_ID_PREFIX.entry)) throw new TimeEntryOperationError("TIME_ENTRY_REPLACEMENT_INVALID", "Replacement time entry ID is invalid");
    if (replacement === entryId) throw new TimeEntryOperationError("TIME_ENTRY_REPLACEMENT_SELF", "A time entry cannot replace itself");
    const projects = await resolveDomainPath(metadata.worktree_path, "projects");
    let projectDirectories: string[] = [];
    try { projectDirectories = (await readdir(projects, { withFileTypes: true })).filter((entry) => entry.isDirectory() && isEntityId(entry.name, ENTITY_ID_PREFIX.project)).map((entry) => entry.name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let target: TimeEntryDocument | undefined;
    for (const candidateProject of projectDirectories) {
      const entries = await resolveDomainPath(metadata.worktree_path, `projects/${candidateProject}/time-entries`);
      let taskDirectories: string[] = [];
      try { taskDirectories = (await readdir(entries, { withFileTypes: true })).filter((entry) => entry.isDirectory() && isEntityId(entry.name, ENTITY_ID_PREFIX.task)).map((entry) => entry.name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      for (const candidateTask of taskDirectories) {
        const relative = entryPath(candidateProject, candidateTask, replacement);
        const absolute = await resolveDomainPath(metadata.worktree_path, relative);
        if (!await exists(absolute)) continue;
        const document = parseYamlDocument(await readFile(absolute, "utf8"), relative);
        if (document.schema === "gitpm/time-entry@1" && document.id === replacement) target = document as TimeEntryDocument;
      }
    }
    if (target === undefined) throw new TimeEntryOperationError("TIME_ENTRY_REPLACEMENT_MISSING", `${replacement} does not reference a time entry`);
    if (target.task !== taskId || target.project !== projectId) {
      throw new TimeEntryOperationError("TIME_ENTRY_REPLACEMENT_TASK_MISMATCH", `${replacement} belongs to another task`);
    }
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

  async listProject(draftId: string, projectId: string, filters: TimeEntryProjectFilters = {}): Promise<TimeEntryProjectList> {
    const metadata = await this.drafts.getWorkspace(draftId);
    await this.project(metadata, projectId);
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new TimeEntryOperationError("TIME_ENTRY_FILTER_INVALID", "Pagination values are invalid");
    if (filters.task !== undefined && !isEntityId(filters.task, ENTITY_ID_PREFIX.task)) throw new TimeEntryOperationError("TIME_ENTRY_FILTER_INVALID", "Task filter is invalid");
    if (filters.milestone !== undefined && !isEntityId(filters.milestone, ENTITY_ID_PREFIX.milestone)) throw new TimeEntryOperationError("TIME_ENTRY_FILTER_INVALID", "Milestone filter is invalid");
    if (filters.person !== undefined && !isEntityId(filters.person, ENTITY_ID_PREFIX.person)) throw new TimeEntryOperationError("TIME_ENTRY_FILTER_INVALID", "Person filter is invalid");
    if (filters.category !== undefined && !isSlug(filters.category)) throw new TimeEntryOperationError("TIME_ENTRY_FILTER_INVALID", "Category filter is invalid");
    if (filters.state !== undefined && filters.state !== "active" && filters.state !== "voided") throw new TimeEntryOperationError("TIME_ENTRY_FILTER_INVALID", "State filter is invalid");
    if (filters.performed_from !== undefined && !isDate(filters.performed_from) || filters.performed_to !== undefined && !isDate(filters.performed_to)) throw new TimeEntryOperationError("TIME_ENTRY_FILTER_INVALID", "Date filter is invalid");
    if (filters.performed_from !== undefined && filters.performed_to !== undefined && filters.performed_from > filters.performed_to) throw new TimeEntryOperationError("TIME_ENTRY_FILTER_INVALID", "Date range is invalid");

    const tasksDirectory = await resolveDomainPath(metadata.worktree_path, `projects/${projectId}/tasks`);
    const tasks = new Map<string, GitPmDocument>();
    for (const file of await yamlFiles(tasksDirectory)) {
      const relative = path.relative(metadata.worktree_path, file).split(path.sep).join("/");
      const document = parseYamlDocument(await readFile(file, "utf8"), relative);
      if (document.schema === "gitpm/task@2" && document.project === projectId && typeof document.id === "string") tasks.set(document.id, document);
    }
    if (filters.task !== undefined && !tasks.has(filters.task)) throw new TimeEntryOperationError("REF_CROSS_PROJECT", `${filters.task} does not belong to ${projectId}`);
    if (filters.milestone !== undefined) {
      const milestone = await resolveDomainPath(metadata.worktree_path, `projects/${projectId}/milestones/${filters.milestone}.yaml`);
      try {
        const document = parseYamlDocument(await readFile(milestone, "utf8"), `projects/${projectId}/milestones/${filters.milestone}.yaml`);
        if (document.schema !== "gitpm/milestone@2" || document.project !== projectId) throw new Error();
      } catch {
        throw new TimeEntryOperationError("REF_CROSS_PROJECT", `${filters.milestone} does not belong to ${projectId}`);
      }
    }
    const directory = await resolveDomainPath(metadata.worktree_path, `projects/${projectId}/time-entries`);
    let taskDirectories: string[] = [];
    try { taskDirectories = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory() && isEntityId(entry.name, ENTITY_ID_PREFIX.task)).map((entry) => entry.name).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const entries: Array<{ relative: string; document: TimeEntryDocument }> = [];
    for (const taskId of taskDirectories) {
      const taskDocument = tasks.get(taskId);
      if (taskDocument === undefined) continue;
      if (filters.task !== undefined && taskId !== filters.task || filters.milestone !== undefined && taskDocument.milestone !== filters.milestone) continue;
      const taskDirectory = await resolveDomainPath(metadata.worktree_path, `projects/${projectId}/time-entries/${taskId}`);
      for (const file of await yamlFiles(taskDirectory)) {
        const relative = path.relative(metadata.worktree_path, file).split(path.sep).join("/");
        const document = parseYamlDocument(await readFile(file, "utf8"), relative) as TimeEntryDocument;
        if (document.schema !== "gitpm/time-entry@1" || document.project !== projectId || document.task !== taskId) continue;
        if (filters.person !== undefined && document.person !== filters.person || filters.category !== undefined && document.category !== filters.category || filters.state !== undefined && document.state !== filters.state || filters.performed_from !== undefined && document.performed_on < filters.performed_from || filters.performed_to !== undefined && document.performed_on > filters.performed_to) continue;
        entries.push({ relative, document });
      }
    }
    entries.sort((left, right) => left.document.performed_on.localeCompare(right.document.performed_on) || left.document.created_at.localeCompare(right.document.created_at) || left.document.id.localeCompare(right.document.id));
    const total = entries.length;
    const page = entries.slice(offset, offset + limit);
    const blobIds = await this.drafts.fileBlobIds(draftId, page.map((entry) => entry.relative));
    return { items: page.map((entry) => ({ document: entry.document, path: entry.relative, blob_id: blobIds.get(entry.relative)!, draft_fingerprint: metadata.fingerprint })), total, offset, limit };
  }

  async create(draftId: string, projectId: string, taskId: string, expectedFingerprint: string, input: TimeEntryInput, actor: TimeEntryActor): Promise<TimeEntryResult> {
    if (!isEntityId(input.person, ENTITY_ID_PREFIX.person)) throw new TimeEntryOperationError("REF_MISSING", `${input.person} does not reference a person`);
    let created: TimeEntryDocument | undefined;
    let relative = "";
    const mutation = await this.drafts.withRepositoryMutation(draftId, actor.userId, expectedFingerprint, this.mutationMode, async (metadata) => {
      const task = await this.assertWritableTask(metadata, projectId, taskId);
      await this.assertActiveCategory(metadata, input.category);
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
      if (replacement !== undefined) await this.assertReplacement(metadata, projectId, taskId, entryId, replacement);
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
      const task = await this.assertWritableTask(metadata, projectId, taskId);
      await this.assertActiveCategory(metadata, input.category);
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
