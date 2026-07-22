import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { GitClient } from "@gitpm/git-client";
import { atomicWriteDomainFile, resolveDomainPath } from "@gitpm/security";
import type { DraftBackend, DraftPushStrategy } from "./draft-backend.js";
import { WorktreeDraftBackend, worktreePushStrategy } from "./draft-backend.js";

export { GITPM_AGENT_FILE, GITPM_GUIDANCE_FILES, GITPM_GUIDANCE_PATHS, GITPM_SKILL_FILE, GITPM_SKILL_FILE_CONTENT, gitPmAgentFile, provisionGitPmWorktreeGuidance, WorktreeGuidanceError } from "./worktree-guidance.js";
export { provisionGitPmDirectGuidance, gitPmDirectAgentFile, GITPM_DIRECT_SKILL_FILE_CONTENT, type DirectGuidanceInfo } from "./direct-guidance.js";
export type { DraftBackend, DraftProvisioning, DraftPushStrategy } from "./draft-backend.js";
export { DirectDraftBackend, WorktreeDraftBackend, directPushStrategy, worktreePushStrategy } from "./draft-backend.js";

export type WriterMode = "ui" | "external";
export type DraftState = "open" | "closed" | "published" | "abandoned";

export interface DraftMetadata {
  readonly version: 1;
  readonly draft_id: string;
  readonly owner_gitlab_user_id: string;
  readonly branch: string;
  readonly base_commit: string;
  readonly worktree_path: string;
  readonly writer_mode: WriterMode;
  readonly state: DraftState;
  readonly merge_request_iid?: number;
  readonly fingerprint: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RecoveryReport {
  readonly drafts: readonly DraftMetadata[];
  readonly orphaned_worktrees: readonly string[];
  readonly missing_worktrees: readonly string[];
}

export class DraftRuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DraftRuntimeError";
  }
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function safeComponent(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(value)) {
    throw new DraftRuntimeError("DRAFT_IDENTITY_INVALID", `${label} is invalid`);
  }
  return value;
}

async function yamlFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await yamlFiles(absolute));
    else if (entry.name.endsWith(".yaml")) result.push(absolute);
  }
  return result.sort();
}

export interface DraftManagerOptions {
  readonly backend?: DraftBackend;
  readonly push?: DraftPushStrategy;
}

export class DraftManager {
  private readonly dataDirectory: string;
  private readonly metadataDirectory: string;
  private readonly metadataRelativeDirectory: string;
  private readonly repositoryLock = new AsyncMutex();
  private readonly draftLocks = new Map<string, AsyncMutex>();
  private readonly backend: DraftBackend;
  private readonly pushStrategy: DraftPushStrategy;

  constructor(
    private readonly git: GitClient,
    dataDirectory: string,
    options: DraftManagerOptions = {},
  ) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.backend = options.backend ?? new WorktreeDraftBackend(git);
    this.pushStrategy = options.push ?? worktreePushStrategy(git);
    this.metadataRelativeDirectory = this.backend.mode === "direct" ? "drafts/direct" : "drafts";
    this.metadataDirectory = path.join(this.dataDirectory, ...this.metadataRelativeDirectory.split("/"));
  }

  get repositoryMode(): "direct" | "worktree" {
    return this.backend.mode;
  }

  private lock(draftId: string): AsyncMutex {
    let lock = this.draftLocks.get(draftId);
    if (!lock) {
      lock = new AsyncMutex();
      this.draftLocks.set(draftId, lock);
    }
    return lock;
  }

  private metadataRelativePath(draftId: string): string {
    return `${this.metadataRelativeDirectory}/${safeComponent(draftId, "draft ID")}.json`;
  }

  private parseMetadata(text: string, draftId: string): DraftMetadata {
    const value = JSON.parse(text) as DraftMetadata;
    if (value.version !== 1 || value.draft_id !== draftId) throw new Error("metadata identity mismatch");
    return value;
  }

  private async persist(metadata: DraftMetadata): Promise<void> {
    await atomicWriteDomainFile(this.dataDirectory, this.metadataRelativePath(metadata.draft_id), `${JSON.stringify(metadata, null, 2)}\n`);
  }

  private async readMetadata(draftId: string): Promise<DraftMetadata> {
    const metadataPath = await resolveDomainPath(this.dataDirectory, this.metadataRelativePath(draftId));
    try {
      return this.parseMetadata(await readFile(metadataPath, "utf8"), draftId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DraftRuntimeError("DRAFT_NOT_FOUND", `Draft ${draftId} not found`);
      throw new DraftRuntimeError("DRAFT_METADATA_INVALID", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Direct metadata originally lived beside worktree draft metadata. Move only records that
   * point at the canonical direct checkout; worktree records remain untouched and become
   * available again if the repository is switched back to worktree mode.
   */
  private async migrateLegacyDirectMetadata(): Promise<void> {
    if (this.backend.mode !== "direct") return;
    const legacyDirectory = path.join(this.dataDirectory, "drafts");
    const directDirectory = path.join(legacyDirectory, "direct");
    await mkdir(legacyDirectory, { recursive: true, mode: 0o700 });
    await mkdir(directDirectory, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(legacyDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const draftId = entry.name.slice(0, -5);
      const sourceRelative = `drafts/${safeComponent(draftId, "draft ID")}.json`;
      const source = await resolveDomainPath(this.dataDirectory, sourceRelative);
      let metadata: DraftMetadata;
      try {
        metadata = this.parseMetadata(await readFile(source, "utf8"), draftId);
      } catch (error) {
        throw new DraftRuntimeError("DRAFT_METADATA_INVALID", error instanceof Error ? error.message : String(error));
      }
      if (!(await this.backend.ownsWorktree(metadata.worktree_path))) continue;
      const destination = path.join(directDirectory, entry.name);
      try {
        await stat(destination);
        throw new DraftRuntimeError("DRAFT_METADATA_CONFLICT", `Direct metadata already exists for ${draftId}`);
      } catch (error) {
        if (error instanceof DraftRuntimeError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(source, destination);
    }
  }

  async fingerprint(worktree: string): Promise<string> {
    const canonical = await realpath(worktree);
    const hash = createHash("sha256");
    hash.update(await this.git.statusPorcelain(canonical));
    for (const file of await yamlFiles(canonical)) {
      const details = await stat(file);
      hash.update(path.relative(canonical, file).split(path.sep).join("/"));
      hash.update(String(details.size));
      hash.update(String(details.mtimeMs));
      hash.update(createHash("sha256").update(await readFile(file)).digest());
    }
    return hash.digest("hex");
  }

  async createDraft(draftIdInput: string, ownerInput: string): Promise<DraftMetadata> {
    const draftId = safeComponent(draftIdInput, "draft ID");
    const owner = safeComponent(ownerInput, "owner");
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.metadataDirectory, { recursive: true, mode: 0o700 });
    await this.migrateLegacyDirectMetadata();
    return await this.repositoryLock.run(async () => {
      try {
        await this.readMetadata(draftId);
        throw new DraftRuntimeError("DRAFT_EXISTS", `Draft ${draftId} already exists`);
      } catch (error) {
        if (!(error instanceof DraftRuntimeError) || error.code !== "DRAFT_NOT_FOUND") throw error;
      }
      await this.backend.prepare();
      const provisioning = await this.backend.provision(draftId, owner);
      await this.backend.provisionGuidance(provisioning.worktreePath, draftId);
      const now = new Date().toISOString();
      const metadata: DraftMetadata = {
        version: 1,
        draft_id: draftId,
        owner_gitlab_user_id: owner,
        branch: provisioning.branch,
        base_commit: provisioning.baseCommit,
        worktree_path: provisioning.worktreePath,
        writer_mode: "ui",
        state: "open",
        fingerprint: await this.fingerprint(provisioning.worktreePath),
        created_at: now,
        updated_at: now,
      };
      await this.persist(metadata);
      return metadata;
    });
  }

  async getDraft(draftId: string): Promise<DraftMetadata> {
    return await this.readMetadata(safeComponent(draftId, "draft ID"));
  }

  async listDrafts(): Promise<readonly DraftMetadata[]> {
    await this.migrateLegacyDirectMetadata();
    await mkdir(this.metadataDirectory, { recursive: true, mode: 0o700 });
    const drafts: DraftMetadata[] = [];
    for (const entry of await readdir(this.metadataDirectory)) {
      if (!entry.endsWith(".json")) continue;
      drafts.push(await this.readMetadata(entry.slice(0, -5)));
    }
    return drafts.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  /**
   * Direct mode has one internal workspace, even though the shared domain services still use
   * DraftMetadata. Reconcile it with the canonical checkout without deleting or modifying any
   * worktree-mode metadata or working tree.
   */
  async ensureDirectWorkspace(draftIdInput: string, ownerInput: string): Promise<DraftMetadata> {
    if (this.backend.mode !== "direct") {
      throw new DraftRuntimeError("DIRECT_WORKSPACE_REQUIRED", "Direct workspace reconciliation requires direct repository mode");
    }
    const draftId = safeComponent(draftIdInput, "draft ID");
    const owner = safeComponent(ownerInput, "owner");
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.metadataDirectory, { recursive: true, mode: 0o700 });
    return await this.repositoryLock.run(async () => {
      await this.backend.prepare();
      await this.migrateLegacyDirectMetadata();
      const provisioning = await this.backend.provision(draftId, owner);
      await this.backend.provisionGuidance(provisioning.worktreePath, draftId);
      const entries = (await readdir(this.metadataDirectory)).filter((entry) => entry.endsWith(".json"));
      const existing = entries.includes(`${draftId}.json`) ? await this.readMetadata(draftId) : undefined;
      for (const entry of entries) {
        const candidate = await this.readMetadata(entry.slice(0, -5));
        if (!(await this.backend.ownsWorktree(candidate.worktree_path))) {
          throw new DraftRuntimeError("DRAFT_WORKSPACE_MODE_MISMATCH", `Direct metadata ${candidate.draft_id} does not belong to the direct checkout`);
        }
      }
      const now = new Date().toISOString();
      const metadata: DraftMetadata = {
        version: 1,
        draft_id: draftId,
        owner_gitlab_user_id: owner,
        branch: provisioning.branch,
        base_commit: provisioning.baseCommit,
        worktree_path: provisioning.worktreePath,
        writer_mode: "ui",
        state: "open",
        fingerprint: await this.fingerprint(provisioning.worktreePath),
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      await this.persist(metadata);
      for (const entry of entries) {
        if (entry === `${draftId}.json`) continue;
        await rm(await resolveDomainPath(this.dataDirectory, `${this.metadataRelativeDirectory}/${entry}`));
      }
      return metadata;
    });
  }

  async poll(draftId: string): Promise<{ metadata: DraftMetadata; currentFingerprint: string; changedExternally: boolean }> {
    const metadata = await this.getDraft(draftId);
    const currentFingerprint = await this.fingerprint(metadata.worktree_path);
    return { metadata, currentFingerprint, changedExternally: currentFingerprint !== metadata.fingerprint };
  }

  async setWriterMode(draftId: string, owner: string, mode: WriterMode): Promise<DraftMetadata> {
    return await this.lock(safeComponent(draftId, "draft ID")).run(async () => {
      const metadata = await this.getDraft(draftId);
      this.assertOwnerAndOpen(metadata, owner);
      const next: DraftMetadata = {
        ...metadata,
        writer_mode: mode,
        fingerprint: await this.fingerprint(metadata.worktree_path),
        updated_at: new Date().toISOString(),
      };
      await this.persist(next);
      return next;
    });
  }

  async closeDraft(draftId: string, owner: string): Promise<DraftMetadata> {
    return await this.transitionState(draftId, owner, "closed");
  }

  async reopenDraft(draftId: string, owner: string): Promise<DraftMetadata> {
    return await this.lock(safeComponent(draftId, "draft ID")).run(async () => {
      const metadata = await this.getDraft(draftId);
      if (metadata.owner_gitlab_user_id !== owner) throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Draft owner mismatch");
      if (metadata.state !== "closed") throw new DraftRuntimeError("DRAFT_STATE_INVALID", "Only a closed draft can be reopened");
      const next: DraftMetadata = { ...metadata, state: "open", updated_at: new Date().toISOString() };
      await this.persist(next);
      return next;
    });
  }

  async cleanupDraft(draftId: string, destructiveConfirmation: string): Promise<void> {
    const safeDraftId = safeComponent(draftId, "draft ID");
    if (destructiveConfirmation !== safeDraftId) {
      throw new DraftRuntimeError("CLEANUP_CONFIRMATION_REQUIRED", "Cleanup requires the exact draft ID");
    }
    await this.repositoryLock.run(async () => await this.lock(safeDraftId).run(async () => {
      const metadata = await this.getDraft(safeDraftId);
      if (metadata.state === "open") throw new DraftRuntimeError("DRAFT_STATE_INVALID", "Close or abandon the draft before cleanup");
      const dirty = (await this.git.statusPorcelain(metadata.worktree_path)).trim() !== "";
      await this.backend.remove(metadata.worktree_path, metadata.branch, dirty);
      const metadataPath = await resolveDomainPath(this.dataDirectory, this.metadataRelativePath(safeDraftId));
      await rm(metadataPath);
    }));
  }

  /**
   * Publish a draft through the configured push strategy. In worktree mode this pushes the
   * draft branch to origin; in direct mode it fast-forwards the active branch to origin.
   */
  async push(draftId: string, accessToken: string): Promise<{ branch: string; commit: string }> {
    const metadata = await this.getDraft(draftId);
    return await this.pushStrategy(metadata.worktree_path, metadata.branch, accessToken);
  }

  async withUiMutation<T>(
    draftId: string,
    owner: string,
    expectedFingerprint: string,
    mutation: (metadata: DraftMetadata) => Promise<T>,
  ): Promise<{ result: T; metadata: DraftMetadata }> {
    return await this.lock(safeComponent(draftId, "draft ID")).run(async () => {
      const metadata = await this.getDraft(draftId);
      this.assertOwnerAndOpen(metadata, owner);
      if (metadata.writer_mode !== "ui") throw new DraftRuntimeError("DRAFT_READ_ONLY", "UI is read-only in external writer mode");
      const current = await this.fingerprint(metadata.worktree_path);
      if (current !== metadata.fingerprint || current !== expectedFingerprint) {
        throw new DraftRuntimeError("DRAFT_CHANGED_EXTERNALLY", "Draft worktree changed outside the UI runtime");
      }
      let result: T;
      try {
        result = await mutation(metadata);
      } catch (error) {
        const refreshed: DraftMetadata = {
          ...metadata,
          fingerprint: await this.fingerprint(metadata.worktree_path),
          updated_at: new Date().toISOString(),
        };
        await this.persist(refreshed);
        throw error;
      }
      const next: DraftMetadata = {
        ...metadata,
        fingerprint: await this.fingerprint(metadata.worktree_path),
        updated_at: new Date().toISOString(),
      };
      await this.persist(next);
      return { result, metadata: next };
    });
  }

  async fileBlobId(draftId: string, relativePath: string): Promise<string> {
    return (await this.fileBlobIds(draftId, [relativePath])).get(relativePath)!;
  }

  async fileBlobIds(draftId: string, relativePaths: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const metadata = await this.getDraft(draftId);
    await Promise.all(relativePaths.map(async (relativePath) => await resolveDomainPath(metadata.worktree_path, relativePath)));
    return await this.git.hashFiles(metadata.worktree_path, relativePaths);
  }

  async assertFileBlobId(draftId: string, relativePath: string, expectedBlobId: string): Promise<string> {
    const current = await this.fileBlobId(draftId, relativePath);
    if (current !== expectedBlobId) {
      throw new DraftRuntimeError("FILE_VERSION_MISMATCH", "File content changed after the client revision");
    }
    return current;
  }

  async refreshFingerprint(draftId: string): Promise<DraftMetadata> {
    return await this.lock(safeComponent(draftId, "draft ID")).run(async () => {
      const metadata = await this.getDraft(draftId);
      const next: DraftMetadata = {
        ...metadata,
        fingerprint: await this.fingerprint(metadata.worktree_path),
        updated_at: new Date().toISOString(),
      };
      await this.persist(next);
      return next;
    });
  }

  async acknowledgeExternalChanges(draftId: string, owner: string): Promise<DraftMetadata> {
    return await this.lock(safeComponent(draftId, "draft ID")).run(async () => {
      const metadata = await this.getDraft(draftId);
      this.assertOwnerAndOpen(metadata, owner);
      if (metadata.writer_mode !== "ui") {
        throw new DraftRuntimeError("DRAFT_READ_ONLY", "External changes can be acknowledged only in UI writer mode");
      }
      const next: DraftMetadata = {
        ...metadata,
        fingerprint: await this.fingerprint(metadata.worktree_path),
        updated_at: new Date().toISOString(),
      };
      await this.persist(next);
      return next;
    });
  }

  async markPublished(draftId: string, owner: string, mergeRequestIid: number): Promise<DraftMetadata> {
    if (!Number.isInteger(mergeRequestIid) || mergeRequestIid <= 0) throw new DraftRuntimeError("MR_IID_INVALID", "Merge Request IID is invalid");
    return await this.lock(safeComponent(draftId, "draft ID")).run(async () => {
      const metadata = await this.getDraft(draftId);
      this.assertOwnerAndOpen(metadata, owner);
      const next: DraftMetadata = {
        ...metadata,
        state: "published",
        merge_request_iid: mergeRequestIid,
        updated_at: new Date().toISOString(),
      };
      await this.persist(next);
      return next;
    });
  }

  async recover(): Promise<RecoveryReport> {
    await this.migrateLegacyDirectMetadata();
    await mkdir(this.metadataDirectory, { recursive: true, mode: 0o700 });
    const drafts: DraftMetadata[] = [];
    const missingWorktrees: string[] = [];
    for (const entry of await readdir(this.metadataDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const draftId = entry.slice(0, -5);
      const metadata = await this.readMetadata(draftId);
      try {
        await realpath(metadata.worktree_path);
      } catch {
        missingWorktrees.push(draftId);
        continue;
      }
      if (!(await this.backend.ownsWorktree(metadata.worktree_path))) {
        throw new DraftRuntimeError("DRAFT_WORKSPACE_MODE_MISMATCH", `Draft ${draftId} does not belong to ${this.backend.mode} repository mode`);
      }
      const fingerprintBefore = await this.fingerprint(metadata.worktree_path);
      const guidanceChanged = await this.backend.provisionGuidance(metadata.worktree_path, draftId);
      if (guidanceChanged && fingerprintBefore === metadata.fingerprint) {
        const recovered = { ...metadata, fingerprint: await this.fingerprint(metadata.worktree_path), updated_at: new Date().toISOString() };
        await this.persist(recovered);
        drafts.push(recovered);
      } else {
        drafts.push(metadata);
      }
    }
    const knownPaths = drafts.map((draft) => path.resolve(draft.worktree_path));
    const orphanedWorktrees = [...await this.backend.listOrphanedWorktrees(knownPaths)];
    return {
      drafts: drafts.sort((left, right) => left.draft_id.localeCompare(right.draft_id)),
      orphaned_worktrees: orphanedWorktrees.sort(),
      missing_worktrees: missingWorktrees.sort(),
    };
  }

  private assertOwnerAndOpen(metadata: DraftMetadata, owner: string): void {
    if (metadata.owner_gitlab_user_id !== owner) throw new DraftRuntimeError("DRAFT_FORBIDDEN", "Draft owner mismatch");
    if (metadata.state !== "open") throw new DraftRuntimeError("DRAFT_NOT_OPEN", "Draft is not open");
  }

  private async transitionState(draftId: string, owner: string, state: DraftState): Promise<DraftMetadata> {
    return await this.lock(safeComponent(draftId, "draft ID")).run(async () => {
      const metadata = await this.getDraft(draftId);
      this.assertOwnerAndOpen(metadata, owner);
      const next: DraftMetadata = { ...metadata, state, updated_at: new Date().toISOString() };
      await this.persist(next);
      return next;
    });
  }
}
