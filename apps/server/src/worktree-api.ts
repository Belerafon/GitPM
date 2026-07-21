import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { DraftManager } from "@gitpm/drafts";
import { resolveDomainPath, SecurityBoundaryError } from "@gitpm/security";
import type { Authenticate } from "./draft-api.js";

const MAX_TEXT_FILE_BYTES = 1_048_576;

type WorktreeEntryType = "directory" | "file" | "symlink" | "other";

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

async function draftRoot(manager: DraftManager, authenticate: Authenticate, request: Parameters<Authenticate>[0], draftId: string): Promise<string> {
  const actor = await authenticate(request);
  const draft = await manager.getDraft(draftId);
  if (draft.owner_gitlab_user_id !== actor.userId && actor.role !== "Maintainer") {
    throw new WorktreeReadError("DRAFT_FORBIDDEN", "Draft owner mismatch");
  }
  return draft.worktree_path;
}

export function registerWorktreeApi(app: FastifyInstance, manager: DraftManager, authenticate: Authenticate): void {
  app.get<{ Params: { draftId: string }; Querystring: { path?: string } }>("/api/drafts/:draftId/worktree", async (request) => {
    const root = await draftRoot(manager, authenticate, request, request.params.draftId);
    const relativePath = requestedPath(request.query.path, true);
    const absolutePath = await containedPath(root, relativePath);
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
    const absolutePath = await containedPath(root, relativePath);
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
}
