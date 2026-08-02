import { lstat, rm } from "node:fs/promises";
import { GITPM_GUIDANCE_PATHS, type DraftManager, type DraftMetadata } from "@gitpm/drafts";
import { GitCommandError } from "@gitpm/git-client";
import type { GitClient, GitCommitDetail, GitHistoryEntry } from "@gitpm/git-client";
import { resolveDomainPath } from "@gitpm/security";
import { validateRepository, type ValidationIssue } from "@gitpm/validation";

export interface HistorySemanticSummary {
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  readonly affected_projects: readonly string[];
}

export interface CommitHistoryItem extends GitHistoryEntry {
  readonly semantic_summary: HistorySemanticSummary;
}

export interface CommitHistoryDetail extends GitCommitDetail {
  readonly semantic_summary: HistorySemanticSummary;
}

export interface CommitFileDiff {
  readonly diff: string;
  readonly oversized: boolean;
}

export interface RevertDraftResult {
  readonly draft: DraftMetadata;
  readonly reverted_commit: string;
  readonly conflicted: boolean;
  readonly conflicted_files: readonly string[];
}

export interface RestoreCommitFilesResult {
  readonly restored_commit: string;
  readonly restored_paths: readonly string[];
  readonly draft_fingerprint: string;
}

export interface DirectRevertResult {
  readonly commit: string;
  readonly reverted_commit: string;
  readonly branch: string;
  readonly draft_fingerprint: string;
}

function assertRepositoryRelativePath(relativePath: string): string {
  if (relativePath.includes("\\") || relativePath.startsWith("/") || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new HistoryError("HISTORY_PATH_INVALID", "History path must be a normalized repository-relative path");
  }
  return relativePath;
}

function assertDirectMode(drafts: DraftManager): void {
  if (drafts.repositoryMode !== "direct") throw new HistoryError("HISTORY_DIRECT_MODE_REQUIRED", "This history operation is available only in direct repository mode");
}

function assertRestorablePaths(paths: readonly string[], maximum = 200): readonly string[] {
  if (paths.length === 0) throw new HistoryError("HISTORY_FILES_REQUIRED", "The selected commit has no files to restore");
  if (paths.length > maximum) throw new HistoryError("HISTORY_FILES_REQUIRED", `Choose no more than ${maximum} files to restore`);
  const normalized = [...new Set(paths.map(assertRepositoryRelativePath))].sort();
  const guidancePaths: readonly string[] = GITPM_GUIDANCE_PATHS;
  const guidance = normalized.find((value) => guidancePaths.includes(value));
  if (guidance !== undefined) throw new HistoryError("HISTORY_GUIDANCE_RESTORE_FORBIDDEN", "Generated agent guidance cannot be restored from business history");
  return normalized;
}

async function removeRepositoryFile(root: string, relativePath: string): Promise<void> {
  try {
    await rm(await resolveDomainPath(root, relativePath), { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertSafeRepositoryPath(root: string, relativePath: string): Promise<void> {
  const segments = relativePath.split("/");
  for (let index = 1; index <= segments.length; index += 1) {
    const candidate = await resolveDomainPath(root, segments.slice(0, index).join("/"));
    try {
      await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function summarizeFiles(files: readonly { readonly path: string; readonly status: "Added" | "Modified" | "Deleted" }[]): HistorySemanticSummary {
  let created = 0;
  let updated = 0;
  let deleted = 0;
  const projects = new Set<string>();
  for (const file of files) {
    const project = /^projects\/([^/]+)\//u.exec(file.path)?.[1];
    if (project !== undefined) projects.add(project);
    if (file.status === "Added") created += 1;
    else if (file.status === "Deleted") deleted += 1;
    else updated += 1;
  }
  return { created, updated, deleted, affected_projects: [...projects].sort() };
}

export class HistoryService {
  constructor(
    private readonly drafts: DraftManager,
    private readonly git: GitClient,
  ) {}

  async list(draftId: string, limit = 50): Promise<readonly CommitHistoryItem[]> {
    const draft = await this.drafts.getWorkspace(draftId);
    const [entries, statuses] = await Promise.all([
      this.git.history(draft.worktree_path, limit),
      this.git.historyFileStatuses(draft.worktree_path, limit),
    ]);
    return entries.map((entry) => ({ ...entry, semantic_summary: summarizeFiles(statuses.get(entry.commit) ?? []) }));
  }

  async detail(draftId: string, commit: string): Promise<CommitHistoryDetail> {
    const draft = await this.drafts.getWorkspace(draftId);
    const detail = await this.git.commitDetail(draft.worktree_path, commit);
    return { ...detail, semantic_summary: summarizeFiles(detail.files) };
  }

  async fileDiff(draftId: string, commit: string, relativePath: string): Promise<CommitFileDiff> {
    assertRepositoryRelativePath(relativePath);
    const draft = await this.drafts.getWorkspace(draftId);
    try {
      const diff = await this.git.commitFileDiff(draft.worktree_path, commit, relativePath);
      return { diff, oversized: false };
    } catch (error) {
      if (error instanceof GitCommandError && error.code === "GIT_OUTPUT_LIMIT") return { diff: "", oversized: true };
      throw error;
    }
  }

  async fileHistory(draftId: string, relativePath: string, limit = 50): Promise<readonly GitHistoryEntry[]> {
    assertRepositoryRelativePath(relativePath);
    const draft = await this.drafts.getWorkspace(draftId);
    return await this.git.fileHistory(draft.worktree_path, relativePath, limit);
  }

  async createRevertDraft(sourceDraftId: string, commit: string, newDraftId: string, owner: string): Promise<RevertDraftResult> {
    const source = await this.drafts.getWorkspace(sourceDraftId);
    await this.git.commitDetail(source.worktree_path, commit);
    await this.git.assertCommitOnRemoteDefault(commit);
    const draft = await this.drafts.createDraft(newDraftId, owner);
    const revert = await this.git.revertNoCommit(draft.worktree_path, commit);
    let refreshed = await this.drafts.refreshFingerprint(draft.draft_id);
    if (revert.conflicted) refreshed = await this.drafts.setWriterMode(draft.draft_id, owner, "external");
    return { draft: refreshed, reverted_commit: commit, ...revert };
  }

  async restoreCommitFiles(
    workspaceId: string,
    commit: string,
    paths: readonly string[],
    owner: string,
    expectedFingerprint: string,
  ): Promise<RestoreCommitFilesResult> {
    assertDirectMode(this.drafts);
    const requested = assertRestorablePaths(paths);
    const mutation = await this.drafts.withRepositoryMutation(workspaceId, owner, expectedFingerprint, "repository", async (workspace) => {
      await this.git.assertCheckoutOnDefaultBranch(workspace.worktree_path);
      const detail = await this.git.commitDetail(workspace.worktree_path, commit);
      const changed = new Map(detail.files.map((file) => [file.path, file]));
      const unavailable = requested.find((value) => !changed.has(value));
      if (unavailable !== undefined) throw new HistoryError("HISTORY_FILE_NOT_IN_COMMIT", `${unavailable} was not changed by the selected commit`);
      for (const relativePath of requested) await assertSafeRepositoryPath(workspace.worktree_path, relativePath);
      if ((await this.git.statusPorcelainPaths(workspace.worktree_path, requested)).trim() !== "") {
        throw new HistoryError("HISTORY_SELECTED_FILE_DIRTY", "A selected file already has uncommitted changes");
      }
      const head = await this.git.headCommit(workspace.worktree_path);
      const headPaths = await this.git.existingPathsAtCommit(workspace.worktree_path, head, requested);
      try {
        const present = requested.filter((value) => changed.get(value)?.status !== "Deleted");
        const deleted = requested.filter((value) => changed.get(value)?.status === "Deleted");
        await this.git.restorePathsFromCommit(workspace.worktree_path, detail.commit, present);
        for (const relativePath of deleted) await removeRepositoryFile(workspace.worktree_path, relativePath);
        const validation = await validateRepository(workspace.worktree_path);
        if (!validation.valid) throw new HistoryError("HISTORY_VALIDATION_FAILED", "Restored files do not form a valid repository", validation.errors);
      } catch (error) {
        const existingAtHead = requested.filter((value) => headPaths.has(value));
        const absentAtHead = requested.filter((value) => !headPaths.has(value));
        await this.git.restorePathsFromCommit(workspace.worktree_path, head, existingAtHead);
        for (const relativePath of absentAtHead) await removeRepositoryFile(workspace.worktree_path, relativePath);
        throw error;
      }
      return { restored_commit: detail.commit, restored_paths: requested };
    });
    return { ...mutation.result, draft_fingerprint: mutation.metadata.fingerprint };
  }

  async revertDirect(
    workspaceId: string,
    commit: string,
    message: string,
    owner: string,
    expectedFingerprint: string,
    authorName: string,
    authorEmail: string,
  ): Promise<DirectRevertResult> {
    assertDirectMode(this.drafts);
    if (!message.trim() || message.length > 500 || /[\r\n\0]/u.test(message)) {
      throw new HistoryError("HISTORY_REVERT_MESSAGE_INVALID", "Reverse commit message must be one non-empty line up to 500 characters");
    }
    const mutation = await this.drafts.withRepositoryMutation(workspaceId, owner, expectedFingerprint, "repository", async (workspace) => {
      const branch = await this.git.assertCheckoutOnDefaultBranch(workspace.worktree_path);
      if ((await this.git.statusPorcelain(workspace.worktree_path, GITPM_GUIDANCE_PATHS)).trim() !== "") {
        throw new HistoryError("HISTORY_WORKSPACE_DIRTY", "Creating a reverse commit requires a clean working tree");
      }
      const detail = await this.git.commitDetail(workspace.worktree_path, commit);
      const paths = assertRestorablePaths(detail.files.map((file) => file.path), Number.MAX_SAFE_INTEGER);
      const head = await this.git.headCommit(workspace.worktree_path);
      let committed = false;
      try {
        const reverted = await this.git.revertNoCommit(workspace.worktree_path, detail.commit);
        if (reverted.conflicted) {
          throw new HistoryError("HISTORY_REVERT_CONFLICT", "The selected commit cannot be reverted automatically", reverted.conflicted_files);
        }
        const validation = await validateRepository(workspace.worktree_path);
        if (!validation.valid) throw new HistoryError("HISTORY_VALIDATION_FAILED", "The reverse commit would make the repository invalid", validation.errors);
        const created = await this.git.commitAll(workspace.worktree_path, message, authorName, authorEmail, GITPM_GUIDANCE_PATHS);
        committed = true;
        return { commit: created, reverted_commit: detail.commit, branch };
      } finally {
        if (!committed) {
          await this.git.restorePathsFromCommit(workspace.worktree_path, head, paths, true);
          await this.git.clearRevertState(workspace.worktree_path);
        }
      }
    });
    return { ...mutation.result, draft_fingerprint: mutation.metadata.fingerprint };
  }
}

export class HistoryError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: readonly string[] | readonly ValidationIssue[]) {
    super(message);
    this.name = "HistoryError";
  }
}
