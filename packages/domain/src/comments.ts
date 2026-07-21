import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { DraftManager, DraftMetadata } from "@gitpm/drafts";
import { formatYamlDocument, parseYamlDocument, referenceLabelsForDocuments, type GitPmDocument } from "@gitpm/repository-format";
import { atomicWriteDomainFile, resolveDomainPath } from "@gitpm/security";
import { ENTITY_ID_PREFIX, isEntityId, newUniqueEntityId } from "@gitpm/shared";
import { validateRepository } from "@gitpm/validation";

const MAX_COMMENT_LENGTH = 32_768;
const MENTION_PATTERN = /@\[[^\]\r\n]{1,200}\]\(person:(U-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6})\)/gu;

export interface ActorSnapshot {
  readonly provider: "gitlab" | "git";
  readonly instance?: string;
  readonly subject: string;
  readonly display_name: string;
}

export interface CommentActor {
  readonly userId: string;
  readonly role: "Reporter" | "Developer" | "Maintainer";
  readonly identity: ActorSnapshot;
  readonly email?: string;
  readonly personId?: string;
}

export interface CommentMention {
  readonly person: string;
  readonly mentioned_at: string;
}

export interface CommentDocument extends GitPmDocument {
  readonly schema: "gitpm/comment@1";
  readonly id: string;
  readonly project: string;
  readonly task: string;
  readonly author: ActorSnapshot;
  readonly created_at: string;
  readonly updated_at?: string;
  readonly state: "active" | "deleted";
  readonly body_markdown?: string;
  readonly mentions: readonly CommentMention[];
  readonly deleted_at?: string;
  readonly deleted_by?: ActorSnapshot;
}

export interface CommentResult {
  readonly document: CommentDocument;
  readonly path: string;
  readonly blob_id: string;
  readonly draft_fingerprint: string;
  readonly can_edit: boolean;
  readonly can_delete: boolean;
}

export interface MentionNotification {
  readonly key: string;
  readonly person_id: string;
  readonly mentioned_at: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly task_title: string;
  readonly comment_id: string;
  readonly author: ActorSnapshot;
  readonly excerpt: string;
}

export interface NotificationsResult {
  readonly recipient_person_id?: string;
  readonly items: readonly MentionNotification[];
}

export class CommentOperationError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "CommentOperationError";
  }
}

function sameActor(left: ActorSnapshot, right: ActorSnapshot): boolean {
  return left.provider === right.provider && left.instance === right.instance && left.subject === right.subject;
}

function requiredBody(value: string): string {
  const body = value.trim();
  if (body === "") throw new CommentOperationError("COMMENT_BODY_REQUIRED", "Comment body is required");
  if (body.length > MAX_COMMENT_LENGTH) throw new CommentOperationError("COMMENT_BODY_TOO_LONG", `Comment body exceeds ${MAX_COMMENT_LENGTH} characters`);
  return body;
}

function mentionIds(body: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const id = match[1]!;
    if (!seen.has(id)) { seen.add(id); result.push(id); }
  }
  return result;
}

async function exists(absolute: string): Promise<boolean> {
  try { await readFile(absolute); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function yamlFiles(directory: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return await yamlFiles(absolute);
    return entry.name.endsWith(".yaml") ? [absolute] : [];
  }));
  return nested.flat().sort();
}

function commentPath(projectId: string, taskId: string, commentId: string): string {
  if (!isEntityId(projectId, ENTITY_ID_PREFIX.project)) throw new CommentOperationError("ENTITY_PROJECT_INVALID", "Project ID is invalid");
  if (!isEntityId(taskId, ENTITY_ID_PREFIX.task)) throw new CommentOperationError("ENTITY_ID_INVALID", "Task ID is invalid");
  if (!isEntityId(commentId, ENTITY_ID_PREFIX.comment)) throw new CommentOperationError("ENTITY_ID_INVALID", "Comment ID is invalid");
  return `projects/${projectId}/comments/${taskId}/${commentId}.yaml`;
}

async function documents(files: readonly string[], root: string): Promise<GitPmDocument[]> {
  return await Promise.all(files.map(async (absolute) => parseYamlDocument(await readFile(absolute, "utf8"), path.relative(root, absolute).split(path.sep).join("/"))));
}

export class CommentStore {
  constructor(private readonly drafts: DraftManager, private readonly now: () => Date = () => new Date()) {}

  private async task(metadata: DraftMetadata, projectId: string, taskId: string): Promise<GitPmDocument> {
    const relative = `projects/${projectId}/tasks/${taskId}.yaml`;
    const absolute = await resolveDomainPath(metadata.worktree_path, relative);
    let document: GitPmDocument;
    try { document = parseYamlDocument(await readFile(absolute, "utf8"), relative); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CommentOperationError("ENTITY_NOT_FOUND", `tasks/${taskId} not found`);
      throw error;
    }
    if (document.schema !== "gitpm/task@1" || document.id !== taskId || document.project !== projectId) throw new CommentOperationError("ENTITY_NOT_FOUND", `tasks/${taskId} not found`);
    return document;
  }

  private async people(metadata: DraftMetadata): Promise<GitPmDocument[]> {
    return (await documents(await yamlFiles(path.join(metadata.worktree_path, "people")), metadata.worktree_path))
      .filter((document) => document.schema === "gitpm/person@1");
  }

  private async referenceLabels(metadata: DraftMetadata, task: GitPmDocument, people?: readonly GitPmDocument[]) {
    return referenceLabelsForDocuments([task, ...(people ?? await this.people(metadata))]);
  }

  private mentions(body: string, people: readonly GitPmDocument[], timestamp: string, previous: readonly CommentMention[] = []): CommentMention[] {
    const byId = new Map(people.map((person) => [String(person.id), person]));
    const previousByPerson = new Map(previous.map((mention) => [mention.person, mention]));
    return mentionIds(body).map((personId) => {
      const person = byId.get(personId);
      if (person === undefined) throw new CommentOperationError("COMMENT_MENTION_INVALID", `${personId} does not reference a person`);
      if (person.lifecycle !== "active" && !previousByPerson.has(personId)) throw new CommentOperationError("COMMENT_MENTION_ARCHIVED", `${personId} is archived`);
      return previousByPerson.get(personId) ?? { person: personId, mentioned_at: timestamp };
    });
  }

  private async allCommentIds(metadata: DraftMetadata): Promise<Set<string>> {
    const files = await yamlFiles(path.join(metadata.worktree_path, "projects"));
    return new Set(files.map((absolute) => path.basename(absolute, ".yaml")).filter((id) => isEntityId(id, ENTITY_ID_PREFIX.comment)));
  }

  private permissions(document: CommentDocument, actor: CommentActor) {
    const author = sameActor(document.author, actor.identity);
    return { can_edit: document.state === "active" && author, can_delete: document.state === "active" && (author || actor.role === "Maintainer") };
  }

  private async result(draftId: string, metadata: DraftMetadata, relative: string, document: CommentDocument, actor: CommentActor): Promise<CommentResult> {
    return {
      document,
      path: relative,
      blob_id: await this.drafts.fileBlobId(draftId, relative),
      draft_fingerprint: metadata.fingerprint,
      ...this.permissions(document, actor),
    };
  }

  private async readComment(metadata: DraftMetadata, projectId: string, taskId: string, commentId: string): Promise<{ relative: string; absolute: string; document: CommentDocument }> {
    const relative = commentPath(projectId, taskId, commentId);
    const absolute = await resolveDomainPath(metadata.worktree_path, relative);
    let document: GitPmDocument;
    try { document = parseYamlDocument(await readFile(absolute, "utf8"), relative); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CommentOperationError("COMMENT_NOT_FOUND", `${commentId} not found`);
      throw error;
    }
    if (document.schema !== "gitpm/comment@1" || document.id !== commentId || document.task !== taskId || document.project !== projectId) throw new CommentOperationError("COMMENT_NOT_FOUND", `${commentId} not found`);
    return { relative, absolute, document: document as CommentDocument };
  }

  async list(draftId: string, projectId: string, taskId: string, actor: CommentActor): Promise<readonly CommentResult[]> {
    const metadata = await this.drafts.getDraft(draftId);
    await this.task(metadata, projectId, taskId);
    const directory = path.join(metadata.worktree_path, "projects", projectId, "comments", taskId);
    const files = await yamlFiles(directory);
    const parsed = await documents(files, metadata.worktree_path);
    const comments = parsed.filter((document): document is CommentDocument => document.schema === "gitpm/comment@1");
    const relativePaths = files.map((absolute) => path.relative(metadata.worktree_path, absolute).split(path.sep).join("/"));
    const blobIds = await this.drafts.fileBlobIds(draftId, relativePaths);
    return comments.map((document, index) => ({
      document,
      path: relativePaths[index]!,
      blob_id: blobIds.get(relativePaths[index]!)!,
      draft_fingerprint: metadata.fingerprint,
      ...this.permissions(document, actor),
    })).sort((left, right) => left.document.created_at.localeCompare(right.document.created_at) || left.document.id.localeCompare(right.document.id));
  }

  async create(draftId: string, projectId: string, taskId: string, expectedFingerprint: string, bodyValue: string, actor: CommentActor): Promise<CommentResult> {
    const body = requiredBody(bodyValue);
    let created: CommentDocument | undefined;
    let relative = "";
    const mutation = await this.drafts.withUiMutation(draftId, actor.userId, expectedFingerprint, async (metadata) => {
      const task = await this.task(metadata, projectId, taskId);
      const people = await this.people(metadata);
      const timestamp = this.now().toISOString();
      const id = newUniqueEntityId(ENTITY_ID_PREFIX.comment, await this.allCommentIds(metadata), undefined, this.now());
      relative = commentPath(projectId, taskId, id);
      const absolute = path.join(metadata.worktree_path, ...relative.split("/"));
      if (await exists(absolute)) throw new CommentOperationError("COMMENT_EXISTS", `${id} already exists`);
      created = { schema: "gitpm/comment@1", id, project: projectId, task: taskId, author: actor.identity, created_at: timestamp, state: "active", body_markdown: body, mentions: this.mentions(body, people, timestamp) };
      await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
      await atomicWriteDomainFile(metadata.worktree_path, relative, formatYamlDocument(created, await this.referenceLabels(metadata, task, people)));
      try { await this.assertValid(metadata.worktree_path); }
      catch (error) { await rm(absolute, { force: true }); throw error; }
    });
    if (created === undefined) throw new CommentOperationError("COMMENT_CREATE_FAILED", "Comment was not created");
    return await this.result(draftId, mutation.metadata, relative, created, actor);
  }

  async update(draftId: string, projectId: string, taskId: string, commentId: string, expectedFingerprint: string, expectedBlobId: string, bodyValue: string, actor: CommentActor): Promise<CommentResult> {
    const body = requiredBody(bodyValue);
    let updated: CommentDocument | undefined;
    let relative = "";
    const mutation = await this.drafts.withUiMutation(draftId, actor.userId, expectedFingerprint, async (metadata) => {
      const task = await this.task(metadata, projectId, taskId);
      const current = await this.readComment(metadata, projectId, taskId, commentId);
      if (current.document.state !== "active") throw new CommentOperationError("COMMENT_DELETED", "Deleted comment cannot be edited");
      if (!sameActor(current.document.author, actor.identity)) throw new CommentOperationError("COMMENT_FORBIDDEN", "Only the author can edit a comment");
      await this.drafts.assertFileBlobId(draftId, current.relative, expectedBlobId);
      const people = await this.people(metadata);
      const timestamp = this.now().toISOString();
      updated = { ...current.document, body_markdown: body, updated_at: timestamp, mentions: this.mentions(body, people, timestamp, current.document.mentions) };
      relative = current.relative;
      const original = await readFile(current.absolute, "utf8");
      await atomicWriteDomainFile(metadata.worktree_path, relative, formatYamlDocument(updated, await this.referenceLabels(metadata, task, people)));
      try { await this.assertValid(metadata.worktree_path); }
      catch (error) { await atomicWriteDomainFile(metadata.worktree_path, relative, original); throw error; }
    });
    if (updated === undefined) throw new CommentOperationError("COMMENT_UPDATE_FAILED", "Comment was not updated");
    return await this.result(draftId, mutation.metadata, relative, updated, actor);
  }

  async delete(draftId: string, projectId: string, taskId: string, commentId: string, expectedFingerprint: string, expectedBlobId: string, actor: CommentActor): Promise<CommentResult> {
    let deleted: CommentDocument | undefined;
    let relative = "";
    const mutation = await this.drafts.withUiMutation(draftId, actor.userId, expectedFingerprint, async (metadata) => {
      const task = await this.task(metadata, projectId, taskId);
      const current = await this.readComment(metadata, projectId, taskId, commentId);
      if (current.document.state !== "active") throw new CommentOperationError("COMMENT_DELETED", "Comment is already deleted");
      if (!sameActor(current.document.author, actor.identity) && actor.role !== "Maintainer") throw new CommentOperationError("COMMENT_FORBIDDEN", "Comment deletion is forbidden");
      await this.drafts.assertFileBlobId(draftId, current.relative, expectedBlobId);
      const timestamp = this.now().toISOString();
      const { body_markdown: _body, ...rest } = current.document;
      void _body;
      deleted = { ...rest, state: "deleted", mentions: [], deleted_at: timestamp, deleted_by: actor.identity };
      relative = current.relative;
      const original = await readFile(current.absolute, "utf8");
      await atomicWriteDomainFile(metadata.worktree_path, relative, formatYamlDocument(deleted, await this.referenceLabels(metadata, task)));
      try { await this.assertValid(metadata.worktree_path); }
      catch (error) { await atomicWriteDomainFile(metadata.worktree_path, relative, original); throw error; }
    });
    if (deleted === undefined) throw new CommentOperationError("COMMENT_DELETE_FAILED", "Comment was not deleted");
    return await this.result(draftId, mutation.metadata, relative, deleted, actor);
  }

  async notifications(draftId: string, actor: CommentActor): Promise<NotificationsResult> {
    const metadata = await this.drafts.getDraft(draftId);
    const people = await this.people(metadata);
    const normalizedEmail = actor.email?.trim().toLocaleLowerCase();
    const recipient = actor.personId === undefined
      ? people.find((person) => normalizedEmail !== undefined && typeof person.email === "string" && person.email.trim().toLocaleLowerCase() === normalizedEmail)
      : people.find((person) => person.id === actor.personId);
    if (recipient === undefined) return { items: [] };
    const personId = String(recipient.id);
    const commentFiles = (await yamlFiles(path.join(metadata.worktree_path, "projects"))).filter((absolute) => absolute.split(path.sep).includes("comments"));
    const comments = (await documents(commentFiles, metadata.worktree_path)).filter((document): document is CommentDocument => document.schema === "gitpm/comment@1" && document.state === "active");
    const taskTitles = new Map<string, string>();
    const items: MentionNotification[] = [];
    for (const comment of comments) {
      const mention = comment.mentions.find((item) => item.person === personId);
      if (mention === undefined || sameActor(comment.author, actor.identity)) continue;
      const taskKey = `${comment.project}:${comment.task}`;
      let taskTitle = taskTitles.get(taskKey);
      if (taskTitle === undefined) {
        try { taskTitle = String((await this.task(metadata, comment.project, comment.task)).title ?? comment.task); }
        catch { taskTitle = comment.task; }
        taskTitles.set(taskKey, taskTitle);
      }
      const excerpt = (comment.body_markdown ?? "").replace(/@\[([^\]]+)\]\(person:U-[^)]+\)/gu, "@$1").replace(/\s+/gu, " ").trim().slice(0, 160);
      items.push({ key: `${comment.id}:${mention.mentioned_at}`, person_id: personId, mentioned_at: mention.mentioned_at, project_id: comment.project, task_id: comment.task, task_title: taskTitle, comment_id: comment.id, author: comment.author, excerpt });
    }
    return { recipient_person_id: personId, items: items.sort((left, right) => right.mentioned_at.localeCompare(left.mentioned_at) || right.key.localeCompare(left.key)) };
  }

  private async assertValid(worktree: string): Promise<void> {
    const report = await validateRepository(worktree);
    if (!report.valid) throw new CommentOperationError("VALIDATION_FAILED", report.errors[0]?.message ?? "Repository validation failed", report.errors);
  }
}
