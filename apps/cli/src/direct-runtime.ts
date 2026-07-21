import { GitClient, GitCommandError } from "@gitpm/git-client";
import { DirectDraftBackend, directPushStrategy, GITPM_GUIDANCE_PATHS } from "@gitpm/drafts";
import { validateRepository } from "@gitpm/validation";

export interface DirectStatus {
  readonly mode: "direct";
  readonly path: string;
  readonly branch: string;
  readonly head: string;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly remote?: string;
}

export interface DirectCommitResult {
  readonly commit: string;
  readonly branch: string;
}

export interface DirectPushResult {
  readonly branch: string;
  readonly commit: string;
}

export interface DirectCliRuntimeOptions {
  readonly dataDirectory: string;
  readonly remoteUrl: string;
  readonly defaultBranch: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly allowLocalRepository?: boolean;
  readonly askPassPath?: string;
  readonly pushAccessToken?: string;
}

export class DirectCliRuntime {
  private readonly git: GitClient;
  private readonly backend: DirectDraftBackend;
  private readonly pushStrategy: ReturnType<typeof directPushStrategy>;
  private readonly authorName: string;
  private readonly authorEmail: string;
  private readonly pushAccessToken?: string;
  private prepared = false;

  constructor(options: DirectCliRuntimeOptions) {
    this.git = new GitClient({
      dataDirectory: options.dataDirectory,
      remoteUrl: options.remoteUrl,
      defaultBranch: options.defaultBranch,
      ...(options.allowLocalRepository ? { allowLocalRepository: true } : {}),
      ...(options.askPassPath === undefined ? {} : { askPassPath: options.askPassPath }),
    });
    this.backend = new DirectDraftBackend(this.git, options.dataDirectory);
    this.pushStrategy = directPushStrategy(this.git);
    this.authorName = options.authorName;
    this.authorEmail = options.authorEmail;
    this.pushAccessToken = options.pushAccessToken;
  }

  get checkoutPath(): string {
    return this.backend.checkoutPath;
  }

  async prepare(): Promise<void> {
    if (this.prepared) return;
    await this.backend.prepare();
    this.prepared = true;
  }

  async status(): Promise<DirectStatus> {
    await this.prepare();
    const checkout = await this.git.checkoutRealPath(this.checkoutPath);
    const branch = await this.git.checkoutCurrentBranch(checkout);
    const head = await this.git.headCommit(checkout);
    const porcelain = await this.git.statusPorcelain(checkout, GITPM_GUIDANCE_PATHS);
    const dirty = porcelain.trim() !== "";
    const { ahead, behind } = await this.git.checkoutAheadBehind(checkout);
    let remote: string | undefined;
    try {
      remote = await this.git.checkoutOriginUrl(checkout);
    } catch {
      remote = undefined;
    }
    return {
      mode: "direct",
      path: checkout,
      branch,
      head,
      dirty,
      ahead,
      behind,
      ...(remote === undefined ? {} : { remote }),
    };
  }

  async commitAll(message: string): Promise<DirectCommitResult> {
    await this.prepare();
    const checkout = await this.git.checkoutRealPath(this.checkoutPath);
    const validation = await validateRepository(checkout);
    if (!validation.valid) {
      const error = new Error("Commit is blocked by repository validation") as Error & { code: string; details?: unknown };
      error.code = "VALIDATION_FAILED";
      error.details = validation.errors;
      throw error;
    }
    const porcelain = await this.git.statusPorcelain(checkout, GITPM_GUIDANCE_PATHS);
    if (porcelain.trim() === "") {
      const error = new Error("Working copy has no changes") as Error & { code: string };
      error.code = "NOTHING_TO_COMMIT";
      throw error;
    }
    const commit = await this.git.commitAll(checkout, message, this.authorName, this.authorEmail, GITPM_GUIDANCE_PATHS);
    const branch = await this.git.checkoutCurrentBranch(checkout);
    return { commit, branch };
  }

  async push(): Promise<DirectPushResult> {
    await this.prepare();
    const checkout = await this.git.checkoutRealPath(this.checkoutPath);
    const porcelain = await this.git.statusPorcelain(checkout, GITPM_GUIDANCE_PATHS);
    if (porcelain.trim() !== "") {
      const error = new Error("Push requires a clean committed working copy") as Error & { code: string };
      error.code = "UNCOMMITTED_CHANGES";
      throw error;
    }
    if (this.pushAccessToken === undefined) {
      const error = new Error("Push requires a configured remote and access token") as Error & { code: string };
      error.code = "GIT_PUSH_REMOTE_MISSING";
      throw error;
    }
    return await this.pushStrategy(checkout, await this.git.checkoutCurrentBranch(checkout), this.pushAccessToken);
  }

  isGitError(error: unknown): error is GitCommandError {
    return error instanceof GitCommandError;
  }
}
