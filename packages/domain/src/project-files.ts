import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type {
  ProjectFileDeleteResult,
  ProjectFileItem,
  ProjectFileList,
  ProjectFileDeleteReferenceMode,
  ProjectFileReferenceLocation,
  ProjectFileReferencePreview,
  ProjectFileReplaceResult,
  ProjectFileReferencesChecked,
  ProjectFileRenameReferenceMode,
  ProjectFileRenameResult,
  ProjectFileUploadResult,
} from "@gitpm/contracts";
import type { DraftManager, DraftMetadata, RepositoryWorkspace } from "@gitpm/drafts";
import { formatYamlDocument, parseYamlDocument, referenceLabelsForDocuments, type GitPmDocument } from "@gitpm/repository-format";
import { atomicWriteDomainFile, resolveDomainPath, SecurityBoundaryError } from "@gitpm/security";
import { ENTITY_ID_PREFIX, formatProjectFileReference, isEntityId } from "@gitpm/shared";
import { discoverRepositoryFiles, projectFileNameComparisonKey, projectFileNameInvalidReason, validateRepository } from "@gitpm/validation";
import { searchProjectFileReferences } from "./project-file-reference-search.js";

export class ProjectFileOperationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProjectFileOperationError";
  }
}

export interface OpenProjectFile {
  readonly item: ProjectFileItem;
  readonly handle: FileHandle;
}

export const PROJECT_FILE_LARGE_THRESHOLD_BYTES = 50 * 1024 * 1024;
export const DEFAULT_PROJECT_FILE_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export interface ProjectFileUploadInput {
  readonly name: string;
  readonly sizeBytes: number;
  readonly mode: "create" | "replace";
  readonly referenceMode?: "preserve_checked" | "ignore_unchecked";
  readonly largeFileConfirmation?: string;
  readonly content: AsyncIterable<Uint8Array>;
}

export interface ProjectFileReplaceInput {
  readonly name: string;
  readonly sizeBytes: number;
  readonly largeFileConfirmation?: string;
  readonly content: AsyncIterable<Uint8Array>;
}

export interface ProjectFileStoreOptions {
  readonly maxUploadBytes?: number;
  readonly beforeFinalizeForTest?: () => Promise<void>;
  readonly beforeRenameForTest?: () => Promise<void>;
  readonly beforeDeleteForTest?: () => Promise<void>;
  readonly beforeValidationForTest?: (operation: "rename" | "delete" | "replace") => Promise<void>;
  readonly beforeReferenceWriteForTest?: () => Promise<void>;
  readonly afterReferenceWriteForTest?: () => Promise<void>;
  readonly beforeReferenceRecoveryWriteForTest?: () => Promise<void>;
}

interface DirectorySnapshot {
  readonly path: string;
  readonly canonicalPath: string;
  readonly dev: number;
  readonly ino: number;
}

interface LoadedDocument {
  readonly absolute: string;
  readonly relative: string;
  readonly original: string;
  readonly identity: Stats;
  readonly document: GitPmDocument;
}

interface WrittenDocument {
  readonly relative: string;
  readonly original: string;
  readonly written: string;
  readonly identity: Stats;
}

const INLINE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

const ATTACHMENT_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

export function projectFilePresentation(name: string): Pick<ProjectFileItem, "media_type" | "disposition"> {
  const extension = path.extname(name).toLocaleLowerCase("en-US");
  const inline = INLINE_MEDIA_TYPES[extension];
  if (inline !== undefined) return { media_type: inline, disposition: "inline" };
  return {
    media_type: ATTACHMENT_MEDIA_TYPES[extension] ?? "application/octet-stream",
    disposition: "attachment",
  };
}

function normalize(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function filesystemError(error: unknown, notFoundCode: string, notFoundMessage: string): never {
  if (error instanceof ProjectFileOperationError) throw error;
  if (error instanceof SecurityBoundaryError) {
    throw new ProjectFileOperationError("PROJECT_FILE_PATH_FORBIDDEN", "Project file path is outside the Project storage boundary");
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") throw new ProjectFileOperationError(notFoundCode, notFoundMessage);
  if (code === "EACCES" || code === "EPERM" || code === "ELOOP") {
    throw new ProjectFileOperationError("PROJECT_FILE_PATH_FORBIDDEN", "Project file path cannot be read safely");
  }
  throw error;
}

function assertProjectId(projectId: string): void {
  if (!isEntityId(projectId, ENTITY_ID_PREFIX.project)) {
    throw new ProjectFileOperationError("ENTITY_PROJECT_INVALID", "Project ID is invalid");
  }
}

async function assertProject(metadata: RepositoryWorkspace, projectId: string): Promise<void> {
  assertProjectId(projectId);
  const relative = `projects/${projectId}/project.yaml`;
  let document;
  try {
    const absolute = await resolveDomainPath(metadata.worktree_path, relative);
    document = parseYamlDocument(await readFile(absolute, "utf8"), relative);
  } catch (error) {
    filesystemError(error, "ENTITY_NOT_FOUND", `projects/${projectId} not found`);
  }
  if (document.schema !== "gitpm/project@2" || document.id !== projectId) {
    throw new ProjectFileOperationError("ENTITY_NOT_FOUND", `projects/${projectId} not found`);
  }
}

function assertFileName(name: string): void {
  const reason = projectFileNameInvalidReason(name);
  if (reason !== undefined) {
    throw new ProjectFileOperationError("PROJECT_FILE_NAME_INVALID", `Project file name is invalid (${reason})`);
  }
}

function itemFromStat(projectId: string, name: string, stat: Stats): ProjectFileItem {
  const createdAt = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
    ? { created_at: stat.birthtime.toISOString(), created_at_source: "working_copy_filesystem" as const }
    : {};
  return {
    name,
    path: normalize(path.join("projects", projectId, "files", name)),
    size_bytes: stat.size,
    modified_at: stat.mtime.toISOString(),
    modified_at_source: "working_copy_filesystem",
    ...createdAt,
    ...projectFilePresentation(name),
  };
}

function sameIdentity(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ProjectFileOperationError("PROJECT_FILE_PATH_FORBIDDEN", "Project file path is outside the Project storage boundary");
  }
}

async function directorySnapshot(directory: string): Promise<DirectorySnapshot> {
  try {
    const before = await lstat(directory);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new ProjectFileOperationError("PROJECT_FILE_PATH_FORBIDDEN", "Project file directory is not a safe directory");
    }
    const canonicalPath = await realpath(directory);
    const after = await lstat(directory);
    if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(before, after)) {
      throw new ProjectFileOperationError("PROJECT_FILE_PATH_FORBIDDEN", "Project file directory changed during the operation");
    }
    return { path: directory, canonicalPath, dev: after.dev, ino: after.ino };
  } catch (error) {
    filesystemError(error, "PROJECT_FILES_NOT_FOUND", "Project file directory does not exist");
  }
}

async function assertDirectoryUnchanged(snapshot: DirectorySnapshot): Promise<void> {
  try {
    const before = await lstat(snapshot.path);
    const canonicalPath = await realpath(snapshot.path);
    const after = await lstat(snapshot.path);
    if (before.isSymbolicLink() || !before.isDirectory() || after.isSymbolicLink() || !after.isDirectory()
      || canonicalPath !== snapshot.canonicalPath || !sameIdentity(before, after)
      || !sameIdentity(after, { dev: snapshot.dev, ino: snapshot.ino })) {
      throw new ProjectFileOperationError("PROJECT_FILE_PATH_FORBIDDEN", "Project file directory changed during the operation");
    }
  } catch (error) {
    filesystemError(error, "PROJECT_FILES_NOT_FOUND", "Project file directory does not exist");
  }
}

async function existingFilesDirectorySnapshot(directory: string, name: string): Promise<DirectorySnapshot> {
  try {
    return await directorySnapshot(directory);
  } catch (error) {
    if (error instanceof ProjectFileOperationError && error.code === "PROJECT_FILES_NOT_FOUND") {
      throw new ProjectFileOperationError("PROJECT_FILE_NOT_FOUND", `Project file ${name} does not exist`);
    }
    throw error;
  }
}

async function existingRegularFile(target: string): Promise<Stats | undefined> {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      throw new ProjectFileOperationError("PROJECT_FILE_PATH_FORBIDDEN", "Project file target must not be a symbolic link");
    }
    if (!stat.isFile()) {
      throw new ProjectFileOperationError("PROJECT_FILE_NOT_REGULAR", "Project file target is not a regular file");
    }
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    filesystemError(error, "PROJECT_FILE_NOT_FOUND", "Project file does not exist");
  }
}

async function regularFileDigest(target: string): Promise<{ readonly identity: Stats; readonly digest: string }> {
  let handle: FileHandle;
  try { handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { filesystemError(error, "PROJECT_FILE_NOT_FOUND", "Project file does not exist"); }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new ProjectFileOperationError("PROJECT_FILE_NOT_REGULAR", "Project file target is not a regular file");
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk);
    const after = await handle.stat();
    if (!sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file changed while its content was verified");
    }
    return { identity: after, digest: hash.digest("hex") };
  } finally { await handle.close(); }
}

async function regularFileNames(directory: string): Promise<Map<string, string>> {
  const namesByKey = new Map<string, string>();
  for (const name of await readdir(directory)) {
    assertFileName(name);
    const entry = await lstat(path.join(directory, name));
    if (entry.isSymbolicLink()) {
      throw new ProjectFileOperationError("PROJECT_FILE_PATH_FORBIDDEN", "Project files directory contains a symbolic link");
    }
    if (!entry.isFile()) {
      throw new ProjectFileOperationError("PROJECT_FILES_LAYOUT_INVALID", "Project files directory contains a non-regular file");
    }
    const key = projectFileNameComparisonKey(name);
    if (namesByKey.has(key)) {
      throw new ProjectFileOperationError("PROJECT_FILES_LAYOUT_INVALID", "Project files directory contains a case-insensitive name conflict");
    }
    namesByKey.set(key, name);
  }
  return namesByKey;
}

function assertRenameReferenceMode(mode: ProjectFileRenameReferenceMode): void {
  if (mode !== "update" && mode !== "keep" && mode !== "ignore_unchecked") {
    throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_UNSUPPORTED", "Project file rename reference mode is unsupported");
  }
}

function assertDeleteReferenceMode(mode: ProjectFileDeleteReferenceMode): void {
  if (mode !== "restrict" && mode !== "unlink" && mode !== "ignore_unchecked") {
    throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_UNSUPPORTED", "Project file delete reference mode is unsupported");
  }
}

async function loadRepositoryDocuments(root: string): Promise<readonly LoadedDocument[]> {
  const discovery = await discoverRepositoryFiles(root);
  if (discovery.issues.length > 0) {
    const issue = discovery.issues[0]!;
    throw new ProjectFileOperationError(issue.code, issue.message);
  }
  return await Promise.all(discovery.files.map(async (absolute) => {
    const relative = normalize(path.relative(root, absolute));
    const identity = await lstat(absolute);
    if (identity.isSymbolicLink() || !identity.isFile()) throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_CHANGED", "Repository document is not a regular file");
    const original = await readFile(absolute, "utf8");
    const after = await lstat(absolute);
    if (!sameIdentity(identity, after)) throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_CHANGED", "Repository document changed while references were loaded");
    return { absolute, relative, original, identity: after, document: parseYamlDocument(original, relative) };
  }));
}

function replaceAtOffsets(source: string, locations: readonly ProjectFileReferenceLocation[], replacement: string): string {
  let result = source;
  for (const location of [...locations].sort((left, right) => right.start - left.start || right.end - left.end)) {
    result = `${result.slice(0, location.start)}${replacement}${result.slice(location.end)}`;
  }
  return result;
}

function rewriteDocument(
  document: GitPmDocument,
  locations: readonly ProjectFileReferenceLocation[],
  replacement: string,
): GitPmDocument {
  const next = { ...document } as Record<string, unknown>;
  const byField = new Map<string, ProjectFileReferenceLocation[]>();
  for (const location of locations) {
    const key = `${location.field}:${location.value_index ?? ""}`;
    const entries = byField.get(key) ?? [];
    entries.push(location);
    byField.set(key, entries);
  }
  for (const entries of byField.values()) {
    const first = entries[0]!;
    if (first.field === "acceptance_criteria_markdown") {
      const values = Array.isArray(next[first.field]) ? [...next[first.field] as unknown[]] : [];
      const index = first.value_index;
      if (index === undefined || typeof values[index] !== "string") {
        throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_CHANGED", "Project file reference field changed during mutation");
      }
      values[index] = replaceAtOffsets(values[index] as string, entries, replacement);
      next[first.field] = values;
    } else {
      const value = next[first.field];
      if (typeof value !== "string") {
        throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_CHANGED", "Project file reference field changed during mutation");
      }
      next[first.field] = replaceAtOffsets(value, entries, replacement);
    }
  }
  return next as GitPmDocument;
}

async function removeIfSameIdentity(target: string, identity: Stats): Promise<boolean> {
  const current = await existingRegularFile(target);
  if (current === undefined) return true;
  if (!sameIdentity(current, identity)) return false;
  await rm(target);
  return true;
}

async function removeEmptyCreatedDirectory(directory: string, created: boolean): Promise<void> {
  if (!created) return;
  try {
    await rmdir(directory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

async function restoreFromHandle(directory: string, target: string, source: FileHandle, size: number): Promise<void> {
  const temporary = path.join(directory, `.gitpm-project-file-${randomUUID()}.rollback`);
  let identity: Stats | undefined;
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (position < size) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.byteLength, size - position), position);
        if (bytesRead === 0) throw new ProjectFileOperationError("PROJECT_FILE_ROLLBACK_FAILED", "Original Project file ended during rollback");
        await handle.write(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      await handle.sync();
      identity = await handle.stat();
    } finally {
      await handle.close();
    }
    if (await existingRegularFile(target) !== undefined) {
      throw new ProjectFileOperationError("PROJECT_FILE_ROLLBACK_FAILED", "Project file target was occupied during rollback");
    }
    await link(temporary, target);
    const restored = await lstat(target);
    if (identity === undefined || !sameIdentity(identity, restored) || !await removeIfSameIdentity(temporary, identity)) {
      throw new ProjectFileOperationError("PROJECT_FILE_ROLLBACK_FAILED", "Original Project file could not be restored safely");
    }
    identity = undefined;
  } catch (error) {
    if (error instanceof ProjectFileOperationError && error.code === "PROJECT_FILE_ROLLBACK_FAILED") throw error;
    throw new ProjectFileOperationError("PROJECT_FILE_ROLLBACK_FAILED", "Original Project file could not be restored safely");
  } finally {
    if (identity !== undefined) await removeIfSameIdentity(temporary, identity);
  }
}

export class ProjectFileStore {
  private readonly maxUploadBytes: number;

  constructor(private readonly drafts: DraftManager, private readonly options: ProjectFileStoreOptions = {}) {
    this.maxUploadBytes = options.maxUploadBytes ?? DEFAULT_PROJECT_FILE_MAX_UPLOAD_BYTES;
  }

  private async workspace(draftId: string, projectId: string): Promise<RepositoryWorkspace> {
    const metadata = await this.drafts.getWorkspace(draftId);
    await assertProject(metadata, projectId);
    return metadata;
  }

  private async checkedReferences(
    metadata: RepositoryWorkspace,
    projectId: string,
    fileName: string,
  ): Promise<{ readonly documents: readonly LoadedDocument[]; readonly preview: Omit<ProjectFileReferencePreview, "draft_fingerprint"> }> {
    const documents = await loadRepositoryDocuments(metadata.worktree_path);
    const found = searchProjectFileReferences({ projectId, fileName, documents: documents.map((item) => item.document) });
    return {
      documents,
      preview: { project_id: projectId, file_name: fileName, status: "checked", count: found.count, locations: found.locations },
    };
  }

  async referencePreview(draftId: string, projectId: string, fileName: string): Promise<ProjectFileReferencePreview> {
    assertFileName(fileName);
    const metadata = await this.workspace(draftId, projectId);
    const directory = await resolveDomainPath(metadata.worktree_path, `projects/${projectId}/files`);
    const names = await regularFileNames(directory).catch((error: unknown) => filesystemError(error, "PROJECT_FILE_NOT_FOUND", `Project file ${fileName} does not exist`));
    if (names.get(projectFileNameComparisonKey(fileName)) !== fileName) {
      throw new ProjectFileOperationError("PROJECT_FILE_NOT_FOUND", `Project file ${fileName} does not exist`);
    }
    const checked = await this.checkedReferences(metadata, projectId, fileName);
    return { ...checked.preview, draft_fingerprint: metadata.fingerprint };
  }

  private async writeReferences(
    metadata: DraftMetadata,
    projectId: string,
    fileName: string,
    replacement: string,
    action: "updated" | "unlinked",
    loaded?: Awaited<ReturnType<ProjectFileStore["checkedReferences"]>>,
  ): Promise<{ readonly references: ProjectFileReferencesChecked; readonly journal: readonly WrittenDocument[] }> {
    const checked = loaded ?? await this.checkedReferences(metadata as unknown as RepositoryWorkspace, projectId, fileName);
    const locationsByPath = new Map<string, ProjectFileReferenceLocation[]>();
    for (const location of checked.preview.locations) {
      const entries = locationsByPath.get(location.path) ?? [];
      entries.push(location);
      locationsByPath.set(location.path, entries);
    }
    const updated = new Map<string, GitPmDocument>();
    for (const item of checked.documents) {
      const locations = locationsByPath.get(item.relative);
      if (locations !== undefined) updated.set(item.relative, rewriteDocument(item.document, locations, replacement));
    }
    const labels = referenceLabelsForDocuments(checked.documents.map((item) => updated.get(item.relative) ?? item.document));
    const journal: WrittenDocument[] = [];
    try {
      await this.options.beforeReferenceWriteForTest?.();
      for (const item of checked.documents.filter((candidate) => updated.has(candidate.relative))) {
        const written = formatYamlDocument(updated.get(item.relative)!, labels);
        const identity = await atomicWriteDomainFile(metadata.worktree_path, item.relative, written, {
          beforeRenameForTest: async () => {
            const current = await lstat(item.absolute);
            const content = current.isFile() && !current.isSymbolicLink() ? await readFile(item.absolute, "utf8") : undefined;
            if (!sameIdentity(current, item.identity) || content !== item.original) {
              throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_CHANGED", "Repository document changed before reference update");
            }
          },
        });
        journal.push({ relative: item.relative, original: item.original, written, identity });
        await this.options.afterReferenceWriteForTest?.();
      }
      const after = await this.checkedReferences(metadata as unknown as RepositoryWorkspace, projectId, fileName);
      if (after.preview.count !== 0) {
        throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_CHANGED", "Project file references changed during mutation");
      }
      return {
        references: {
          status: "checked",
          action,
          before_count: checked.preview.count,
          affected_count: checked.preview.count,
          remaining_count: 0,
          locations: checked.preview.locations,
        },
        journal,
      };
    } catch (error) {
      await this.rollbackReferences(metadata, projectId, journal);
      throw error;
    }
  }

  private async rollbackReferences(metadata: DraftMetadata, projectId: string, journal: readonly WrittenDocument[]): Promise<void> {
    const recoveries: string[] = [];
    let recoveryWriteFailures = 0;
    for (const entry of [...journal].reverse()) {
      const absolute = await resolveDomainPath(metadata.worktree_path, entry.relative);
      try {
        await atomicWriteDomainFile(metadata.worktree_path, entry.relative, entry.original, {
          beforeRenameForTest: async () => {
            const current = await lstat(absolute);
            const content = current.isFile() && !current.isSymbolicLink() ? await readFile(absolute, "utf8") : undefined;
            if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(current, entry.identity) || content !== entry.written) {
              throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_CHANGED", "Repository document changed before reference rollback");
            }
          },
        });
      } catch {
        const recoveryName = `.gitpm-project-file-${randomUUID()}.references-recovery`;
        const recoveryPath = `projects/${projectId}/files/${recoveryName}`;
        try {
          await this.options.beforeReferenceRecoveryWriteForTest?.();
          await atomicWriteDomainFile(metadata.worktree_path, recoveryPath, entry.original);
          recoveries.push(recoveryPath);
        } catch {
          recoveryWriteFailures += 1;
        }
      }
    }
    if (recoveries.length > 0 || recoveryWriteFailures > 0) {
      const created = recoveries.length === 0 ? "" : `; recovery copies: ${recoveries.join(", ")}`;
      const failed = recoveryWriteFailures === 0 ? "" : `; ${recoveryWriteFailures} recovery copy could not be created`;
      throw new ProjectFileOperationError("PROJECT_FILE_ROLLBACK_FAILED", `Project file reference rollback was incomplete${created}${failed}`);
    }
  }

  async list(draftId: string, projectId: string): Promise<ProjectFileList> {
    const metadata = await this.workspace(draftId, projectId);
    const relativeDirectory = `projects/${projectId}/files`;
    let directory: string;
    try {
      directory = await resolveDomainPath(metadata.worktree_path, relativeDirectory);
    } catch (error) {
      filesystemError(error, "PROJECT_FILES_NOT_FOUND", "Project files directory does not exist");
    }

    let directoryStat;
    try {
      directoryStat = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { project_id: projectId, count: 0, total_size_bytes: 0, items: [], draft_fingerprint: metadata.fingerprint };
      }
      filesystemError(error, "PROJECT_FILES_NOT_FOUND", "Project files directory does not exist");
    }
    if (directoryStat.isSymbolicLink()) {
      throw new ProjectFileOperationError("PROJECT_FILE_PATH_FORBIDDEN", "Project files directory must not be a symbolic link");
    }
    if (!directoryStat.isDirectory()) {
      throw new ProjectFileOperationError("PROJECT_FILES_LAYOUT_INVALID", "Project files path must be a directory");
    }

    let names: readonly string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      filesystemError(error, "PROJECT_FILES_NOT_FOUND", "Project files directory does not exist");
    }
    const items = await Promise.all(names.map(async (name) => {
      assertFileName(name);
      let stat;
      try {
        stat = await lstat(path.join(directory, name));
      } catch (error) {
        filesystemError(error, "PROJECT_FILE_NOT_FOUND", `Project file ${name} does not exist`);
      }
      if (stat.isSymbolicLink()) {
        throw new ProjectFileOperationError("PROJECT_FILE_PATH_FORBIDDEN", `Project file ${name} must not be a symbolic link`);
      }
      if (!stat.isFile()) {
        throw new ProjectFileOperationError("PROJECT_FILES_LAYOUT_INVALID", `Project file ${name} is not a regular file`);
      }
      return itemFromStat(projectId, name, stat);
    }));
    items.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    return {
      project_id: projectId,
      count: items.length,
      total_size_bytes: items.reduce((total, item) => total + item.size_bytes, 0),
      items,
      draft_fingerprint: metadata.fingerprint,
    };
  }

  async open(draftId: string, projectId: string, name: string): Promise<OpenProjectFile> {
    assertFileName(name);
    const metadata = await this.workspace(draftId, projectId);
    const relativeDirectory = `projects/${projectId}/files`;
    const relative = `${relativeDirectory}/${name}`;
    let directory: string;
    let target: string;
    try {
      directory = await resolveDomainPath(metadata.worktree_path, relativeDirectory);
      target = await resolveDomainPath(metadata.worktree_path, relative);
    } catch (error) {
      filesystemError(error, "PROJECT_FILE_NOT_FOUND", `Project file ${name} does not exist`);
    }

    let before;
    try {
      before = await lstat(target);
    } catch (error) {
      filesystemError(error, "PROJECT_FILE_NOT_FOUND", `Project file ${name} does not exist`);
    }
    if (before.isSymbolicLink()) {
      throw new ProjectFileOperationError("PROJECT_FILE_PATH_FORBIDDEN", `Project file ${name} must not be a symbolic link`);
    }
    if (!before.isFile()) {
      throw new ProjectFileOperationError("PROJECT_FILE_NOT_REGULAR", `Project file ${name} is not a regular file`);
    }

    let handle: FileHandle;
    try {
      handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      filesystemError(error, "PROJECT_FILE_NOT_FOUND", `Project file ${name} does not exist`);
    }
    try {
      const opened = await handle.stat();
      const after = await lstat(target);
      const canonicalDirectory = await realpath(directory);
      const canonicalTarget = await realpath(target);
      assertContained(canonicalDirectory, canonicalTarget);
      if (!opened.isFile() || after.isSymbolicLink() || !after.isFile()
        || !sameIdentity(before, opened) || !sameIdentity(opened, after)) {
        throw new ProjectFileOperationError("PROJECT_FILE_PATH_FORBIDDEN", `Project file ${name} changed while it was being opened`);
      }
      return { handle, item: itemFromStat(projectId, name, opened) };
    } catch (error) {
      await handle.close();
      filesystemError(error, "PROJECT_FILE_NOT_FOUND", `Project file ${name} does not exist`);
    }
  }

  async rename(
    draftId: string,
    owner: string,
    projectId: string,
    name: string,
    expectedFingerprint: string,
    newName: string,
    referenceMode: ProjectFileRenameReferenceMode,
  ): Promise<ProjectFileRenameResult> {
    const mutation = await this.drafts.withUiMutation(draftId, owner, expectedFingerprint, async (metadata) => {
      assertProjectId(projectId);
      assertFileName(name);
      assertFileName(newName);
      assertRenameReferenceMode(referenceMode);
      if (name === newName) {
        throw new ProjectFileOperationError("PROJECT_FILE_RENAME_NO_CHANGE", "New Project file name is unchanged");
      }
      await assertProject(metadata as unknown as RepositoryWorkspace, projectId);
      try {
        const checked = referenceMode === "ignore_unchecked"
          ? undefined
          : await this.checkedReferences(metadata as unknown as RepositoryWorkspace, projectId, name);
        const kept: ProjectFileReferencesChecked | undefined = referenceMode === "keep" && checked !== undefined ? {
          status: "checked",
          action: "kept",
          before_count: checked.preview.count,
          affected_count: 0,
          remaining_count: checked.preview.count,
          locations: checked.preview.locations,
        } : undefined;
        return await this.renameInWorkspace(metadata, projectId, name, newName, referenceMode === "update" && checked !== undefined
          ? async () => await this.writeReferences(metadata, projectId, name, formatProjectFileReference(newName), "updated", checked)
          : undefined, kept);
      } catch (error) {
        filesystemError(error, "PROJECT_FILE_NOT_FOUND", `Project file ${name} does not exist`);
      }
    });
    return {
      project_id: projectId,
      operation: "renamed",
      previous_name: name,
      item: mutation.result.item,
      references: mutation.result.references ?? { status: "not_checked" },
      draft_fingerprint: mutation.metadata.fingerprint,
    };
  }

  async delete(
    draftId: string,
    owner: string,
    projectId: string,
    name: string,
    expectedFingerprint: string,
    confirmationName: string,
    referenceMode: ProjectFileDeleteReferenceMode,
  ): Promise<ProjectFileDeleteResult> {
    const mutation = await this.drafts.withUiMutation(draftId, owner, expectedFingerprint, async (metadata) => {
      assertProjectId(projectId);
      assertFileName(name);
      assertDeleteReferenceMode(referenceMode);
      if (confirmationName !== name) {
        throw new ProjectFileOperationError(
          "PROJECT_FILE_DELETE_CONFIRMATION_REQUIRED",
          "Project file deletion requires confirmation of the exact file name",
        );
      }
      await assertProject(metadata as unknown as RepositoryWorkspace, projectId);
      try {
        const checked = referenceMode === "ignore_unchecked"
          ? undefined
          : await this.checkedReferences(metadata as unknown as RepositoryWorkspace, projectId, name);
        if (referenceMode === "restrict" && checked !== undefined && checked.preview.count > 0) {
          throw new ProjectFileOperationError("PROJECT_FILE_DELETE_REFERENCED", "Project file is referenced and must be unlinked explicitly");
        }
        const restricted: ProjectFileReferencesChecked | undefined = referenceMode === "restrict" && checked !== undefined ? {
          status: "checked", action: "preserved", before_count: 0, affected_count: 0, remaining_count: 0, locations: [],
        } : undefined;
        return await this.deleteInWorkspace(metadata, projectId, name, referenceMode === "unlink" && checked !== undefined
          ? async () => await this.writeReferences(metadata, projectId, name, name, "unlinked", checked)
          : undefined, restricted);
      } catch (error) {
        filesystemError(error, "PROJECT_FILE_NOT_FOUND", `Project file ${name} does not exist`);
      }
    });
    return {
      project_id: projectId,
      operation: "deleted",
      name,
      path: normalize(path.join("projects", projectId, "files", name)),
      size_bytes: mutation.result.stat.size,
      references: mutation.result.references ?? { status: "not_checked" },
      secure_erase: false,
      draft_fingerprint: mutation.metadata.fingerprint,
    };
  }

  private async renameInWorkspace(
    metadata: DraftMetadata,
    projectId: string,
    name: string,
    newName: string,
    mutateReferences?: () => Promise<{ readonly references: ProjectFileReferencesChecked; readonly journal: readonly WrittenDocument[] }>,
    existingReferences?: ProjectFileReferencesChecked,
  ): Promise<{ readonly item: ProjectFileItem; readonly references?: ProjectFileReferencesChecked }> {
    const filesDirectory = await resolveDomainPath(metadata.worktree_path, `projects/${projectId}/files`);
    const filesSnapshot = await existingFilesDirectorySnapshot(filesDirectory, name);
    const source = await resolveDomainPath(metadata.worktree_path, `projects/${projectId}/files/${name}`);
    const destination = await resolveDomainPath(metadata.worktree_path, `projects/${projectId}/files/${newName}`);
    const original = await existingRegularFile(source);
    if (original === undefined) {
      throw new ProjectFileOperationError("PROJECT_FILE_NOT_FOUND", `Project file ${name} does not exist`);
    }
    const names = await regularFileNames(filesDirectory);
    if (names.get(projectFileNameComparisonKey(name)) !== name) {
      throw new ProjectFileOperationError("PROJECT_FILE_NOT_FOUND", `Project file ${name} does not exist`);
    }
    const conflictingName = names.get(projectFileNameComparisonKey(newName));
    if (conflictingName !== undefined && conflictingName !== name) {
      throw new ProjectFileOperationError(
        "PROJECT_FILE_NAME_CONFLICT",
        "A Project file with the same case-insensitive name already exists",
      );
    }
    const temporary = path.join(filesDirectory, `.gitpm-project-file-${randomUUID()}.rename`);
    let temporaryIdentity: Stats | undefined;
    let temporaryExists = false;
    let sourceDetached = false;
    let publishedIdentity: Stats | undefined;
    let preserveTemporaryForRecovery = false;
    let referenceMutation: { readonly references: ProjectFileReferencesChecked; readonly journal: readonly WrittenDocument[] } | undefined;
    try {
      await this.options.beforeRenameForTest?.();
      await assertDirectoryUnchanged(filesSnapshot);
      const current = await existingRegularFile(source);
      if (current === undefined || !sameIdentity(original, current)) {
        throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file changed during rename");
      }
      const currentNames = await regularFileNames(filesDirectory);
      if (currentNames.get(projectFileNameComparisonKey(name)) !== name) {
        throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file name changed during rename");
      }
      const currentConflict = currentNames.get(projectFileNameComparisonKey(newName));
      if (currentConflict !== undefined && currentConflict !== name) {
        throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file rename target appeared during rename");
      }

      if (await existingRegularFile(temporary) !== undefined) {
        throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file rename staging name already exists");
      }
      await rename(source, temporary);
      temporaryExists = true;
      sourceDetached = true;
      temporaryIdentity = await lstat(temporary);
      if (!sameIdentity(original, temporaryIdentity)) {
        throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file changed while rename staging was created");
      }
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file rename target appeared during publication");
        }
        throw error;
      }
      publishedIdentity = await lstat(destination);
      if (!sameIdentity(original, publishedIdentity)) {
        throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file changed during rename publication");
      }
      referenceMutation = await mutateReferences?.();
      await this.options.beforeValidationForTest?.("rename");
      const report = await validateRepository(metadata.worktree_path);
      if (!report.valid) {
        throw new ProjectFileOperationError(
          "PROJECT_FILE_VALIDATION_FAILED",
          report.errors[0]?.message ?? "Repository validation failed",
        );
      }
      const finalNames = await regularFileNames(filesDirectory);
      if (finalNames.get(projectFileNameComparisonKey(newName)) !== newName
        || (projectFileNameComparisonKey(name) !== projectFileNameComparisonKey(newName)
          && finalNames.has(projectFileNameComparisonKey(name)))) {
        throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file changed while rename was validated");
      }
      const final = await existingRegularFile(destination);
      if (final === undefined || publishedIdentity === undefined || !sameIdentity(final, publishedIdentity)) {
        throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file changed while rename was validated");
      }
      if (temporaryIdentity === undefined || !await removeIfSameIdentity(temporary, temporaryIdentity)) {
        throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file rename staging changed during cleanup");
      }
      temporaryExists = false;
      return { item: itemFromStat(projectId, newName, final), references: referenceMutation?.references ?? existingReferences };
    } catch (error) {
      let rollbackError: unknown;
      if (referenceMutation !== undefined) {
        try { await this.rollbackReferences(metadata, projectId, referenceMutation.journal); }
        catch (referenceError) { rollbackError = referenceError; }
      }
      if (publishedIdentity !== undefined) {
        try {
          await removeIfSameIdentity(destination, publishedIdentity);
        } catch {
          throw new ProjectFileOperationError(
            "PROJECT_FILE_ROLLBACK_FAILED",
            "Project file rename failed and destination cleanup failed",
          );
        }
      }
      if (sourceDetached) {
        let restoredFromTemporary = false;
        if (temporaryExists && temporaryIdentity !== undefined) {
          try {
            if (sameIdentity(await lstat(temporary), temporaryIdentity)
              && await existingRegularFile(source) === undefined) {
              await rename(temporary, source);
              temporaryExists = false;
              restoredFromTemporary = true;
              sourceDetached = false;
            }
          } catch {
            restoredFromTemporary = false;
          }
        }
        if (!restoredFromTemporary) {
          preserveTemporaryForRecovery = true;
          throw new ProjectFileOperationError(
            "PROJECT_FILE_ROLLBACK_FAILED",
            "Project file rename failed and the original name could not be restored safely",
          );
        }
      }
      if (rollbackError !== undefined) throw rollbackError;
      throw error;
    } finally {
      if (!preserveTemporaryForRecovery && temporaryExists && temporaryIdentity !== undefined) {
        await removeIfSameIdentity(temporary, temporaryIdentity);
      }
    }
  }

  private async deleteInWorkspace(
    metadata: DraftMetadata,
    projectId: string,
    name: string,
    mutateReferences?: () => Promise<{ readonly references: ProjectFileReferencesChecked; readonly journal: readonly WrittenDocument[] }>,
    existingReferences?: ProjectFileReferencesChecked,
  ): Promise<{ readonly stat: Stats; readonly references?: ProjectFileReferencesChecked }> {
    const filesDirectory = await resolveDomainPath(metadata.worktree_path, `projects/${projectId}/files`);
    const filesSnapshot = await existingFilesDirectorySnapshot(filesDirectory, name);
    const target = await resolveDomainPath(metadata.worktree_path, `projects/${projectId}/files/${name}`);
    const original = await existingRegularFile(target);
    if (original === undefined) {
      throw new ProjectFileOperationError("PROJECT_FILE_NOT_FOUND", `Project file ${name} does not exist`);
    }
    const names = await regularFileNames(filesDirectory);
    if (names.get(projectFileNameComparisonKey(name)) !== name) {
      throw new ProjectFileOperationError("PROJECT_FILE_NOT_FOUND", `Project file ${name} does not exist`);
    }
    const temporary = path.join(filesDirectory, `.gitpm-project-file-${randomUUID()}.delete`);
    let temporaryIdentity: Stats | undefined;
    let temporaryExists = false;
    let deleted = false;
    let preserveTemporaryForRecovery = false;
    let referenceMutation: { readonly references: ProjectFileReferencesChecked; readonly journal: readonly WrittenDocument[] } | undefined;
    try {
      await this.options.beforeDeleteForTest?.();
      await assertDirectoryUnchanged(filesSnapshot);
      const current = await existingRegularFile(target);
      if (current === undefined || !sameIdentity(original, current)) {
        throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file changed during deletion");
      }
      const currentNames = await regularFileNames(filesDirectory);
      if (currentNames.get(projectFileNameComparisonKey(name)) !== name) {
        throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file name changed during deletion");
      }
      if (await existingRegularFile(temporary) !== undefined) {
        throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file delete staging name already exists");
      }
      await rename(target, temporary);
      temporaryExists = true;
      deleted = true;
      temporaryIdentity = await lstat(temporary);
      if (!sameIdentity(original, temporaryIdentity)) {
        throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file changed while delete staging was created");
      }
      referenceMutation = await mutateReferences?.();
      await this.options.beforeValidationForTest?.("delete");
      const report = await validateRepository(metadata.worktree_path);
      if (!report.valid) {
        throw new ProjectFileOperationError(
          "PROJECT_FILE_VALIDATION_FAILED",
          report.errors[0]?.message ?? "Repository validation failed",
        );
      }
      const finalNames = await regularFileNames(filesDirectory);
      if (finalNames.has(projectFileNameComparisonKey(name))) {
        throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file name reappeared during deletion");
      }
      if (temporaryIdentity === undefined || !await removeIfSameIdentity(temporary, temporaryIdentity)) {
        throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file delete staging changed during cleanup");
      }
      temporaryExists = false;
      return { stat: original, references: referenceMutation?.references ?? existingReferences };
    } catch (error) {
      let rollbackError: unknown;
      if (referenceMutation !== undefined) {
        try { await this.rollbackReferences(metadata, projectId, referenceMutation.journal); }
        catch (referenceError) { rollbackError = referenceError; }
      }
      if (deleted) {
        let restoredFromTemporary = false;
        if (temporaryExists && temporaryIdentity !== undefined) {
          try {
            if (sameIdentity(await lstat(temporary), temporaryIdentity)
              && await existingRegularFile(target) === undefined) {
              await rename(temporary, target);
              temporaryExists = false;
              restoredFromTemporary = true;
              deleted = false;
            }
          } catch {
            restoredFromTemporary = false;
          }
        }
        if (!restoredFromTemporary) {
          preserveTemporaryForRecovery = true;
          throw new ProjectFileOperationError(
            "PROJECT_FILE_ROLLBACK_FAILED",
            "Project file deletion failed and the original file could not be restored safely",
          );
        }
      }
      if (rollbackError !== undefined) throw rollbackError;
      throw error;
    } finally {
      if (!preserveTemporaryForRecovery && temporaryExists && temporaryIdentity !== undefined) {
        await removeIfSameIdentity(temporary, temporaryIdentity);
      }
    }
  }

  async replace(
    draftId: string,
    owner: string,
    projectId: string,
    previousName: string,
    expectedFingerprint: string,
    input: ProjectFileReplaceInput,
  ): Promise<ProjectFileReplaceResult> {
    const mutation = await this.drafts.withUiMutation(draftId, owner, expectedFingerprint, async (metadata) => {
      assertProjectId(projectId);
      assertFileName(previousName);
      assertFileName(input.name);
      if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
        throw new ProjectFileOperationError("PROJECT_FILE_UPLOAD_METADATA_INVALID", "Project file replacement size must be a non-negative safe integer");
      }
      if (input.sizeBytes > this.maxUploadBytes) {
        throw new ProjectFileOperationError("PROJECT_FILE_TOO_LARGE", "Project file exceeds the configured upload limit");
      }
      if (input.sizeBytes > PROJECT_FILE_LARGE_THRESHOLD_BYTES && input.largeFileConfirmation !== input.name) {
        throw new ProjectFileOperationError("PROJECT_FILE_LARGE_CONFIRMATION_REQUIRED", "Files larger than 50 MiB require confirmation of the exact new file name");
      }
      await assertProject(metadata as unknown as RepositoryWorkspace, projectId);
      const checked = await this.checkedReferences(metadata as unknown as RepositoryWorkspace, projectId, previousName);
      try {
        return await this.replaceInWorkspace(metadata, projectId, previousName, input, checked);
      } catch (error) {
        filesystemError(error, "PROJECT_FILE_NOT_FOUND", `Project file ${previousName} does not exist`);
      }
    });
    return {
      project_id: projectId,
      operation: "replaced",
      previous_name: previousName,
      item: mutation.result.item,
      references: mutation.result.references,
      draft_fingerprint: mutation.metadata.fingerprint,
    };
  }

  private async replaceInWorkspace(
    metadata: DraftMetadata,
    projectId: string,
    previousName: string,
    input: ProjectFileReplaceInput,
    checked: Awaited<ReturnType<ProjectFileStore["checkedReferences"]>>,
  ): Promise<{ readonly item: ProjectFileItem; readonly references: ProjectFileReferencesChecked }> {
    const filesDirectory = await resolveDomainPath(metadata.worktree_path, `projects/${projectId}/files`);
    const filesSnapshot = await existingFilesDirectorySnapshot(filesDirectory, previousName);
    const source = await resolveDomainPath(metadata.worktree_path, `projects/${projectId}/files/${previousName}`);
    const destination = await resolveDomainPath(metadata.worktree_path, `projects/${projectId}/files/${input.name}`);
    const original = await existingRegularFile(source);
    if (original === undefined) throw new ProjectFileOperationError("PROJECT_FILE_NOT_FOUND", `Project file ${previousName} does not exist`);
    const originalContent = await regularFileDigest(source);
    if (!sameIdentity(original, originalContent.identity)) throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file changed before replacement content was staged");
    const names = await regularFileNames(filesDirectory);
    if (names.get(projectFileNameComparisonKey(previousName)) !== previousName) {
      throw new ProjectFileOperationError("PROJECT_FILE_NOT_FOUND", `Project file ${previousName} does not exist`);
    }
    const conflict = names.get(projectFileNameComparisonKey(input.name));
    if (conflict !== undefined && conflict !== previousName) {
      throw new ProjectFileOperationError("PROJECT_FILE_NAME_CONFLICT", "A Project file with the same case-insensitive replacement name already exists");
    }

    const token = randomUUID();
    const temporary = path.join(filesDirectory, `.gitpm-project-file-${token}.tmp`);
    const backup = path.join(filesDirectory, `.gitpm-project-file-${token}.replace-backup`);
    let temporaryIdentity: Stats | undefined;
    let temporaryExists = false;
    let backupIdentity: Stats | undefined;
    let backupExists = false;
    let publishedIdentity: Stats | undefined;
    let referenceMutation: { readonly references: ProjectFileReferencesChecked; readonly journal: readonly WrittenDocument[] } | undefined;
    let preserveBackupForRecovery = false;
    try {
      let handle: FileHandle;
      try {
        handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file replacement staging name already exists");
        throw error;
      }
      temporaryExists = true;
      let written = 0;
      try {
        for await (const chunk of input.content) {
          written += chunk.byteLength;
          if (written > input.sizeBytes) throw new ProjectFileOperationError("PROJECT_FILE_UPLOAD_SIZE_MISMATCH", "Replacement content is larger than the declared size");
          if (written > this.maxUploadBytes) throw new ProjectFileOperationError("PROJECT_FILE_TOO_LARGE", "Project file exceeds the configured upload limit");
          await handle.write(chunk);
        }
        if (written !== input.sizeBytes) throw new ProjectFileOperationError("PROJECT_FILE_UPLOAD_SIZE_MISMATCH", "Replacement content size differs from the declared size");
        await handle.sync();
        temporaryIdentity = await handle.stat();
      } finally { await handle.close(); }

      await this.options.beforeFinalizeForTest?.();
      await assertDirectoryUnchanged(filesSnapshot);
      const current = await existingRegularFile(source);
      if (current === undefined || !sameIdentity(original, current)) throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file changed during replacement");
      const currentNames = await regularFileNames(filesDirectory);
      if (currentNames.get(projectFileNameComparisonKey(previousName)) !== previousName) throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file name changed during replacement");
      const currentConflict = currentNames.get(projectFileNameComparisonKey(input.name));
      if (currentConflict !== undefined && currentConflict !== previousName) throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file replacement target appeared during replacement");
      await rename(source, backup);
      backupExists = true;
      backupIdentity = await lstat(backup);
      if (!sameIdentity(original, backupIdentity)) throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file changed while replacement backup was created");
      const backupContent = await regularFileDigest(backup);
      if (!sameIdentity(backupIdentity, backupContent.identity) || backupContent.digest !== originalContent.digest) {
        throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file content changed during replacement");
      }
      if (temporaryIdentity === undefined || !sameIdentity(await lstat(temporary), temporaryIdentity)) throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file replacement staging changed before publication");
      try { await link(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file replacement target appeared during publication");
        throw error;
      }
      publishedIdentity = await lstat(destination);
      if (!sameIdentity(publishedIdentity, temporaryIdentity)) throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file replacement staging changed during publication");

      if (previousName !== input.name) {
        referenceMutation = await this.writeReferences(metadata, projectId, previousName, formatProjectFileReference(input.name), "updated", checked);
      }
      await this.options.beforeValidationForTest?.("replace");
      const report = await validateRepository(metadata.worktree_path);
      if (!report.valid) throw new ProjectFileOperationError("PROJECT_FILE_VALIDATION_FAILED", report.errors[0]?.message ?? "Repository validation failed");
      const final = await existingRegularFile(destination);
      if (final === undefined || publishedIdentity === undefined || !sameIdentity(final, publishedIdentity)) throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file changed while replacement was validated");
      const finalNames = await regularFileNames(filesDirectory);
      if (finalNames.get(projectFileNameComparisonKey(input.name)) !== input.name
        || (projectFileNameComparisonKey(previousName) !== projectFileNameComparisonKey(input.name) && finalNames.has(projectFileNameComparisonKey(previousName)))) {
        throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file names changed while replacement was validated");
      }
      if (previousName === input.name) {
        const fresh = await this.checkedReferences(metadata as unknown as RepositoryWorkspace, projectId, previousName);
        referenceMutation = { references: {
          status: "checked", action: "preserved", before_count: fresh.preview.count, affected_count: 0,
          remaining_count: fresh.preview.count, locations: fresh.preview.locations,
        }, journal: [] };
      } else {
        const oldReferences = await this.checkedReferences(metadata as unknown as RepositoryWorkspace, projectId, previousName);
        if (oldReferences.preview.count !== 0) throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_CHANGED", "Project file references changed during replacement validation");
      }
      if (!await removeIfSameIdentity(temporary, temporaryIdentity)) throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file replacement staging changed during cleanup");
      temporaryExists = false;
      if (backupIdentity === undefined || !await removeIfSameIdentity(backup, backupIdentity)) throw new ProjectFileOperationError("PROJECT_FILE_ROLLBACK_FAILED", "Project file replacement backup changed during cleanup");
      backupExists = false;
      if (referenceMutation === undefined) throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_CHANGED", "Project file replacement reference verification did not complete");
      return { item: itemFromStat(projectId, input.name, final), references: referenceMutation.references };
    } catch (error) {
      let rollbackError: unknown;
      if (referenceMutation !== undefined && referenceMutation.journal.length > 0) {
        try { await this.rollbackReferences(metadata, projectId, referenceMutation.journal); }
        catch (caught) { rollbackError = caught; }
      }
      if (publishedIdentity !== undefined) {
        try {
          if (!await removeIfSameIdentity(destination, publishedIdentity)) {
            rollbackError ??= new ProjectFileOperationError("PROJECT_FILE_ROLLBACK_FAILED", "Project file replacement destination changed and could not be removed safely");
          }
        }
        catch { rollbackError ??= new ProjectFileOperationError("PROJECT_FILE_ROLLBACK_FAILED", "Project file replacement destination cleanup failed"); }
      }
      if (backupExists && backupIdentity !== undefined) {
        try {
          if (!sameIdentity(await lstat(backup), backupIdentity) || await existingRegularFile(source) !== undefined) throw new Error("replacement rollback target changed");
          await rename(backup, source);
          backupExists = false;
        } catch {
          preserveBackupForRecovery = true;
          rollbackError ??= new ProjectFileOperationError("PROJECT_FILE_ROLLBACK_FAILED", "Project file replacement failed and the original file could not be restored safely");
        }
      }
      if (rollbackError !== undefined) throw rollbackError;
      throw error;
    } finally {
      if (temporaryExists && temporaryIdentity !== undefined) await removeIfSameIdentity(temporary, temporaryIdentity);
      if (!preserveBackupForRecovery && backupExists && backupIdentity !== undefined) await removeIfSameIdentity(backup, backupIdentity);
    }
  }

  async upload(
    draftId: string,
    owner: string,
    projectId: string,
    expectedFingerprint: string,
    input: ProjectFileUploadInput,
  ): Promise<ProjectFileUploadResult> {
    const mutation = await this.drafts.withUiMutation(draftId, owner, expectedFingerprint, async (metadata) => {
      assertProjectId(projectId);
      assertFileName(input.name);
      if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
        throw new ProjectFileOperationError("PROJECT_FILE_UPLOAD_METADATA_INVALID", "Project file upload size must be a non-negative safe integer");
      }
      if (input.sizeBytes > this.maxUploadBytes) {
        throw new ProjectFileOperationError("PROJECT_FILE_TOO_LARGE", "Project file exceeds the configured upload limit");
      }
      if (input.sizeBytes > PROJECT_FILE_LARGE_THRESHOLD_BYTES && input.largeFileConfirmation !== input.name) {
        throw new ProjectFileOperationError("PROJECT_FILE_LARGE_CONFIRMATION_REQUIRED", "Files larger than 50 MiB require confirmation of the exact file name");
      }
      if (input.mode === "create" && input.referenceMode === "preserve_checked") {
        throw new ProjectFileOperationError("PROJECT_FILE_REFERENCES_UNSUPPORTED", "Checked reference preservation is available only for exact replacement");
      }
      await assertProject(metadata as unknown as RepositoryWorkspace, projectId);
      try {
        return await this.uploadInWorkspace(metadata, projectId, input);
      } catch (error) {
        filesystemError(error, "PROJECT_FILE_NOT_FOUND", "Project file does not exist");
      }
    });
    return {
      project_id: projectId,
      operation: mutation.result.operation,
      item: mutation.result.item,
      references: mutation.result.references ?? { status: "not_checked" },
      draft_fingerprint: mutation.metadata.fingerprint,
    };
  }

  private async uploadInWorkspace(
    metadata: DraftMetadata,
    projectId: string,
    input: ProjectFileUploadInput,
  ): Promise<{ readonly operation: "created" | "replaced"; readonly item: ProjectFileItem; readonly references?: ProjectFileReferencesChecked }> {
    const projectDirectory = await resolveDomainPath(metadata.worktree_path, `projects/${projectId}`);
    const projectSnapshot = await directorySnapshot(projectDirectory);
    const filesDirectory = await resolveDomainPath(metadata.worktree_path, `projects/${projectId}/files`);
    let filesDirectoryCreated = false;
    try {
      try {
        await mkdir(filesDirectory, { mode: 0o700 });
        filesDirectoryCreated = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await assertDirectoryUnchanged(projectSnapshot);
      const filesSnapshot = await directorySnapshot(filesDirectory);
      const names = await readdir(filesDirectory);
      const comparisonKey = projectFileNameComparisonKey(input.name);
      const namesByKey = new Map<string, string>();
      for (const name of names) {
        assertFileName(name);
        const entry = await lstat(path.join(filesDirectory, name));
        if (entry.isSymbolicLink()) {
          throw new ProjectFileOperationError("PROJECT_FILE_PATH_FORBIDDEN", "Project files directory contains a symbolic link");
        }
        if (!entry.isFile()) {
          throw new ProjectFileOperationError("PROJECT_FILES_LAYOUT_INVALID", "Project files directory contains a non-regular file");
        }
        const key = projectFileNameComparisonKey(name);
        if (namesByKey.has(key)) {
          throw new ProjectFileOperationError("PROJECT_FILES_LAYOUT_INVALID", "Project files directory contains a case-insensitive name conflict");
        }
        namesByKey.set(key, name);
      }
      const matchingName = namesByKey.get(comparisonKey);
      if (matchingName !== undefined && matchingName !== input.name) {
        throw new ProjectFileOperationError("PROJECT_FILE_NAME_CONFLICT", "A Project file with the same case-insensitive name already exists");
      }
      const target = await resolveDomainPath(metadata.worktree_path, `projects/${projectId}/files/${input.name}`);
      const original = await existingRegularFile(target);
      if (input.mode === "create" && original !== undefined) {
        throw new ProjectFileOperationError("PROJECT_FILE_EXISTS", "Project file already exists; explicit replace mode is required");
      }
      if (input.mode === "replace" && original === undefined) {
        throw new ProjectFileOperationError("PROJECT_FILE_NOT_FOUND", "Project file does not exist and cannot be replaced");
      }

      const token = randomUUID();
      const temporary = path.join(filesDirectory, `.gitpm-project-file-${token}.tmp`);
      const backup = path.join(filesDirectory, `.gitpm-project-file-${token}.bak`);
      let temporaryExists = false;
      let backupExists = false;
      let temporaryIdentity: Stats | undefined;
      let backupIdentity: Stats | undefined;
      let publishedIdentity: Stats | undefined;
      let originalHandle: FileHandle | undefined;
      let originalDetached = false;
      try {
        let handle: FileHandle;
        try {
          handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file upload staging name already exists");
          }
          throw error;
        }
        temporaryExists = true;
        temporaryIdentity = await handle.stat();
        let written = 0;
        try {
          for await (const chunk of input.content) {
            written += chunk.byteLength;
            if (written > input.sizeBytes) {
              throw new ProjectFileOperationError("PROJECT_FILE_UPLOAD_SIZE_MISMATCH", "Uploaded content is larger than the declared size");
            }
            if (written > this.maxUploadBytes) {
              throw new ProjectFileOperationError("PROJECT_FILE_TOO_LARGE", "Project file exceeds the configured upload limit");
            }
            await handle.write(chunk);
          }
          if (written !== input.sizeBytes) {
            throw new ProjectFileOperationError("PROJECT_FILE_UPLOAD_SIZE_MISMATCH", "Uploaded content size differs from the declared size");
          }
          await handle.sync();
          temporaryIdentity = await handle.stat();
        } finally {
          await handle.close();
        }

        await this.options.beforeFinalizeForTest?.();
        await assertDirectoryUnchanged(filesSnapshot);
        const current = await existingRegularFile(target);
        if ((original === undefined) !== (current === undefined)
          || (original !== undefined && current !== undefined && !sameIdentity(original, current))) {
          throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file changed during upload");
        }
        if (original !== undefined) {
          originalHandle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          const openedOriginal = await originalHandle.stat();
          if (!openedOriginal.isFile() || !sameIdentity(original, openedOriginal)) {
            throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file changed while it was opened for rollback");
          }
          if (await existingRegularFile(backup) !== undefined) {
            throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file rollback staging name already exists");
          }
          await rename(target, backup);
          backupExists = true;
          backupIdentity = await lstat(backup);
          if (!sameIdentity(original, backupIdentity)) {
            throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file changed while it was moved to rollback storage");
          }
        }
        try {
          if (temporaryIdentity === undefined) {
            throw new ProjectFileOperationError("PROJECT_FILE_UPLOAD_FAILED", "Project file upload staging did not complete");
          }
          const staged = await existingRegularFile(temporary);
          if (staged === undefined || !sameIdentity(staged, temporaryIdentity)) {
            throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file upload staging changed before publication");
          }
          // A hard-link publish is atomic and cannot silently replace a concurrently created target.
          await link(temporary, target);
          publishedIdentity = await lstat(target);
          if (!sameIdentity(publishedIdentity, temporaryIdentity)) {
            throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file upload staging changed during publication");
          }
          if (!await removeIfSameIdentity(temporary, temporaryIdentity)) {
            throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file upload staging changed during cleanup");
          }
          temporaryExists = false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new ProjectFileOperationError("PROJECT_FILE_CHANGED_EXTERNALLY", "Project file target appeared during upload");
          }
          throw error;
        }

        if (backupExists) {
          if (backupIdentity === undefined || !await removeIfSameIdentity(backup, backupIdentity)) {
            throw new ProjectFileOperationError("PROJECT_FILE_ROLLBACK_FAILED", "Original Project file rollback storage changed unexpectedly");
          }
          backupExists = false;
          originalDetached = true;
        }

        const report = await validateRepository(metadata.worktree_path);
        if (!report.valid) {
          throw new ProjectFileOperationError("PROJECT_FILE_VALIDATION_FAILED", report.errors[0]?.message ?? "Repository validation failed");
        }
        const checked = input.mode === "replace" && input.referenceMode === "preserve_checked"
          ? await this.checkedReferences(metadata as unknown as RepositoryWorkspace, projectId, input.name)
          : undefined;
        const references: ProjectFileReferencesChecked | undefined = checked === undefined ? undefined : {
          status: "checked", action: "preserved", before_count: checked.preview.count,
          affected_count: 0, remaining_count: checked.preview.count, locations: checked.preview.locations,
        };
        const stat = await lstat(target);
        return { operation: original === undefined ? "created" : "replaced", item: itemFromStat(projectId, input.name, stat), references };
      } catch (error) {
        if (publishedIdentity !== undefined) {
          const current = await existingRegularFile(target);
          if (current !== undefined && sameIdentity(current, publishedIdentity)) await rm(target);
        }
        if (backupExists) {
          try {
            if (backupIdentity === undefined || !sameIdentity(await lstat(backup), backupIdentity)) throw new Error("backup identity changed");
            if (await existingRegularFile(target) !== undefined) throw new Error("target occupied during rollback");
            await rename(backup, target);
            backupExists = false;
          } catch {
            throw new ProjectFileOperationError("PROJECT_FILE_ROLLBACK_FAILED", "Project file upload failed and the original file could not be restored safely");
          }
        } else if (original !== undefined && originalDetached && originalHandle !== undefined) {
          await restoreFromHandle(filesDirectory, target, originalHandle, original.size);
        }
        throw error;
      } finally {
        if (temporaryExists && temporaryIdentity !== undefined) await removeIfSameIdentity(temporary, temporaryIdentity);
        await originalHandle?.close();
      }
    } catch (error) {
      await removeEmptyCreatedDirectory(filesDirectory, filesDirectoryCreated);
      filesystemError(error, "PROJECT_FILE_NOT_FOUND", "Project file does not exist");
    }
  }
}
