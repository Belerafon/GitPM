import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ProjectFileItem, ProjectFileList, ProjectFileUploadResult } from "@gitpm/contracts";
import type { DraftManager, DraftMetadata, RepositoryWorkspace } from "@gitpm/drafts";
import { parseYamlDocument } from "@gitpm/repository-format";
import { resolveDomainPath, SecurityBoundaryError } from "@gitpm/security";
import { ENTITY_ID_PREFIX, isEntityId } from "@gitpm/shared";
import { projectFileNameComparisonKey, projectFileNameInvalidReason, validateRepository } from "@gitpm/validation";

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
  readonly largeFileConfirmation?: string;
  readonly content: AsyncIterable<Uint8Array>;
}

export interface ProjectFileStoreOptions {
  readonly maxUploadBytes?: number;
  readonly beforeFinalizeForTest?: () => Promise<void>;
}

interface DirectorySnapshot {
  readonly path: string;
  readonly canonicalPath: string;
  readonly dev: number;
  readonly ino: number;
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
      draft_fingerprint: mutation.metadata.fingerprint,
    };
  }

  private async uploadInWorkspace(
    metadata: DraftMetadata,
    projectId: string,
    input: ProjectFileUploadInput,
  ): Promise<{ readonly operation: "created" | "replaced"; readonly item: ProjectFileItem }> {
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
        const stat = await lstat(target);
        return { operation: original === undefined ? "created" : "replaced", item: itemFromStat(projectId, input.name, stat) };
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
