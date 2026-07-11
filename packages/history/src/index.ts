import type { DraftManager, DraftMetadata } from "@gitpm/drafts";
import type { GitClient, GitCommitDetail, GitHistoryEntry } from "@gitpm/git-client";

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

export interface RevertDraftResult {
  readonly draft: DraftMetadata;
  readonly reverted_commit: string;
  readonly conflicted: boolean;
  readonly conflicted_files: readonly string[];
}

function summarizePaths(paths: readonly string[], statuses?: readonly string[]): HistorySemanticSummary {
  let created = 0;
  let updated = 0;
  let deleted = 0;
  const projects = new Set<string>();
  paths.forEach((path, index) => {
    const project = /^projects\/([^/]+)\//u.exec(path)?.[1];
    if (project !== undefined) projects.add(project);
    const status = statuses?.[index] ?? "M";
    if (status.startsWith("A")) created += 1;
    else if (status.startsWith("D")) deleted += 1;
    else updated += 1;
  });
  return { created, updated, deleted, affected_projects: [...projects].sort() };
}

export class HistoryService {
  constructor(
    private readonly drafts: DraftManager,
    private readonly git: GitClient,
  ) {}

  async list(draftId: string, limit = 50): Promise<readonly CommitHistoryItem[]> {
    const draft = await this.drafts.getDraft(draftId);
    const entries = await this.git.history(draft.worktree_path, limit);
    return entries.map((entry) => ({ ...entry, semantic_summary: summarizePaths([]) }));
  }

  async detail(draftId: string, commit: string): Promise<CommitHistoryDetail> {
    const draft = await this.drafts.getDraft(draftId);
    const detail = await this.git.commitDetail(draft.worktree_path, commit);
    return { ...detail, semantic_summary: summarizePaths(detail.files.map((file) => file.path)) };
  }

  async fileHistory(draftId: string, relativePath: string, limit = 50): Promise<readonly GitHistoryEntry[]> {
    if (relativePath.includes("\\") || relativePath.startsWith("/") || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new HistoryError("HISTORY_PATH_INVALID", "History path must be a normalized repository-relative path");
    }
    const draft = await this.drafts.getDraft(draftId);
    return await this.git.fileHistory(draft.worktree_path, relativePath, limit);
  }

  async createRevertDraft(sourceDraftId: string, commit: string, newDraftId: string, owner: string): Promise<RevertDraftResult> {
    const source = await this.drafts.getDraft(sourceDraftId);
    await this.git.commitDetail(source.worktree_path, commit);
    await this.git.assertCommitOnRemoteDefault(commit);
    const draft = await this.drafts.createDraft(newDraftId, owner);
    const revert = await this.git.revertNoCommit(draft.worktree_path, commit);
    let refreshed = await this.drafts.refreshFingerprint(draft.draft_id);
    if (revert.conflicted) refreshed = await this.drafts.setWriterMode(draft.draft_id, owner, "external");
    return { draft: refreshed, reverted_commit: commit, ...revert };
  }
}

export class HistoryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "HistoryError";
  }
}
