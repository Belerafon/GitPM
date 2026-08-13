import { constants, type Stats } from "node:fs";
import { lstat, open, readFile, readdir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ProjectFileItem, ProjectFileList } from "@gitpm/contracts";
import type { DraftManager, RepositoryWorkspace } from "@gitpm/drafts";
import { parseYamlDocument } from "@gitpm/repository-format";
import { resolveDomainPath, SecurityBoundaryError } from "@gitpm/security";
import { ENTITY_ID_PREFIX, isEntityId } from "@gitpm/shared";
import { projectFileNameInvalidReason } from "@gitpm/validation";

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

export class ProjectFileStore {
  constructor(private readonly drafts: DraftManager) {}

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
}
