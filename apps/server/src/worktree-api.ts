import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { DraftManager } from "@gitpm/drafts";
import { resolveDomainPath, SecurityBoundaryError } from "@gitpm/security";
import type { Authenticate, RequestActor } from "./draft-api.js";

const MAX_TEXT_FILE_BYTES = 1_048_576;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_BODY_LIMIT = 15 * 1024 * 1024;

type WorktreeEntryType = "directory" | "file" | "symlink" | "other";

export interface WorktreeApiOptions {
  readonly beforeGuardedMutationForTest?: () => Promise<void>;
}

interface ParentSnapshot {
  readonly path: string;
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
}

export class WorktreeReadError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WorktreeReadError";
  }
}

function requestedPath(value: unknown, allowRoot: boolean): string {
  if (value === undefined && allowRoot) return "";
  if (typeof value !== "string" || (!allowRoot && value === "")) {
    throw new WorktreeReadError("WORKTREE_PATH_INVALID", "A repository-relative path is required");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.toLocaleLowerCase("en-US") === ".git")) {
    throw new WorktreeReadError("WORKTREE_PATH_FORBIDDEN", "Git metadata is not available through the working tree browser");
  }
  return value;
}

async function containedPath(root: string, relativePath: string): Promise<string> {
  if (relativePath === "") return await realpath(root);
  try {
    return await resolveDomainPath(root, relativePath);
  } catch (error) {
    if (error instanceof SecurityBoundaryError) {
      throw new WorktreeReadError("WORKTREE_PATH_FORBIDDEN", "The requested path is outside the working tree boundary");
    }
    throw error;
  }
}

async function safeTarget(root: string, relativePath: string): Promise<string> {
  try {
    return await containedPath(root, relativePath);
  } catch (error) {
    if (error instanceof WorktreeReadError) throw error;
    statusFor(error as NodeJS.ErrnoException);
  }
}

function entryType(stat: Awaited<ReturnType<typeof lstat>>): WorktreeEntryType {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

function statusFor(error: NodeJS.ErrnoException): never {
  if (error.code === "ENOENT") throw new WorktreeReadError("WORKTREE_ENTRY_NOT_FOUND", "The requested working tree entry does not exist");
  if (error.code === "EACCES" || error.code === "EPERM") throw new WorktreeReadError("WORKTREE_PATH_FORBIDDEN", "The requested working tree entry cannot be read");
  throw error;
}

async function assertExists(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    statusFor(error as NodeJS.ErrnoException);
  }
}

async function assertAbsent(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") statusFor(error as NodeJS.ErrnoException);
    return;
  }
  throw new WorktreeReadError("WORKTREE_ENTRY_EXISTS", "An entry with this path already exists");
}

function requireMutationActor(actor: RequestActor): void {
  if (actor.role !== "Developer" && actor.role !== "Maintainer") {
    throw new WorktreeReadError("DRAFT_FORBIDDEN", "Project role is read-only");
  }
}

function parentChanged(): WorktreeReadError {
  return new WorktreeReadError("WORKTREE_PATH_FORBIDDEN", "The target folder changed during the operation");
}

async function parentIdentity(parent: string): Promise<{ readonly device: number; readonly inode: number }> {
  try {
    const stat = await lstat(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw parentChanged();
    return { device: stat.dev, inode: stat.ino };
  } catch (error) {
    if (error instanceof WorktreeReadError) throw error;
    throw parentChanged();
  }
}

function sameIdentity(left: { readonly device: number; readonly inode: number }, right: { readonly device: number; readonly inode: number }): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function snapshotParents(targets: readonly string[]): Promise<readonly ParentSnapshot[]> {
  const parents = [...new Set(targets.map((target) => path.dirname(target)))];
  return await Promise.all(parents.map(async (parent) => {
    const before = await parentIdentity(parent);
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(parent);
    } catch {
      throw parentChanged();
    }
    const after = await parentIdentity(parent);
    if (!sameIdentity(before, after)) throw parentChanged();
    return { path: parent, canonicalPath, device: after.device, inode: after.inode };
  }));
}

async function assertParentsUnchanged(snapshots: readonly ParentSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    const before = await parentIdentity(snapshot.path);
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(snapshot.path);
    } catch {
      throw parentChanged();
    }
    const after = await parentIdentity(snapshot.path);
    if (
      canonicalPath !== snapshot.canonicalPath ||
      !sameIdentity(before, after) ||
      !sameIdentity(after, { device: snapshot.device, inode: snapshot.inode })
    ) {
      throw parentChanged();
    }
  }
}

async function atomicWriteBytes(target: string, bytes: Buffer): Promise<void> {
  const parent = path.dirname(target);
  const canonicalParent = await realpath(parent);
  const tempPath = path.join(parent, `.gitpm-upload-${randomUUID()}.tmp`);
  let tempCreated = false;
  try {
    const handle = await open(tempPath, "wx", 0o600);
    tempCreated = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await realpath(parent) !== canonicalParent) {
      throw new WorktreeReadError("WORKTREE_PATH_FORBIDDEN", "The target folder changed during upload");
    }
    try {
      const targetStat = await lstat(target);
      if (targetStat.isSymbolicLink()) throw new WorktreeReadError("WORKTREE_PATH_FORBIDDEN", "The target path is a symlink");
    } catch (error) {
      if (error instanceof WorktreeReadError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(tempPath, target);
    tempCreated = false;
  } finally {
    if (tempCreated) {
      try {
        if (await realpath(parent) === canonicalParent) await rm(tempPath, { force: true });
      } catch {
        // A changed or missing parent leaves at most an unreferenced random temp file.
      }
    }
  }
}

function decodeUpload(contentBase64: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(contentBase64) || contentBase64.length % 4 !== 0) {
    throw new WorktreeReadError("WORKTREE_UPLOAD_INVALID", "The uploaded file content is not valid base64");
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new WorktreeReadError("WORKTREE_UPLOAD_TOO_LARGE", "The uploaded file exceeds the 10 MiB limit");
  }
  return bytes;
}

async function draftRoot(manager: DraftManager, authenticate: Authenticate, request: Parameters<Authenticate>[0], draftId: string): Promise<string> {
  const actor = await authenticate(request);
  const draft = await manager.getDraft(draftId);
  if (draft.owner_gitlab_user_id !== actor.userId && actor.role !== "Maintainer") {
    throw new WorktreeReadError("DRAFT_FORBIDDEN", "Draft owner mismatch");
  }
  return draft.worktree_path;
}

export function registerWorktreeApi(app: FastifyInstance, manager: DraftManager, authenticate: Authenticate, options: WorktreeApiOptions = {}): void {
  app.get<{ Params: { draftId: string }; Querystring: { path?: string } }>("/api/drafts/:draftId/worktree", async (request) => {
    const root = await draftRoot(manager, authenticate, request, request.params.draftId);
    const relativePath = requestedPath(request.query.path, true);
    const absolutePath = await safeTarget(root, relativePath);
    let directoryStat;
    try {
      directoryStat = await lstat(absolutePath);
    } catch (error) {
      statusFor(error as NodeJS.ErrnoException);
    }
    if (!directoryStat.isDirectory()) {
      throw new WorktreeReadError("WORKTREE_NOT_DIRECTORY", "The requested working tree entry is not a directory");
    }

    let names: readonly string[];
    try {
      names = await readdir(absolutePath);
    } catch (error) {
      statusFor(error as NodeJS.ErrnoException);
    }
    const entries = await Promise.all(names
      .filter((name) => name.toLocaleLowerCase("en-US") !== ".git")
      .map(async (name) => {
        const childPath = relativePath === "" ? name : `${relativePath}/${name}`;
        const childStat = await lstat(path.join(absolutePath, name));
        const type = entryType(childStat);
        return { name, path: childPath, type, ...(type === "file" ? { size: childStat.size } : {}) };
      }));
    entries.sort((left, right) => {
      if (left.type === "directory" && right.type !== "directory") return -1;
      if (left.type !== "directory" && right.type === "directory") return 1;
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    });
    return { path: relativePath, entries };
  });

  app.get<{ Params: { draftId: string }; Querystring: { path?: string } }>("/api/drafts/:draftId/worktree/file", async (request) => {
    const root = await draftRoot(manager, authenticate, request, request.params.draftId);
    const relativePath = requestedPath(request.query.path, false);
    const absolutePath = await safeTarget(root, relativePath);
    let handle;
    try {
      handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      statusFor(error as NodeJS.ErrnoException);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new WorktreeReadError("WORKTREE_NOT_FILE", "The requested working tree entry is not a regular file");
      if (stat.size > MAX_TEXT_FILE_BYTES) {
        throw new WorktreeReadError("WORKTREE_FILE_TOO_LARGE", "The file is larger than the 1 MiB preview limit");
      }
      const buffer = Buffer.alloc(Math.min(MAX_TEXT_FILE_BYTES + 1, Math.max(1, stat.size + 1)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_TEXT_FILE_BYTES) {
        throw new WorktreeReadError("WORKTREE_FILE_TOO_LARGE", "The file is larger than the 1 MiB preview limit");
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
      } catch {
        throw new WorktreeReadError("WORKTREE_FILE_BINARY", "Binary files cannot be previewed as text");
      }
      if (content.includes("\0")) throw new WorktreeReadError("WORKTREE_FILE_BINARY", "Binary files cannot be previewed as text");
      return { path: relativePath, size: bytesRead, content };
    } finally {
      await handle.close();
    }
  });

  app.delete<{ Params: { draftId: string }; Body: { expected_fingerprint: string; path: string } }>(
    "/api/drafts/:draftId/worktree/entry",
    async (request) => {
      const actor = await authenticate(request);
      requireMutationActor(actor);
      const relativePath = requestedPath(request.body.path, false);
      const outcome = await manager.withUiMutation(request.params.draftId, actor.userId, request.body.expected_fingerprint, async (metadata) => {
        const target = await safeTarget(metadata.worktree_path, relativePath);
        await assertExists(target);
        const parents = await snapshotParents([target]);
        await options.beforeGuardedMutationForTest?.();
        await assertParentsUnchanged(parents);
        await rm(target, { recursive: true, force: false });
        return { path: relativePath };
      });
      return { path: outcome.result.path, draft_fingerprint: outcome.metadata.fingerprint };
    },
  );

  app.post<{ Params: { draftId: string }; Body: { expected_fingerprint: string; path: string } }>(
    "/api/drafts/:draftId/worktree/directory",
    async (request, reply) => {
      const actor = await authenticate(request);
      requireMutationActor(actor);
      const relativePath = requestedPath(request.body.path, false);
      const outcome = await manager.withUiMutation(request.params.draftId, actor.userId, request.body.expected_fingerprint, async (metadata) => {
        const target = await safeTarget(metadata.worktree_path, relativePath);
        await assertAbsent(target);
        const parents = await snapshotParents([target]);
        await options.beforeGuardedMutationForTest?.();
        await assertParentsUnchanged(parents);
        await assertAbsent(target);
        await mkdir(target, { mode: 0o755 });
        return { path: relativePath };
      });
      await reply.code(201).send({ path: outcome.result.path, draft_fingerprint: outcome.metadata.fingerprint });
    },
  );

  app.post<{ Params: { draftId: string }; Body: { expected_fingerprint: string; path: string; content_base64: string } }>(
    "/api/drafts/:draftId/worktree/file",
    { bodyLimit: UPLOAD_BODY_LIMIT },
    async (request, reply) => {
      const actor = await authenticate(request);
      requireMutationActor(actor);
      const relativePath = requestedPath(request.body.path, false);
      const bytes = decodeUpload(request.body.content_base64);
      const outcome = await manager.withUiMutation(request.params.draftId, actor.userId, request.body.expected_fingerprint, async (metadata) => {
        const target = await safeTarget(metadata.worktree_path, relativePath);
        await atomicWriteBytes(target, bytes);
        return { path: relativePath, size: bytes.byteLength };
      });
      await reply.code(201).send({ path: outcome.result.path, size: outcome.result.size, draft_fingerprint: outcome.metadata.fingerprint });
    },
  );

  app.post<{ Params: { draftId: string }; Body: { expected_fingerprint: string; from: string; to: string } }>(
    "/api/drafts/:draftId/worktree/move",
    async (request) => {
      const actor = await authenticate(request);
      requireMutationActor(actor);
      const fromPath = requestedPath(request.body.from, false);
      const toPath = requestedPath(request.body.to, false);
      const outcome = await manager.withUiMutation(request.params.draftId, actor.userId, request.body.expected_fingerprint, async (metadata) => {
        const from = await safeTarget(metadata.worktree_path, fromPath);
        const to = await safeTarget(metadata.worktree_path, toPath);
        await assertExists(from);
        await assertAbsent(to);
        const relative = path.relative(from, to);
        if (relative === "" || !relative.startsWith("..")) {
          throw new WorktreeReadError("WORKTREE_MOVE_INVALID", "Cannot move an entry into itself or one of its descendants");
        }
        const parents = await snapshotParents([from, to]);
        await options.beforeGuardedMutationForTest?.();
        await assertParentsUnchanged(parents);
        await assertExists(from);
        await assertAbsent(to);
        await rename(from, to);
        return { from: fromPath, to: toPath };
      });
      return { from: outcome.result.from, to: outcome.result.to, draft_fingerprint: outcome.metadata.fingerprint };
    },
  );
}
