import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { GitClient } from "@gitpm/git-client";
import type { RepositoryMode } from "@gitpm/shared";
import { provisionGitPmDirectGuidance, type DirectGuidanceInfo } from "./direct-guidance.js";
import { provisionGitPmWorktreeGuidance } from "./worktree-guidance.js";

export interface DraftProvisioning {
  readonly branch: string;
  readonly worktreePath: string;
  readonly baseCommit: string;
}

export type DraftPushStrategy = (
  worktreePath: string,
  branch: string,
  accessToken: string,
) => Promise<{ branch: string; commit: string }>;

export interface DraftBackend {
  readonly mode: RepositoryMode;
  /** Validate or initialize backend-wide Git resources. */
  prepare(): Promise<void>;
  /** Provision the working tree for one draft and return its coordinates. */
  provision(draftId: string, owner: string): Promise<DraftProvisioning>;
  /** Provision or refresh agent guidance inside the working tree. */
  provisionGuidance(worktreePath: string, draftId: string): Promise<boolean>;
  /** Return whether a persisted working-tree path belongs to this backend mode. */
  ownsWorktree(worktreePath: string): Promise<boolean>;
  /** Remove a draft's working tree (no-op in direct mode). */
  remove(worktreePath: string, branch: string, force: boolean): Promise<void>;
  /** List worktrees that have no corresponding draft metadata (empty in direct mode). */
  listOrphanedWorktrees(knownPaths: readonly string[]): Promise<readonly string[]>;
}

/**
 * Default worktree backend: a bare repository plus one \`git worktree add\` per draft.
 * This preserves the original GitPM draft/isolation model.
 */
export class WorktreeDraftBackend implements DraftBackend {
  public readonly mode: RepositoryMode = "worktree";
  private readonly worktreesDirectory: string;

  constructor(
    private readonly git: GitClient,
    worktreesDirectory: string = git.worktreesDirectory,
  ) {
    this.worktreesDirectory = worktreesDirectory;
  }

  async prepare(): Promise<void> {
    await this.git.initialize();
  }

  async provision(draftId: string, owner: string): Promise<DraftProvisioning> {
    const baseCommit = await this.git.fetch();
    const branch = `gitpm/${owner}/${draftId}`;
    const worktree = await this.git.addWorktree(branch, draftId, baseCommit);
    return { branch, worktreePath: worktree, baseCommit };
  }

  provisionGuidance(worktreePath: string, draftId: string): Promise<boolean> {
    return provisionGitPmWorktreeGuidance(worktreePath, draftId);
  }

  async ownsWorktree(worktreePath: string): Promise<boolean> {
    try {
      const root = await this.git.checkoutRealPath(this.worktreesDirectory);
      const candidate = await this.git.checkoutRealPath(worktreePath);
      const relative = path.relative(root, candidate);
      return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    } catch {
      return false;
    }
  }

  async remove(worktreePath: string, branch: string, force: boolean): Promise<void> {
    await this.git.removeWorktree(worktreePath, branch, force);
  }

  async listOrphanedWorktrees(knownPaths: readonly string[]): Promise<readonly string[]> {
    await mkdir(this.worktreesDirectory, { recursive: true, mode: 0o700 });
    const known = new Set(knownPaths.map((value) => path.resolve(value)));
    const orphaned: string[] = [];
    for (const entry of await readdir(this.worktreesDirectory, { withFileTypes: true })) {
      if (entry.isDirectory() && !known.has(path.resolve(this.worktreesDirectory, entry.name))) {
        orphaned.push(entry.name);
      }
    }
    return orphaned.sort();
  }
}

/**
 * Direct backend: the selected ordinary Git checkout itself. There is no clone, bare repository,
 * draft branch, or \`git worktree\`. All drafts resolve to this checkout; creation is metadata-only.
 */
export class DirectDraftBackend implements DraftBackend {
  public readonly mode: RepositoryMode = "direct";
  public readonly checkoutPath: string;

  constructor(
    private readonly git: GitClient,
    checkoutPath: string,
  ) {
    this.checkoutPath = path.resolve(checkoutPath);
  }

  async prepare(): Promise<void> {
    await this.git.checkoutRealPath(this.checkoutPath);
    await this.git.checkoutCurrentBranch(this.checkoutPath);
    await this.git.headCommit(this.checkoutPath);
  }

  async provision(): Promise<DraftProvisioning> {
    const worktreePath = await this.git.checkoutRealPath(this.checkoutPath);
    const branch = await this.git.checkoutCurrentBranch(worktreePath);
    const baseCommit = await this.git.headCommit(worktreePath);
    return { branch, worktreePath, baseCommit };
  }

  async provisionGuidance(worktreePath: string): Promise<boolean> {
    const branch = await this.git.checkoutCurrentBranch(worktreePath);
    let remoteUrl: string | undefined;
    try {
      remoteUrl = await this.git.checkoutOriginUrl(worktreePath);
    } catch {
      remoteUrl = undefined;
    }
    const info: DirectGuidanceInfo = { checkoutPath: worktreePath, branch, ...(remoteUrl === undefined ? {} : { remoteUrl }) };
    return await provisionGitPmDirectGuidance(worktreePath, info);
  }

  async ownsWorktree(worktreePath: string): Promise<boolean> {
    try {
      return await this.git.checkoutRealPath(worktreePath) === await this.git.checkoutRealPath(this.checkoutPath);
    } catch {
      return false;
    }
  }

  async remove(): Promise<void> {
    // Direct mode never deletes the selected checkout. Local changes, local commits, and
    // user files must survive draft cleanup.
  }

  async listOrphanedWorktrees(): Promise<readonly string[]> {
    return [];
  }
}

export function worktreePushStrategy(git: GitClient): DraftPushStrategy {
  return async (worktreePath, branch, accessToken) => {
    await git.pushBranch(worktreePath, branch, accessToken);
    return { branch, commit: await git.headCommit(worktreePath) };
  };
}

export function directPushStrategy(git: GitClient): DraftPushStrategy {
  return async (worktreePath, _branch, accessToken) => {
    await git.fetchCheckoutRemote(worktreePath, accessToken);
    return await git.pushMainFastForward(worktreePath, accessToken);
  };
}
