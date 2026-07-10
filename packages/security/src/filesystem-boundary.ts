import { constants } from "node:fs";
import { access, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SecurityBoundaryError } from "./git-boundary.js";

function safeSegments(relativePath: string): string[] {
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new SecurityBoundaryError("FS_PATH_INVALID", "domain path must be relative");
  }
  const segments = relativePath.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new SecurityBoundaryError("FS_PATH_INVALID", "domain path contains an unsafe segment");
  }
  return segments;
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new SecurityBoundaryError("FS_PATH_ESCAPE", "domain path escapes worktree");
  }
}

export async function resolveDomainPath(root: string, relativePath: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const segments = safeSegments(relativePath);
  const candidate = path.resolve(canonicalRoot, ...segments);
  assertContained(canonicalRoot, candidate);

  let current = canonicalRoot;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new SecurityBoundaryError("FS_SYMLINK", "domain path contains a symlink");
      }
    } catch (error) {
      if (error instanceof SecurityBoundaryError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" || index !== segments.length - 1) throw error;
    }
  }
  return candidate;
}

interface AtomicWriteOptions {
  readonly beforeRenameForTest?: () => Promise<void>;
}

export async function atomicWriteDomainFile(
  root: string,
  relativePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const target = await resolveDomainPath(root, relativePath);
  const parent = path.dirname(target);
  const canonicalParent = await realpath(parent);
  const tempPath = path.join(parent, `.gitpm-${path.basename(target)}-${randomUUID()}.tmp`);
  let tempCreated = false;
  try {
    const handle = await open(tempPath, "wx", 0o600);
    tempCreated = true;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.beforeRenameForTest?.();
    if (await realpath(parent) !== canonicalParent) {
      throw new SecurityBoundaryError("FS_PARENT_CHANGED", "target parent changed before rename");
    }
    try {
      const targetStat = await lstat(target);
      if (targetStat.isSymbolicLink()) throw new SecurityBoundaryError("FS_SYMLINK", "target is a symlink");
    } catch (error) {
      if (error instanceof SecurityBoundaryError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(tempPath, target);
    tempCreated = false;
  } finally {
    if (tempCreated) {
      try {
        if (await realpath(parent) === canonicalParent) await rm(tempPath, { force: true });
      } catch {
        // A changed/missing parent leaves at most an unreferenced random temp file.
      }
    }
  }
}

export async function prepareControlledDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await access(directory, constants.R_OK | constants.W_OK);
}
