import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { DraftManager } from "@gitpm/drafts";
import type { GitClient } from "@gitpm/git-client";
import { atomicWriteDomainFile, resolveDomainPath } from "@gitpm/security";
import { validateRepository } from "@gitpm/validation";

export type ChangeKind = "Added" | "Modified" | "Deleted";

export interface FileChange {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly diff: string;
  readonly diff_token: string;
  readonly hunks: readonly DiffHunk[];
}

export interface DiffHunk {
  readonly old_start: number;
  readonly old_count: number;
  readonly new_start: number;
  readonly new_count: number;
  readonly lines: readonly string[];
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

function parseStatus(status: string): Array<{ path: string; kind: ChangeKind }> {
  const result: Array<{ path: string; kind: ChangeKind }> = [];
  const records = status.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.startsWith("? ")) {
      result.push({ path: record.slice(2), kind: "Added" });
    } else if (record.startsWith("1 ")) {
      const fields = record.split(" ");
      const xy = fields[1] ?? "";
      const changedPath = fields.slice(8).join(" ");
      result.push({ path: changedPath, kind: xy.includes("D") ? "Deleted" : xy.includes("A") ? "Added" : "Modified" });
    } else if (record.startsWith("2 ")) {
      const fields = record.split(" ");
      const changedPath = fields.slice(9).join(" ");
      const originalPath = records[index + 1];
      if (originalPath) {
        result.push({ path: originalPath, kind: "Deleted" }, { path: changedPath, kind: "Added" });
        index += 1;
      }
    }
  }
  return result;
}

export class ChangesService {
  constructor(
    private readonly drafts: DraftManager,
    private readonly git: GitClient,
  ) {}

  async list(draftId: string): Promise<{ files: readonly FileChange[]; changed_files_count: number; affected_projects: readonly string[] }> {
    const metadata = await this.drafts.getDraft(draftId);
    const status = parseStatus(await this.git.statusPorcelainZ(metadata.worktree_path));
    const files: FileChange[] = [];
    for (const change of status) {
      const relative = safeRelativePath(change.path);
      const diff = change.kind === "Added" ? "" : await this.git.diffFile(metadata.worktree_path, relative, 1);
      files.push({ path: relative, kind: change.kind, diff, diff_token: token(diff), hunks: parseUnifiedDiff(diff) });
    }
    const affected = new Set<string>();
    for (const file of files) {
      const match = /^projects\/(PRJ-[^/]+)/u.exec(file.path);
      if (match?.[1]) affected.add(match[1]);
    }
    return { files, changed_files_count: files.length, affected_projects: [...affected].sort() };
  }

  async restoreFile(draftId: string, owner: string, expectedFingerprint: string, relativePath: string) {
    const safePath = safeRelativePath(relativePath);
    return await this.drafts.withUiMutation(draftId, owner, expectedFingerprint, async (metadata) => {
      const head = await this.git.showHeadFile(metadata.worktree_path, safePath);
      await atomicWriteDomainFile(metadata.worktree_path, safePath, head);
      return { path: safePath, validation: await validateRepository(metadata.worktree_path) };
    });
  }

  async restoreHunk(
    draftId: string,
    owner: string,
    expectedFingerprint: string,
    relativePath: string,
    expectedDiffToken: string,
    hunkIndex: number,
  ) {
    const safePath = safeRelativePath(relativePath);
    return await this.drafts.withUiMutation(draftId, owner, expectedFingerprint, async (metadata) => {
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

  async discardAll(draftId: string, owner: string, expectedFingerprint: string) {
    const changes = await this.list(draftId);
    let fingerprint = expectedFingerprint;
    for (const change of changes.files) {
      if (change.kind === "Added") {
        const mutation = await this.drafts.withUiMutation(draftId, owner, fingerprint, async (metadata) => {
          const absolute = await resolveDomainPath(metadata.worktree_path, change.path);
          await rm(absolute);
          return change.path;
        });
        fingerprint = mutation.metadata.fingerprint;
      } else {
        const mutation = await this.restoreFile(draftId, owner, fingerprint, change.path);
        fingerprint = mutation.metadata.fingerprint;
      }
    }
    return { discarded: changes.changed_files_count, draft_fingerprint: fingerprint };
  }
}
