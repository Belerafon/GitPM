import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { GITPM_GUIDANCE_FILES } from "@gitpm/drafts";
import type { DraftManager, RepositoryMutationMode } from "@gitpm/drafts";
import { GitCommandError, type GitClient } from "@gitpm/git-client";
import { parseYamlDocument, type GitPmDocument } from "@gitpm/repository-format";
import { atomicWriteDomainFile, resolveDomainPath } from "@gitpm/security";
import { projectFileNameInvalidReason, validateRepository } from "@gitpm/validation";

export type ChangeKind = "Added" | "Modified" | "Deleted";

export interface FileChange {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly diff: string;
  readonly diff_token: string;
  readonly hunks: readonly DiffHunk[];
  readonly oversized?: boolean;
}

export type ProjectFileChangeOperation = "Added" | "Modified" | "Replaced" | "Renamed" | "Deleted";
export type ProjectFileContentKind = "text" | "binary" | "unknown";

export interface ProjectFileChange {
  readonly project_id: string;
  readonly path: string;
  readonly name: string;
  readonly operation: ProjectFileChangeOperation;
  readonly content_kind: ProjectFileContentKind;
  readonly previous_path?: string;
  readonly previous_name?: string;
}

export interface DiffHunk {
  readonly old_start: number;
  readonly old_count: number;
  readonly new_start: number;
  readonly new_count: number;
  readonly lines: readonly string[];
}

export interface SemanticFieldChange {
  readonly field: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface SemanticChange {
  readonly path: string;
  readonly id: string;
  readonly schema: string;
  readonly project?: string;
  readonly fields: readonly SemanticFieldChange[];
}

export interface SemanticFileEntity {
  readonly path: string;
  readonly schema: string;
  readonly id?: string;
  readonly display_name?: string;
}

export interface SemanticDiff {
  readonly created: readonly SemanticChange[];
  readonly updated: readonly SemanticChange[];
  readonly archived: readonly SemanticChange[];
  readonly deleted: readonly SemanticChange[];
  readonly counts: Readonly<Record<"created" | "updated" | "archived" | "deleted", number>>;
  readonly affected_projects: readonly string[];
  readonly file_entities?: readonly SemanticFileEntity[];
  readonly unclassified_files: readonly string[];
}

export class ChangesError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ChangesError";
  }
}

function safeRelativePath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (path.isAbsolute(relativePath) || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new ChangesError("CHANGE_PATH_INVALID", "Change path is invalid");
  }
  return normalized;
}

function token(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, operation: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      result[index] = await operation(values[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return result;
}

const MAX_ADDED_TEXT_DIFF_BYTES = 1_048_576;
const TEXT_SAMPLE_BYTES = 8_192;
const ZERO_OID = /^0+$/u;

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size;
}

type TargetState = { readonly present: false } | { readonly present: true; readonly identity: Stats };

interface ChangeSnapshot {
  readonly change: StatusChange;
  readonly original: TargetState & { readonly blob?: string };
}

interface AppliedChange {
  readonly snapshot: ChangeSnapshot;
  current: TargetState;
  mutated: boolean;
}

export interface ChangesServiceOptions {
  readonly beforeApplyEntryForTest?: (path: string, index: number) => Promise<void>;
}

async function currentTargetState(root: string, relativePath: string): Promise<TargetState> {
  const target = await resolveDomainPath(root, relativePath);
  try {
    const identity = await lstat(target);
    if (identity.isSymbolicLink() || !identity.isFile()) throw new ChangesError("CHANGE_TARGET_UNSAFE", "Changed path is not a regular file");
    return { present: true, identity };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false };
    throw error;
  }
}

async function assertTargetState(root: string, relativePath: string, expected: TargetState): Promise<string> {
  const target = await resolveDomainPath(root, relativePath);
  const current = await currentTargetState(root, relativePath);
  if (current.present !== expected.present
    || (current.present && expected.present && !sameIdentity(current.identity, expected.identity))) {
    throw new ChangesError("CHANGE_CHANGED_EXTERNALLY", "Changed file no longer matches the preflight snapshot");
  }
  return target;
}

async function snapshotChange(root: string, git: GitClient, change: StatusChange): Promise<ChangeSnapshot> {
  const relativePath = safeRelativePath(change.path);
  const initial = await currentTargetState(root, relativePath);
  if (change.kind === "Deleted") {
    if (initial.present) throw new ChangesError("CHANGE_CHANGED_EXTERNALLY", "Deleted file unexpectedly exists");
    return { change: { ...change, path: relativePath }, original: initial };
  }
  if (!initial.present) throw new ChangesError("CHANGE_CHANGED_EXTERNALLY", "Changed file is no longer present");
  const target = await resolveDomainPath(root, relativePath);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(initial.identity, opened)) {
      throw new ChangesError("CHANGE_CHANGED_EXTERNALLY", "Changed file changed while it was opened");
    }
    const blob = await git.storeBlob(root, handle.createReadStream({ autoClose: false, start: 0 }));
    const afterRead = await handle.stat();
    const afterPath = await currentTargetState(root, relativePath);
    if (!afterPath.present || !sameIdentity(opened, afterRead) || !sameIdentity(opened, afterPath.identity)) {
      throw new ChangesError("CHANGE_CHANGED_EXTERNALLY", "Changed file changed while it was snapshotted");
    }
    return { change: { ...change, path: relativePath }, original: { present: true, identity: opened, blob } };
  } finally {
    await handle.close();
  }
}

async function removeExpectedTarget(root: string, relativePath: string, expected: TargetState): Promise<void> {
  if (!expected.present) {
    await assertTargetState(root, relativePath, expected);
    return;
  }
  const target = await assertTargetState(root, relativePath, expected);
  const parent = path.dirname(target);
  const canonicalParent = await realpath(parent);
  await assertTargetState(root, relativePath, expected);
  if (await realpath(parent) !== canonicalParent) throw new ChangesError("CHANGE_PARENT_CHANGED", "Changed file parent changed during mutation");
  await rm(target);
}

async function publishBlob(
  root: string,
  git: GitClient,
  relativePath: string,
  objectId: string,
  expected: TargetState,
  applied: AppliedChange,
): Promise<void> {
  const target = await assertTargetState(root, relativePath, expected);
  const parent = path.dirname(target);
  const canonicalParent = await realpath(parent);
  const temporary = path.join(parent, `.gitpm-change-${randomUUID()}.tmp`);
  let temporaryIdentity: Stats | undefined;
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await git.streamBlob(root, objectId, async (chunk) => {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await handle.write(chunk, offset, chunk.byteLength - offset);
          if (result.bytesWritten === 0) throw new ChangesError("CHANGE_WRITE_FAILED", "Staged change write made no progress");
          offset += result.bytesWritten;
        }
      });
      await handle.sync();
      temporaryIdentity = await handle.stat();
      if (!temporaryIdentity.isFile()) throw new ChangesError("CHANGE_TARGET_UNSAFE", "Staged change is not a regular file");
    } finally {
      await handle.close();
    }
    if (await realpath(parent) !== canonicalParent) throw new ChangesError("CHANGE_PARENT_CHANGED", "Changed file parent changed during mutation");
    await assertTargetState(root, relativePath, expected);
    applied.mutated = true;
    if (expected.present) {
      await rm(target);
      applied.current = { present: false };
    }
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ChangesError("CHANGE_CHANGED_EXTERNALLY", "Changed file appeared during mutation");
      }
      throw error;
    }
    const published = await lstat(target);
    if (temporaryIdentity === undefined || !sameInode(temporaryIdentity, published)) {
      throw new ChangesError("CHANGE_CHANGED_EXTERNALLY", "Staged change changed during publication");
    }
    applied.current = { present: true, identity: published };
  } finally {
    if (temporaryIdentity !== undefined) {
      try {
        const current = await lstat(temporary);
        if (sameInode(current, temporaryIdentity)) await rm(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // A changed temporary path is left untouched. It is outside business scope.
        }
      }
    }
  }
}

function addedFileDiff(relativePath: string, content: string): string {
  const normalized = content.replaceAll("\r\n", "\n");
  const lines = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
  if (lines.length === 1 && lines[0] === "") return `diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relativePath}\n`;
  return `diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relativePath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
}

function binaryDiffPlaceholder(relativePath: string, beforePath = "/dev/null"): string {
  const before = beforePath === "/dev/null" ? beforePath : `a/${beforePath}`;
  return `diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\nBinary files ${before} and b/${relativePath} differ\n`;
}

function oversizedDiffPlaceholder(relativePath: string): string {
  return `diff --git a/${relativePath} b/${relativePath}\n--- a/${relativePath}\n+++ b/${relativePath}\n`;
}

function oversizedAddedDiffPlaceholder(relativePath: string): string {
  return `diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relativePath}\n`;
}

function documentIdentity(document: GitPmDocument): { id: string; schema: string; project?: string } | undefined {
  const id = document.id;
  if (typeof id !== "string") return undefined;
  const project = typeof document.project === "string"
    ? document.project
    : document.schema === "gitpm/project@2" ? id : undefined;
  return { id, schema: document.schema, ...(project === undefined ? {} : { project }) };
}

function documentDisplayName(document: GitPmDocument): string | undefined {
  const value = typeof document.title === "string" ? document.title : typeof document.name === "string" ? document.name : undefined;
  if (value === undefined) return undefined;
  const displayName = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return displayName === "" ? undefined : displayName;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nestedLeafChanges(path: string, before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): SemanticFieldChange[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changes: SemanticFieldChange[] = [];
  for (const key of [...keys].sort()) {
    const beforeValue = before?.[key];
    const afterValue = after?.[key];
    if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) continue;
    const fieldPath = `${path}.${key}`;
    if (isPlainObject(beforeValue) && isPlainObject(afterValue)) {
      changes.push(...nestedLeafChanges(fieldPath, beforeValue, afterValue));
    } else {
      changes.push({ field: fieldPath, ...(beforeValue === undefined ? {} : { before: beforeValue }), ...(afterValue === undefined ? {} : { after: afterValue }) });
    }
  }
  return changes;
}

function fieldChanges(before: GitPmDocument | undefined, after: GitPmDocument | undefined): SemanticFieldChange[] {
  const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  fields.delete("schema");
  fields.delete("id");
  const changes: SemanticFieldChange[] = [];
  for (const field of [...fields].sort()) {
    const beforeValue = before?.[field];
    const afterValue = after?.[field];
    if (JSON.stringify(beforeValue) === JSON.stringify(afterValue)) continue;
    if (isPlainObject(beforeValue) && isPlainObject(afterValue)) {
      changes.push(...nestedLeafChanges(field, beforeValue, afterValue));
    } else {
      changes.push({ field, ...(beforeValue === undefined ? {} : { before: beforeValue }), ...(afterValue === undefined ? {} : { after: afterValue }) });
    }
  }
  return changes;
}

function relocationFields(deleted: SemanticChange, created: SemanticChange): SemanticFieldChange[] {
  const before = new Map(deleted.fields.map((field) => [field.field, field.before]));
  const after = new Map(created.fields.map((field) => [field.field, field.after]));
  const fields = new Set([...before.keys(), ...after.keys()]);
  return [...fields].sort().flatMap((field) => {
    const beforeValue = before.get(field);
    const afterValue = after.get(field);
    return JSON.stringify(beforeValue) === JSON.stringify(afterValue) ? [] : [{ field, ...(beforeValue === undefined ? {} : { before: beforeValue }), ...(afterValue === undefined ? {} : { after: afterValue }) }];
  });
}

export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const lines = diff.replaceAll("\r\n", "\n").split("\n");
  const hunks: DiffHunk[] = [];
  let current: { old_start: number; old_count: number; new_start: number; new_count: number; lines: string[] } | undefined;
  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (match) {
      if (current) hunks.push(current);
      current = {
        old_start: Number(match[1]),
        old_count: Number(match[2] ?? "1"),
        new_start: Number(match[3]),
        new_count: Number(match[4] ?? "1"),
        lines: [],
      };
    } else if (current && (/^[ +\-]/u.test(line) || line === "\\ No newline at end of file")) {
      current.lines.push(line);
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

function applyReverseHunk(currentText: string, hunk: DiffHunk): string {
  const trailingNewline = currentText.endsWith("\n");
  const currentLines = (trailingNewline ? currentText.slice(0, -1) : currentText).split("\n");
  const oldSegment = hunk.lines.filter((line) => !line.startsWith("+") && !line.startsWith("\\"))
    .map((line) => line.slice(1));
  const newSegment = hunk.lines.filter((line) => !line.startsWith("-") && !line.startsWith("\\"))
    .map((line) => line.slice(1));
  const offset = hunk.new_start - 1;
  const actual = currentLines.slice(offset, offset + hunk.new_count);
  if (actual.length !== newSegment.length || actual.some((line, index) => line !== newSegment[index])) {
    throw new ChangesError("STALE_DIFF", "Selected hunk no longer matches current content");
  }
  currentLines.splice(offset, hunk.new_count, ...oldSegment);
  return `${currentLines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

interface StatusChange {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly head_oid?: string;
}

interface StatusRename {
  readonly path: string;
  readonly original_path: string;
}

function parseStatus(status: string): { changes: StatusChange[]; renames: StatusRename[] } {
  const result: StatusChange[] = [];
  const renames: StatusRename[] = [];
  const records = status.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.startsWith("? ")) {
      result.push({ path: record.slice(2), kind: "Added" });
    } else if (record.startsWith("1 ")) {
      const fields = record.split(" ");
      const xy = fields[1] ?? "";
      const changedPath = fields.slice(8).join(" ");
      const headOid = fields[6];
      result.push({ path: changedPath, kind: xy.includes("D") ? "Deleted" : xy.includes("A") ? "Added" : "Modified", ...(headOid === undefined || ZERO_OID.test(headOid) ? {} : { head_oid: headOid }) });
    } else if (record.startsWith("2 ")) {
      const fields = record.split(" ");
      const changedPath = fields.slice(9).join(" ");
      const originalPath = records[index + 1];
      if (originalPath) {
        const headOid = fields[6];
        result.push(
          { path: originalPath, kind: "Deleted", ...(headOid === undefined || ZERO_OID.test(headOid) ? {} : { head_oid: headOid }) },
          { path: changedPath, kind: "Added" },
        );
        renames.push({ path: changedPath, original_path: originalPath });
        index += 1;
      }
    }
  }
  return { changes: result, renames };
}

function canonicalProjectFile(relativePath: string): { projectId: string; name: string } | undefined {
  const match = /^projects\/(P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6})\/files\/([^/]+)$/u.exec(relativePath);
  if (match?.[1] === undefined || match[2] === undefined || projectFileNameInvalidReason(match[2]) !== undefined) return undefined;
  return { projectId: match[1], name: match[2] };
}

function bytesLookText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

async function inspectWorkingFile(root: string, relativePath: string): Promise<{ kind: ProjectFileContentKind; text?: string }> {
  const absolute = await resolveDomainPath(root, relativePath);
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const identity = await handle.stat();
    if (!identity.isFile()) return { kind: "unknown" };
    const sampleLength = Math.min(identity.size, TEXT_SAMPLE_BYTES);
    const sample = Buffer.alloc(sampleLength);
    if (sampleLength > 0) await handle.read(sample, 0, sampleLength, 0);
    if (!bytesLookText(sample)) return { kind: "binary" };
    if (identity.size > MAX_ADDED_TEXT_DIFF_BYTES) return { kind: "unknown" };
    const bytes = Buffer.alloc(identity.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== bytes.length || !bytesLookText(bytes)) return { kind: "unknown" };
    return { kind: "text", text: bytes.toString("utf8") };
  } finally {
    await handle.close();
  }
}

export class ChangesService {
  constructor(
    private readonly drafts: DraftManager,
    private readonly git: GitClient,
    private readonly options: ChangesServiceOptions = {},
  ) {}

  private async restoreStatusChanges(
    root: string,
    status: readonly StatusChange[],
  ): Promise<{ readonly validation: Awaited<ReturnType<typeof validateRepository>> }> {
    for (const change of status) {
      safeRelativePath(change.path);
      if (change.kind !== "Added" && change.head_oid === undefined) {
        throw new ChangesError("HEAD_FILE_MISSING", "HEAD blob is unavailable for a tracked change");
      }
    }
    const snapshots: ChangeSnapshot[] = [];
    for (const change of status) snapshots.push(await snapshotChange(root, this.git, change));
    const applied: AppliedChange[] = [];
    try {
      for (const [index, snapshot] of snapshots.entries()) {
        await this.options.beforeApplyEntryForTest?.(snapshot.change.path, index);
        const entry: AppliedChange = { snapshot, current: snapshot.original, mutated: false };
        applied.push(entry);
        if (snapshot.change.kind === "Added") {
          await removeExpectedTarget(root, snapshot.change.path, entry.current);
          entry.current = { present: false };
          entry.mutated = true;
        } else {
          await publishBlob(root, this.git, snapshot.change.path, snapshot.change.head_oid!, entry.current, entry);
          const refreshed = await currentTargetState(root, snapshot.change.path);
          if (!refreshed.present) throw new ChangesError("CHANGE_CHANGED_EXTERNALLY", "Restored file disappeared after publication");
          entry.current = refreshed;
        }
      }
      const validation = await validateRepository(root);
      if (!validation.valid) {
        throw new ChangesError("VALIDATION_FAILED", validation.errors[0]?.message ?? "Restored files do not form a valid repository");
      }
      return { validation };
    } catch (error) {
      let rollbackFailed = false;
      for (const entry of [...applied].reverse()) {
        if (!entry.mutated) continue;
        try {
          const original = entry.snapshot.original;
          if (original.present) {
            if (original.blob === undefined) throw new ChangesError("CHANGE_ROLLBACK_FAILED", "Rollback blob is unavailable");
            await publishBlob(root, this.git, entry.snapshot.change.path, original.blob, entry.current, entry);
          } else {
            await removeExpectedTarget(root, entry.snapshot.change.path, entry.current);
            entry.current = { present: false };
          }
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed) throw new ChangesError("CHANGE_ROLLBACK_FAILED", "Changes rollback could not be completed safely");
      throw error;
    }
  }

  async list(draftId: string): Promise<{ files: readonly FileChange[]; changed_files_count: number; affected_projects: readonly string[]; project_files: readonly ProjectFileChange[] }> {
    const metadata = await this.drafts.getWorkspace(draftId);
    const parsedStatus = parseStatus(await this.git.statusPorcelainZ(metadata.worktree_path));
    const status = parsedStatus.changes.filter((change) => !GITPM_GUIDANCE_FILES.has(change.path));
    const batchPaths = new Set(status.filter((change) => change.kind !== "Added" && /^[A-Za-z0-9._/-]+$/u.test(change.path)).map((change) => change.path));
    const batchDiffs = await this.git.diffFiles(metadata.worktree_path, [...batchPaths], 1);
    const workingContentKinds = new Map<string, ProjectFileContentKind>();
    const files = await mapConcurrent(status, 16, async (change): Promise<FileChange> => {
      const relative = safeRelativePath(change.path);
      let diff: string;
      let oversized = false;
      if (change.kind === "Added") {
        let inspected: Awaited<ReturnType<typeof inspectWorkingFile>>;
        try {
          inspected = await inspectWorkingFile(metadata.worktree_path, relative);
        } catch {
          inspected = { kind: "unknown" };
        }
        workingContentKinds.set(relative, inspected.kind);
        if (inspected.kind === "binary") diff = binaryDiffPlaceholder(relative);
        else if (inspected.text !== undefined) diff = addedFileDiff(relative, inspected.text);
        else { diff = oversizedAddedDiffPlaceholder(relative); oversized = true; }
      } else if (batchPaths.has(relative)) {
        const fromBatch = batchDiffs.get(relative);
        if (fromBatch === undefined) { diff = oversizedDiffPlaceholder(relative); oversized = true; }
        else diff = fromBatch;
      } else {
        try {
          diff = await this.git.diffFile(metadata.worktree_path, relative, 1);
        } catch (error) {
          if (error instanceof GitCommandError && error.code === "GIT_OUTPUT_LIMIT") { diff = oversizedDiffPlaceholder(relative); oversized = true; }
          else throw error;
        }
      }
      return { path: relative, kind: change.kind, diff, diff_token: token(diff), hunks: parseUnifiedDiff(diff), ...(oversized ? { oversized: true } : {}) };
    });

    const explicitRenames = new Map(parsedStatus.renames.flatMap((rename) => {
      const current = canonicalProjectFile(rename.path);
      const original = canonicalProjectFile(rename.original_path);
      return current !== undefined && original?.projectId === current.projectId ? [[rename.path, rename.original_path] as const] : [];
    }));
    const deletedByBlob = new Map<string, StatusChange[]>();
    const projectsWithDeletedFiles = new Set<string>();
    for (const change of status) {
      const projectFile = canonicalProjectFile(change.path);
      if (change.kind !== "Deleted" || change.head_oid === undefined || projectFile === undefined) continue;
      projectsWithDeletedFiles.add(projectFile.projectId);
      const key = `${projectFile.projectId}:${change.head_oid}`;
      const candidates = deletedByBlob.get(key) ?? [];
      candidates.push(change);
      deletedByBlob.set(key, candidates);
    }
    const addedProjectPaths = status.filter((change) => {
      const projectFile = change.kind === "Added" ? canonicalProjectFile(change.path) : undefined;
      return projectFile !== undefined && projectsWithDeletedFiles.has(projectFile.projectId);
    }).map((change) => change.path);
    const addedBlobIds = new Map<string, string>();
    await mapConcurrent(addedProjectPaths, 8, async (addedPath) => {
      try {
        const digest = (await this.git.hashFiles(metadata.worktree_path, [addedPath])).get(addedPath);
        if (digest !== undefined) addedBlobIds.set(addedPath, digest);
      } catch {
        // Invalid or externally changing entries remain separate add/delete records and
        // are surfaced by repository validation instead of breaking the Changes view.
      }
    });
    const addedByBlob = new Map<string, string[]>();
    for (const addedPath of addedProjectPaths) {
      const blob = addedBlobIds.get(addedPath);
      if (blob === undefined) continue;
      const projectFile = canonicalProjectFile(addedPath)!;
      const key = `${projectFile.projectId}:${blob}`;
      const candidates = addedByBlob.get(key) ?? [];
      candidates.push(addedPath);
      addedByBlob.set(key, candidates);
    }
    for (const [blob, addedPaths] of addedByBlob) {
      const deleted = deletedByBlob.get(blob) ?? [];
      if (addedPaths.length === 1 && deleted.length === 1 && explicitRenames.get(addedPaths[0]!) === undefined) {
        explicitRenames.set(addedPaths[0]!, deleted[0]!.path);
      }
    }

    const renamedOldPaths = new Set(explicitRenames.values());
    const projectFiles: ProjectFileChange[] = [];
    for (const change of status) {
      const current = canonicalProjectFile(change.path);
      if (current === undefined) continue;
      if (change.kind === "Deleted" && renamedOldPaths.has(change.path)) continue;
      let contentKind: ProjectFileContentKind = "unknown";
      const file = files.find((candidate) => candidate.path === change.path);
      if (file?.diff.includes("Binary files ")) {
        contentKind = "binary";
      } else if (change.kind !== "Deleted") {
        const inspected = workingContentKinds.get(change.path);
        if (inspected !== undefined) contentKind = inspected;
        else {
          try { contentKind = (await inspectWorkingFile(metadata.worktree_path, change.path)).kind; }
          catch { contentKind = "unknown"; }
        }
      } else if (file?.oversized !== true) {
        contentKind = "text";
      }
      const originalPath = explicitRenames.get(change.path);
      const original = originalPath === undefined ? undefined : canonicalProjectFile(originalPath);
      const operation: ProjectFileChangeOperation = original !== undefined
        ? "Renamed"
        : change.kind === "Added" ? "Added"
          : change.kind === "Deleted" ? "Deleted"
            : contentKind === "binary" ? "Replaced" : "Modified";
      projectFiles.push({
        project_id: current.projectId,
        path: change.path,
        name: current.name,
        operation,
        content_kind: contentKind,
        ...(originalPath === undefined ? {} : { previous_path: originalPath }),
        ...(original === undefined ? {} : { previous_name: original.name }),
      });
    }
    const affected = new Set<string>();
    for (const file of files) {
      const match = /^projects\/(P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6})/u.exec(file.path);
      if (match?.[1]) affected.add(match[1]);
    }
    return {
      files,
      changed_files_count: files.length,
      affected_projects: [...affected].sort(),
      project_files: projectFiles.sort((left, right) => left.project_id.localeCompare(right.project_id) || left.path.localeCompare(right.path)),
    };
  }

  async semantic(draftId: string): Promise<SemanticDiff> {
    const metadata = await this.drafts.getWorkspace(draftId);
    const changes = await this.list(draftId);
    const result: { created: SemanticChange[]; updated: SemanticChange[]; archived: SemanticChange[]; deleted: SemanticChange[] } = {
      created: [], updated: [], archived: [], deleted: [],
    };
    const affectedProjects = new Set<string>();
    const fileEntities: SemanticFileEntity[] = [];
    const unclassifiedFiles: string[] = [];
    const headPaths = changes.files.filter((change) => change.kind !== "Added").map((change) => change.path);
    const headFiles = await this.git.showHeadFiles(metadata.worktree_path, headPaths);
    const projectFilePaths = new Set(changes.project_files.flatMap((change) => [change.path, ...(change.previous_path === undefined ? [] : [change.previous_path])]));
    const classified = await mapConcurrent(changes.files, 16, async (change) => {
      if (projectFilePaths.has(change.path)) return { path: change.path, projectFile: true };
      try {
        const beforeText = change.kind === "Added" ? undefined : headFiles.get(change.path);
        if (change.kind !== "Added" && beforeText === undefined) throw new ChangesError("HEAD_FILE_MISSING", "HEAD file is unavailable");
        const before = beforeText === undefined ? undefined : parseYamlDocument(beforeText, change.path);
        const after = change.kind === "Deleted" ? undefined : parseYamlDocument(await readFile(await resolveDomainPath(metadata.worktree_path, change.path), "utf8"), change.path);
        const document = after ?? before!;
        const displayName = documentDisplayName(document);
        const fileEntity: SemanticFileEntity = {
          path: change.path,
          schema: document.schema,
          ...(typeof document.id === "string" ? { id: document.id } : {}),
          ...(displayName === undefined ? {} : { display_name: displayName }),
        };
        const identity = documentIdentity(document);
        if (!identity) return { path: change.path, fileEntity };
        const item: SemanticChange = { path: change.path, ...identity, fields: fieldChanges(before, after) };
        const group: keyof typeof result = change.kind === "Added" ? "created" : change.kind === "Deleted" ? "deleted" : before?.lifecycle !== "archived" && after?.lifecycle === "archived" ? "archived" : "updated";
        if (group === "updated" && item.fields.length === 0) return { path: change.path, fileEntity };
        return { path: change.path, project: identity.project, fileEntity, item, group };
      } catch {
        return { path: change.path };
      }
    });
    for (const classifiedChange of classified) {
      if (classifiedChange.fileEntity !== undefined) fileEntities.push(classifiedChange.fileEntity);
      else if (!classifiedChange.projectFile) unclassifiedFiles.push(classifiedChange.path);
      if (classifiedChange.item && classifiedChange.group) {
        if (classifiedChange.project !== undefined) affectedProjects.add(classifiedChange.project);
        result[classifiedChange.group].push(classifiedChange.item);
      }
    }
    for (let createdIndex = result.created.length - 1; createdIndex >= 0; createdIndex -= 1) {
      const created = result.created[createdIndex]!;
      const deletedIndex = result.deleted.findIndex((deleted) => deleted.id === created.id && deleted.schema === created.schema);
      if (deletedIndex === -1) continue;
      const deleted = result.deleted[deletedIndex]!;
      result.created.splice(createdIndex, 1);
      result.deleted.splice(deletedIndex, 1);
      result.updated.push({ ...created, fields: relocationFields(deleted, created) });
    }
    return {
      ...result,
      counts: {
        created: result.created.length,
        updated: result.updated.length,
        archived: result.archived.length,
        deleted: result.deleted.length,
      },
      affected_projects: [...affectedProjects].sort(),
      file_entities: fileEntities.sort((left, right) => left.path.localeCompare(right.path)),
      unclassified_files: unclassifiedFiles.sort(),
    };
  }

  async restoreFile(
    draftId: string,
    owner: string,
    expectedFingerprint: string,
    relativePath: string,
    mutationMode: RepositoryMutationMode = "ui",
  ) {
    const safePath = safeRelativePath(relativePath);
    return await this.drafts.withRepositoryMutation(draftId, owner, expectedFingerprint, mutationMode, async (metadata) => {
      const status = parseStatus(await this.git.statusPorcelainZ(metadata.worktree_path)).changes
        .filter((change) => !GITPM_GUIDANCE_FILES.has(change.path));
      const change = status.find((candidate) => candidate.path === safePath);
      if (change === undefined) throw new ChangesError("CHANGE_NOT_FOUND", "Changed file no longer exists in the draft");
      if (change.kind === "Added") throw new ChangesError("HEAD_FILE_MISSING", "Added file has no HEAD version to restore");
      const restored = await this.restoreStatusChanges(metadata.worktree_path, [change]);
      return { path: safePath, validation: restored.validation };
    });
  }

  async restoreHunk(
    draftId: string,
    owner: string,
    expectedFingerprint: string,
    relativePath: string,
    expectedDiffToken: string,
    hunkIndex: number,
    mutationMode: RepositoryMutationMode = "ui",
  ) {
    const safePath = safeRelativePath(relativePath);
    return await this.drafts.withRepositoryMutation(draftId, owner, expectedFingerprint, mutationMode, async (metadata) => {
      const status = parseStatus(await this.git.statusPorcelainZ(metadata.worktree_path)).changes
        .filter((change) => !GITPM_GUIDANCE_FILES.has(change.path));
      const change = status.find((candidate) => candidate.path === safePath);
      if (change?.kind !== "Modified") throw new ChangesError("HUNK_NOT_FOUND", "Only modified text files support hunk restore");
      let inspected: Awaited<ReturnType<typeof inspectWorkingFile>>;
      try { inspected = await inspectWorkingFile(metadata.worktree_path, safePath); }
      catch { throw new ChangesError("HUNK_NOT_FOUND", "Only modified text files support hunk restore"); }
      if (inspected.kind !== "text") throw new ChangesError("HUNK_NOT_FOUND", "Only modified text files support hunk restore");
      const diff = await this.git.diffFile(metadata.worktree_path, safePath, 1);
      if (token(diff) !== expectedDiffToken) throw new ChangesError("STALE_DIFF", "Diff changed after it was displayed");
      const hunk = parseUnifiedDiff(diff)[hunkIndex];
      if (!hunk) throw new ChangesError("HUNK_NOT_FOUND", "Selected hunk does not exist");
      const absolute = await resolveDomainPath(metadata.worktree_path, safePath);
      const restored = applyReverseHunk(await readFile(absolute, "utf8"), hunk);
      await atomicWriteDomainFile(metadata.worktree_path, safePath, restored);
      return { path: safePath, validation: await validateRepository(metadata.worktree_path) };
    });
  }

  async discardAll(
    draftId: string,
    owner: string,
    expectedFingerprint: string,
    mutationMode: RepositoryMutationMode = "ui",
  ) {
    const mutation = await this.drafts.withRepositoryMutation(draftId, owner, expectedFingerprint, mutationMode, async (metadata) => {
      const status = parseStatus(await this.git.statusPorcelainZ(metadata.worktree_path)).changes
        .filter((change) => !GITPM_GUIDANCE_FILES.has(change.path));
      await this.restoreStatusChanges(metadata.worktree_path, status);
      return { discarded: status.length };
    });
    return { discarded: mutation.result.discarded, draft_fingerprint: mutation.metadata.fingerprint };
  }
}
